import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const WORDS = [
  'elephant', 'rocket', 'pizza', 'rainbow', 'castle', 'guitar', 'penguin', 'volcano',
  'unicorn', 'hamburger', 'robot', 'spaceship', 'dragon', 'ice cream', 'bicycle',
  'sunflower', 'pirate', 'dinosaur', 'trophy', 'campfire', 'lighthouse', 'submarine',
  'treasure', 'snowman', 'parachute', 'watermelon', 'cactus', 'mermaid', 'tornado', 'wizard'
];
const rooms = new Map();
const clients = new Map(); // clientId -> {res, roomCode, playerId}
const playerConnections = new Map(); // playerId -> clientIds[]

const json = (res, code, data) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function id(prefix = '') { return prefix + crypto.randomBytes(7).toString('hex'); }

function cleanName(name) {
  const n = String(name || '').trim().replace(/\s+/g, ' ');
  return n.slice(0, 20) || 'Player';
}

function roomFor(code) { return rooms.get(String(code || '').toUpperCase()); }

function currentState(room, viewerId = null) {
  const playerList = room.players.map(p => ({
    id: p.id,
    name: p.name,
    score: p.score,
    connected: p.connected,
    isHost: p.id === room.hostId,
    hasGuessed: room.correctGuesses.has(p.id)
  }));
  return {
    roomCode: room.code,
    hostId: room.hostId,
    gameStatus: room.status,
    players: playerList,
    round: room.round,
    totalRounds: room.totalRounds,
    drawerId: room.drawerId,
    secretWord: room.status === 'playing' && room.drawerId === viewerId ? room.word : null,
    timeLeftMs: Math.max(0, (room.roundEndsAt || 0) - Date.now()),
    strokes: room.strokes,
    guesses: room.guesses.slice(-20),
    leaderboard: [...room.players].sort((a,b) => b.score - a.score).map(p => ({ id: p.id, name: p.name, score: p.score })),
    winner: room.winner || null,
    message: room.message || null
  };
}

function broadcast(room) {
  for (const client of clients.values()) {
    if (client.roomCode === room.code) {
      const payload = `event: state\ndata: ${JSON.stringify(currentState(room, client.playerId))}\n\n`;
      try { client.res.write(payload); } catch { /* connection cleanup handled elsewhere */ }
    }
  }
}

function ensureRoom(room) {
  if (!room.timer) return;
  clearTimeout(room.timer);
  room.timer = null;
}

function chooseWord() {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

function roundComplete(room) {
  return room.players.length >= 2 && room.correctGuesses.size >= room.players.length - 1;
}

function finishRound(room, reason = 'complete') {
  if (room.status !== 'playing') return;
  ensureRoom(room);
  room.status = 'round_end';
  room.message = reason === 'timeout' ? `Time's up — the word was “${room.word}”.` : `Round complete — the word was “${room.word}”.`;
  broadcast(room);
  setTimeout(() => {
    if (!rooms.has(room.code)) return;
    if (room.round >= room.totalRounds) {
      room.status = 'finished';
      room.winner = [...room.players].sort((a,b) => b.score - a.score)[0] || null;
      room.message = 'Game over!';
      broadcast(room);
      return;
    }
    startRound(room);
  }, 2200);
}

function startRound(room) {
  ensureRoom(room);
  room.status = 'playing';
  room.round += 1;
  room.drawerIndex = (room.drawerIndex + 1) % room.players.length;
  room.drawerId = room.players[room.drawerIndex].id;
  room.word = chooseWord();
  room.strokes = [];
  room.guesses = [];
  room.correctGuesses = new Set();
  room.drawerAwarded = false;
  room.roundEndsAt = Date.now() + room.roundDurationMs;
  room.message = `Round ${room.round}: ${room.players[room.drawerIndex].name} is drawing.`;
  room.timer = setTimeout(() => finishRound(room, 'timeout'), room.roundDurationMs + 50);
  broadcast(room);
}

function addPlayer(room, name, requestedId) {
  const existing = requestedId && room.players.find(p => p.id === requestedId);
  if (existing) {
    existing.name = cleanName(name || existing.name);
    existing.connected = true;
    return existing;
  }
  if (room.status !== 'lobby') return null;
  if (room.players.length >= 8) return null;
  const player = { id: id('p_'), name: cleanName(name), score: 0, connected: true };
  room.players.push(player);
  return player;
}

function markDisconnected(playerId) {
  const refs = playerConnections.get(playerId) || [];
  if (refs.length > 0) return;
  for (const room of rooms.values()) {
    const p = room.players.find(p => p.id === playerId);
    if (p) { p.connected = false; broadcast(room); }
  }
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => {
      body += c;
      if (body.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function serveFile(req, res) {
  const requested = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const safePath = path.normalize(path.join(publicDir, requested));
  if (!safePath.startsWith(publicDir)) return json(res, 403, { error: 'Forbidden' });
  fs.stat(safePath, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'Not found' });
    const ext = path.extname(safePath);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(safePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, rooms: rooms.size });

    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const body = await parseBody(req);
      const playerId = id('p_');
      const room = {
        code: makeCode(),
        hostId: null,
        status: 'lobby',
        players: [],
        round: 0,
        totalRounds: 5,
        roundDurationMs: 60000,
        drawerIndex: -1,
        drawerId: null,
        word: null,
        strokes: [],
        guesses: [],
        correctGuesses: new Set(),
        timer: null,
        roundEndsAt: 0,
        message: 'Waiting for players…',
        winner: null,
        drawerAwarded: false
      };
      const player = addPlayer(room, body.name, null);
      room.hostId = player.id;
      rooms.set(room.code, room);
      return json(res, 201, { roomCode: room.code, playerId: player.id, state: currentState(room, player.id) });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const body = await parseBody(req);
      const room = roomFor(body.roomCode);
      if (!room) return json(res, 404, { error: 'Room not found' });
      const player = addPlayer(room, body.name, body.playerId);
      if (!player) return json(res, 409, { error: room.status !== 'lobby' ? 'Game already started' : 'Room is full' });
      broadcast(room);
      return json(res, 200, { roomCode: room.code, playerId: player.id, state: currentState(room) });
    }

    if (req.method === 'GET' && url.pathname === '/api/stream') {
      const code = (url.searchParams.get('roomCode') || '').toUpperCase();
      const playerId = url.searchParams.get('playerId');
      const room = roomFor(code);
      if (!room || !playerId || !room.players.some(p => p.id === playerId)) return json(res, 404, { error: 'Room/player not found' });
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`event: state\ndata: ${JSON.stringify(currentState(room, playerId))}\n\n`);
      const clientId = id('c_');
      clients.set(clientId, { res, roomCode: code, playerId });
      const list = playerConnections.get(playerId) || [];
      list.push(clientId); playerConnections.set(playerId, list);
      const p = room.players.find(p => p.id === playerId); if (p) p.connected = true;
      broadcast(room);
      req.on('close', () => {
        clients.delete(clientId);
        const now = (playerConnections.get(playerId) || []).filter(x => x !== clientId);
        if (now.length) playerConnections.set(playerId, now); else playerConnections.delete(playerId);
        markDisconnected(playerId);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/rooms/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const code = (parts[2] || '').toUpperCase();
      const action = parts[3];
      const room = roomFor(code);
      if (!room) return json(res, 404, { error: 'Room not found' });
      const body = await parseBody(req);
      const player = room.players.find(p => p.id === body.playerId);
      if (!player) return json(res, 403, { error: 'Player not in room' });

      if(action === 'start') {
        if(player.id != room.hostId) {
          return json(res, 403, {
            error: 'Only the host can start the game'
          });
        }

        if(room.players.length < 2) {
          return json(res, 400, {
            error: 'Need at least 2 players to start'
          });
        }

        if(room.status !== 'lobby' && room.status !== 'finished') {
          return json(res, 400, {
            errror: 'Game already active'
          });
        }

        room.players.forEach(p => {
          p.score = 0;
          p.connected = true;
        });

        room.drawerIndex = -1;
        room.round = 0;
        room.winner = null;

        startRound(room);

        return json(res, 200, { ok: true });
      }

      if (action === 'undo') {
        if (room.status !== 'playing' || room.drawerId !== player.id) return json(res, 409, { error: 'Only the current drawer can undo' });
        room.strokes.pop();
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (action === 'stroke') {
        if (room.status !== 'playing' || room.drawerId !== player.id) return json(res, 409, { error: 'Only the current drawer can draw' });
        const s = body.stroke;
        if (!s || !Array.isArray(s.points) || s.points.length < 1 || s.points.length > 1000) return json(res, 400, { error: 'Invalid stroke' });
        room.strokes.push({ points: s.points.map(pt => [Math.min(1, Math.max(0, Number(pt[0]))), Math.min(1, Math.max(0, Number(pt[1]))) ]), size: Math.max(1, Math.min(100, Number(s.size) || 4)), erase: !!s.erase, color: String(s.color || '#092829').slice(0, 7), brush: String(s.brush || 'normal').slice(0, 10) });
        if (room.strokes.length > 5000) room.strokes.splice(0, room.strokes.length - 5000);
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (action === 'clear') {
        if (room.status !== 'playing' || room.drawerId !== player.id) return json(res, 409, { error: 'Only the current drawer can clear' });
        room.strokes = [];
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      if (action === 'guess') {
        if (room.status !== 'playing') return json(res, 409, { error: 'Round is not active' });
        if (player.id === room.drawerId) return json(res, 400, { error: 'Drawer cannot guess' });
        if (room.correctGuesses.has(player.id)) return json(res, 400, { error: 'Already guessed correctly' });
        const guess = String(body.guess || '').trim().slice(0, 80);
        if (!guess) return json(res, 400, { error: 'Enter a guess' });
        const normalized = guess.toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
        const target = room.word.toLowerCase();
        const accepted = normalized === target || normalized.replace(/ /g, '') === target.replace(/ /g, '');
        room.guesses.push({ playerId: player.id, playerName: player.name, guess, correct: accepted, at: Date.now() });
        if (accepted) {
          room.correctGuesses.add(player.id);
          const remaining = Math.max(0, (room.roundEndsAt - Date.now()) / room.roundDurationMs);
          const bonus = Math.round(50 * remaining);
          player.score += 100 + bonus;
          if (!room.drawerAwarded) {
            const drawer = room.players.find(p => p.id === room.drawerId);
            if (drawer) drawer.score += 100;
            room.drawerAwarded = true;
          }
        }
        broadcast(room);
        if (accepted && roundComplete(room)) finishRound(room, 'complete');
        return json(res, 200, { ok: true, correct: accepted });
      }

      if (action === 'play-again') {
        if (room.status !== 'finished') return json(res, 400, { error: 'Game not finished' });
        room.status = 'lobby';
        room.round = 0;
        room.players.forEach(p => p.score = 0);
        room.message = 'New game ready — waiting to start.';
        broadcast(room);
        return json(res, 200, { ok: true });
      }

      return json(res, 404, { error: 'Unknown action' });
    }

    if (req.method === 'GET') return serveFile(req, res);
    json(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, 500, { error: 'Server error' });
    else res.end();
  }
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.status === 'playing') broadcast(room);
  }
}, 1000);

function listenWithFallback(port) {
  const onError = (err) => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) {
      console.warn(`Port ${port} is already in use; trying ${port + 1}...`);
      server.off('error', onError);
      listenWithFallback(port + 1);
      return;
    }
    console.error(err);
    process.exit(1);
  };
  server.once('error', onError);
  server.listen(port, HOST, () => {
    console.log(`Sketch & Guess listening on http://localhost:${port}`);
    console.log(`LAN access: http://<this-computer-ip>:${port}`);
  });
}

listenWithFallback(PORT);
