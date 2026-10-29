// Сервер игры "Крестики-нолики" для двух компьютеров в одной сети.
// Запуск: node server.js  — затем откройте адрес, который он напечатает.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const game = {
  board: Array(9).fill(null),
  turn: 'X',
  starter: 'X',
  winner: null, // 'X' | 'O' | 'draw' | null
  line: null,
  score: { X: 0, O: 0, draw: 0 },
};
const players = { X: null, O: null }; // id клиента, занявшего роль
const clients = new Map(); // id -> Set(ответов SSE)
const leaveTimers = new Map();

// Адреса компьютера в локальной сети, чтобы второй игрок знал, куда заходить
function lanAddresses() {
  // На Render показываем публичную ссылку сайта
  if (process.env.RENDER_EXTERNAL_URL) return [process.env.RENDER_EXTERNAL_URL];
  const result = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) result.push(`http://${net.address}:${PORT}`);
    }
  }
  return result;
}

function roleOf(id) {
  if (players.X === id) return 'X';
  if (players.O === id) return 'O';
  return null;
}

function send(res, id) {
  const data = {
    ...game,
    you: roleOf(id),
    online: { X: !!players.X, O: !!players.O },
    share: lanAddresses(),
  };
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast() {
  for (const [id, set] of clients) for (const res of set) send(res, id);
}

function checkWinner() {
  for (const line of LINES) {
    const [a, b, c] = line;
    const v = game.board[a];
    if (v && v === game.board[b] && v === game.board[c]) return { winner: v, line };
  }
  if (game.board.every(Boolean)) return { winner: 'draw', line: null };
  return null;
}

function readJson(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1e4) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); }
    });
  });
}

function json(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function handleEvents(req, res, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  clearTimeout(leaveTimers.get(id));
  leaveTimers.delete(id);
  if (!clients.has(id)) clients.set(id, new Set());
  clients.get(id).add(res);

  // Первый пришедший играет за X, второй за O, остальные смотрят
  if (!roleOf(id)) {
    if (!players.X) players.X = id;
    else if (!players.O) players.O = id;
  }
  broadcast();

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    const set = clients.get(id);
    set.delete(res);
    if (set.size > 0) return;
    clients.delete(id);
    // Даём несколько секунд на переподключение (например, обновление страницы)
    leaveTimers.set(id, setTimeout(() => {
      leaveTimers.delete(id);
      if (clients.has(id)) return;
      const role = roleOf(id);
      if (role) players[role] = null;
      broadcast();
    }, 5000));
  });
}

async function handleMove(req, res) {
  const { id, cell } = await readJson(req);
  const role = roleOf(id);
  if (!role) return json(res, 403, { error: 'Вы зритель' });
  if (!players.X || !players.O) return json(res, 409, { error: 'Ждём второго игрока' });
  if (game.winner) return json(res, 409, { error: 'Игра окончена' });
  if (role !== game.turn) return json(res, 409, { error: 'Сейчас не ваш ход' });
  if (!Number.isInteger(cell) || cell < 0 || cell > 8 || game.board[cell]) {
    return json(res, 400, { error: 'Клетка занята' });
  }

  game.board[cell] = role;
  const result = checkWinner();
  if (result) {
    game.winner = result.winner;
    game.line = result.line;
    game.score[result.winner]++;
  } else {
    game.turn = role === 'X' ? 'O' : 'X';
  }
  broadcast();
  json(res, 200, { ok: true });
}

async function handleReset(req, res) {
  const { id } = await readJson(req);
  if (!roleOf(id)) return json(res, 403, { error: 'Вы зритель' });
  // Следующую партию начинает другой игрок
  game.starter = game.starter === 'X' ? 'O' : 'X';
  game.board = Array(9).fill(null);
  game.turn = game.starter;
  game.winner = null;
  game.line = null;
  broadcast();
  json(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/events') {
    const id = url.searchParams.get('id');
    if (!id) return json(res, 400, { error: 'Нет id' });
    return handleEvents(req, res, id);
  }
  if (req.method === 'POST' && url.pathname === '/move') return handleMove(req, res);
  if (req.method === 'POST' && url.pathname === '/reset') return handleReset(req, res);

  json(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Крестики-нолики запущены!');
  console.log(`На этом компьютере:  http://localhost:${PORT}`);
  for (const addr of lanAddresses()) console.log(`На другом компьютере: ${addr}`);
  console.log('Чтобы остановить сервер, нажмите Ctrl+C.');
});
