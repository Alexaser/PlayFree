// Сервер игры "Крестики-нолики" с комнатами и полем от 3×3 до 10×10.
// Запуск: node server.js  — затем откройте адрес, который он напечатает.

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = Number(process.env.PORT) || 3000;
const MIN_SIZE = 3;
const MAX_SIZE = 10;
const ROOM_TTL = 10 * 60 * 1000; // пустая комната удаляется через 10 минут
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

const rooms = new Map(); // код -> комната

// Сколько знаков подряд нужно для победы на поле данного размера
function needToWin(size) {
  if (size <= 4) return size;
  if (size === 5) return 4;
  return 5;
}

// Адреса, по которым другой игрок может открыть игру
function shareAddresses() {
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

function newCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  } while (rooms.has(code));
  return code;
}

function createRoom(size) {
  const room = {
    code: newCode(),
    size,
    need: needToWin(size),
    board: Array(size * size).fill(null),
    turn: 'X',
    starter: 'X',
    winner: null, // 'X' | 'O' | 'draw' | null
    line: null,
    score: { X: 0, O: 0, draw: 0 },
    players: { X: null, O: null }, // id клиента, занявшего роль
    clients: new Map(), // id -> Set(ответов SSE)
    leaveTimers: new Map(),
    deleteTimer: null,
  };
  rooms.set(room.code, room);
  scheduleDelete(room);
  return room;
}

function scheduleDelete(room) {
  clearTimeout(room.deleteTimer);
  room.deleteTimer = setTimeout(() => {
    if (room.clients.size === 0) rooms.delete(room.code);
  }, ROOM_TTL);
}

function roleOf(room, id) {
  if (room.players.X === id) return 'X';
  if (room.players.O === id) return 'O';
  return null;
}

function send(room, res, id) {
  const data = {
    code: room.code,
    size: room.size,
    need: room.need,
    board: room.board,
    turn: room.turn,
    winner: room.winner,
    line: room.line,
    score: room.score,
    you: roleOf(room, id),
    online: { X: !!room.players.X, O: !!room.players.O },
    share: shareAddresses(),
  };
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(room) {
  for (const [id, set] of room.clients) for (const res of set) send(room, res, id);
}

// Проверяем линии через последний ход: так быстро даже на поле 10×10
function checkWinner(room, cell) {
  const { size, need, board } = room;
  const mark = board[cell];
  const r0 = Math.floor(cell / size);
  const c0 = cell % size;
  for (const [dr, dc] of DIRS) {
    const line = [cell];
    for (const sign of [1, -1]) {
      let r = r0 + dr * sign;
      let c = c0 + dc * sign;
      while (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === mark) {
        line.push(r * size + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (line.length >= need) return { winner: mark, line };
  }
  if (board.every(Boolean)) return { winner: 'draw', line: null };
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

function getRoom(code) {
  return rooms.get(String(code || '').toUpperCase());
}

function handleEvents(req, res, room, id) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  clearTimeout(room.leaveTimers.get(id));
  room.leaveTimers.delete(id);
  clearTimeout(room.deleteTimer);
  if (!room.clients.has(id)) room.clients.set(id, new Set());
  room.clients.get(id).add(res);

  // Первый пришедший играет за X, второй за O, остальные смотрят
  if (!roleOf(room, id)) {
    if (!room.players.X) room.players.X = id;
    else if (!room.players.O) room.players.O = id;
  }
  broadcast(room);

  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    const set = room.clients.get(id);
    set.delete(res);
    if (set.size > 0) return;
    room.clients.delete(id);
    // Даём несколько секунд на переподключение (например, обновление страницы)
    room.leaveTimers.set(id, setTimeout(() => {
      room.leaveTimers.delete(id);
      if (room.clients.has(id)) return;
      const role = roleOf(room, id);
      if (role) room.players[role] = null;
      broadcast(room);
      if (room.clients.size === 0) scheduleDelete(room);
    }, 5000));
  });
}

function listRooms(res) {
  const list = [...rooms.values()]
    .filter((r) => !r.players.X || !r.players.O)
    .map((r) => ({ code: r.code, size: r.size, need: r.need, players: +!!r.players.X + +!!r.players.O }));
  json(res, 200, { rooms: list, share: shareAddresses() });
}

async function handleCreate(req, res) {
  const { size } = await readJson(req);
  if (!Number.isInteger(size) || size < MIN_SIZE || size > MAX_SIZE) {
    return json(res, 400, { error: `Размер поля от ${MIN_SIZE} до ${MAX_SIZE}` });
  }
  json(res, 200, { code: createRoom(size).code });
}

async function handleMove(req, res) {
  const { room: code, id, cell } = await readJson(req);
  const room = getRoom(code);
  if (!room) return json(res, 404, { error: 'Комната не найдена' });
  const role = roleOf(room, id);
  if (!role) return json(res, 403, { error: 'Вы зритель' });
  if (!room.players.X || !room.players.O) return json(res, 409, { error: 'Ждём второго игрока' });
  if (room.winner) return json(res, 409, { error: 'Игра окончена' });
  if (role !== room.turn) return json(res, 409, { error: 'Сейчас не ваш ход' });
  if (!Number.isInteger(cell) || cell < 0 || cell >= room.board.length || room.board[cell]) {
    return json(res, 400, { error: 'Клетка занята' });
  }

  room.board[cell] = role;
  const result = checkWinner(room, cell);
  if (result) {
    room.winner = result.winner;
    room.line = result.line;
    room.score[result.winner]++;
  } else {
    room.turn = role === 'X' ? 'O' : 'X';
  }
  broadcast(room);
  json(res, 200, { ok: true });
}

async function handleReset(req, res) {
  const { room: code, id } = await readJson(req);
  const room = getRoom(code);
  if (!room) return json(res, 404, { error: 'Комната не найдена' });
  if (!roleOf(room, id)) return json(res, 403, { error: 'Вы зритель' });
  // Следующую партию начинает другой игрок
  room.starter = room.starter === 'X' ? 'O' : 'X';
  room.board = Array(room.size * room.size).fill(null);
  room.turn = room.starter;
  room.winner = null;
  room.line = null;
  broadcast(room);
  json(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/rooms') return listRooms(res);
  if (req.method === 'POST' && url.pathname === '/rooms') return handleCreate(req, res);
  if (req.method === 'GET' && url.pathname === '/events') {
    const room = getRoom(url.searchParams.get('room'));
    const id = url.searchParams.get('id');
    if (!room) return json(res, 404, { error: 'Комната не найдена' });
    if (!id) return json(res, 400, { error: 'Нет id' });
    return handleEvents(req, res, room, id);
  }
  if (req.method === 'POST' && url.pathname === '/move') return handleMove(req, res);
  if (req.method === 'POST' && url.pathname === '/reset') return handleReset(req, res);

  json(res, 404, { error: 'Не найдено' });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Крестики-нолики запущены!');
  console.log(`На этом компьютере:  http://localhost:${PORT}`);
  for (const addr of shareAddresses()) console.log(`На другом компьютере: ${addr}`);
  console.log('Чтобы остановить сервер, нажмите Ctrl+C.');
});
