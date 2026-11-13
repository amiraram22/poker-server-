'use strict';
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Table } = require('./poker');

const BOT_TOKEN = process.env.BOT_TOKEN; // from @BotFather
const PORT = process.env.PORT || 8080;
const NEXT_HAND_DELAY_MS = 6000;

const rooms = new Map(); // roomId -> { table, clients: Map(userId -> ws), timer }

// Verifies Telegram Mini App initData (HMAC) and returns the user, or throws.
function verifyInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc !== hash) throw new Error('Invalid initData');
  const age = Date.now() / 1000 - Number(params.get('auth_date'));
  if (!(age < 86400)) throw new Error('initData expired');
  const user = JSON.parse(params.get('user'));
  return { id: String(user.id), name: user.first_name || 'Player' };
}

function authenticate(msg) {
  if (BOT_TOKEN) return verifyInitData(String(msg.initData || ''));
  // Dev mode (no BOT_TOKEN): trust the client. Never deploy like this.
  return { id: String(msg.userId || crypto.randomUUID()), name: String(msg.name || 'Player').slice(0, 20) };
}

function broadcast(room) {
  for (const [uid, ws] of room.clients) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'state', state: room.table.viewFor(uid) }));
  }
  // After a hand ends, start the next one automatically.
  if (room.table.stage === 'showdown' && !room.timer) {
    room.timer = setTimeout(() => {
      room.timer = null;
      room.table.startHand();
      broadcast(room);
    }, NEXT_HAND_DELAY_MS);
  }
}

// One server for both: serves the Mini App page over HTTP and the game over WebSocket.
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
  }
  res.writeHead(url === '/health' ? 200 : 404).end(url === '/health' ? 'ok' : 'Not found');
});
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let ctx = null; // { room, roomId, userId }
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.type === 'join') {
        if (ctx) throw new Error('Already joined');
        const user = authenticate(msg);
        const roomId = String(msg.room || 'lobby').slice(0, 32);
        if (!rooms.has(roomId)) rooms.set(roomId, { table: new Table(roomId), clients: new Map(), timer: null });
        const room = rooms.get(roomId);
        room.table.addPlayer(user.id, user.name);
        room.clients.set(user.id, ws);
        ctx = { room, roomId, userId: user.id };
        return broadcast(room);
      }
      if (!ctx) throw new Error('Join a room first');
      const { room, userId } = ctx;

      if (msg.type === 'start') {
        if (room.table.stage !== 'waiting') throw new Error('Hand already in progress');
        if (!room.table.startHand()) throw new Error('Need at least 2 players');
      } else if (msg.type === 'action') {
        room.table.act(userId, msg.action, msg.amount);
      }
      broadcast(room);
    } catch (e) {
      send({ type: 'error', message: e.message });
    }
  });

  ws.on('close', () => {
    if (!ctx) return;
    const { room, roomId, userId } = ctx;
    if (room.clients.get(userId) === ws) {
      room.clients.delete(userId);
      room.table.removePlayer(userId);
    }
    if (room.clients.size === 0) {
      clearTimeout(room.timer);
      rooms.delete(roomId);
    } else {
      broadcast(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Poker server listening on :${PORT}${BOT_TOKEN ? '' : ' (DEV MODE: no auth)'}`);
});
