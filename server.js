'use strict';
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { Pool } = require('pg');
const { Table, START_CHIPS } = require('./poker');

const BOT_TOKEN = process.env.BOT_TOKEN; // from @BotFather
const DATABASE_URL = process.env.DATABASE_URL; // from the Railway Postgres service
const PORT = process.env.PORT || 8080;
const NEXT_HAND_DELAY_MS = 6000;
const TURN_MS = 25000; // time each player has to act
const MIN_REFILL = 20; // play-money rule: below one big blind you are topped up

// ---------- Persistent chips ----------
// Chips are written to the database only when a hand finishes, in one
// transaction, so a crash mid-hand never leaves half-applied balances.
const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: process.env.DB_SSL ? { rejectUnauthorized: false } : false })
  : null;
const memChips = new Map(); // fallback when no database is configured (dev only)

async function initDb() {
  if (!pool) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    chips INTEGER NOT NULL CHECK (chips >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
}

async function loadChips(id, name) {
  let chips;
  if (pool) {
    const r = await pool.query(
      `INSERT INTO players (id, name, chips) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
       RETURNING chips`,
      [id, name, START_CHIPS]
    );
    chips = r.rows[0].chips;
  } else {
    chips = memChips.has(id) ? memChips.get(id) : START_CHIPS;
  }
  return chips < MIN_REFILL ? START_CHIPS : chips;
}

async function saveChips(players) {
  if (!pool) {
    for (const p of players) memChips.set(p.id, p.chips);
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const p of players) {
      await client.query('UPDATE players SET chips = $2, updated_at = now() WHERE id = $1', [p.id, p.chips]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('saveChips failed:', e.message);
  } finally {
    client.release();
  }
}

// ---------- Telegram auth ----------
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
  return { id: String(user.id), name: String(user.first_name || 'Player').slice(0, 20) };
}

function authenticate(msg) {
  if (BOT_TOKEN) return verifyInitData(String(msg.initData || ''));
  // Dev mode (no BOT_TOKEN): trust the client. Never deploy like this.
  return { id: String(msg.userId || crypto.randomUUID()), name: String(msg.name || 'Player').slice(0, 20) };
}

// ---------- Rooms ----------
const rooms = new Map(); // roomId -> { table, clients: Map(userId -> ws), timer }
const active = new Map(); // userId -> roomId (one table per player at a time)

// Turn timer: when it runs out, the player is folded (or checks if free).
function syncTurnTimer(room) {
  const t = room.table;
  if (room.turnSeq === t.turnSeq) return;
  room.turnSeq = t.turnSeq;
  clearTimeout(room.turnTimer);
  room.deadline = 0;
  const p = t.players[t.current];
  if (!p || t.stage === 'waiting' || t.stage === 'showdown') return;
  room.deadline = Date.now() + TURN_MS;
  room.turnTimer = setTimeout(() => {
    try {
      t.act(p.id, t.currentBet > p.bet ? 'fold' : 'check');
    } catch (e) {
      console.error('auto-action failed:', e.message);
    }
    broadcast(room);
  }, TURN_MS);
}

function broadcast(room) {
  syncTurnTimer(room);
  const remaining = room.deadline ? Math.max(0, room.deadline - Date.now()) : 0;
  for (const [uid, ws] of room.clients) {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'state', state: { ...room.table.viewFor(uid), turnMs: TURN_MS, remaining } }));
    }
  }
  // Hand finished: save balances once, then start the next hand automatically.
  if (room.table.stage === 'showdown' && !room.timer) {
    saveChips(room.table.players);
    room.timer = setTimeout(() => {
      room.timer = null;
      room.table.startHand();
      broadcast(room);
    }, NEXT_HAND_DELAY_MS);
  }
}

// ---------- HTTP + WebSocket ----------
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
  let joining = false;
  let lastEmote = 0;
  const send = (obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (msg.type === 'join') {
        if (ctx || joining) throw new Error('Already joined');
        const user = authenticate(msg);
        const roomId = String(msg.room || 'lobby').slice(0, 32);
        if (active.has(user.id) && active.get(user.id) !== roomId) throw new Error('You are already at another table');
        joining = true;
        const chips = await loadChips(user.id, user.name);
        if (ws.readyState !== 1) return;
        if (!rooms.has(roomId)) rooms.set(roomId, { table: new Table(roomId), clients: new Map(), timer: null });
        const room = rooms.get(roomId);
        room.table.addPlayer(user.id, user.name, chips);
        room.clients.set(user.id, ws);
        active.set(user.id, roomId);
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
      } else if (msg.type === 'emote') {
        const e = String(msg.emoji);
        if (!['👍', '😂', '😮', '🔥', '😎', '🤝'].includes(e) || Date.now() - lastEmote < 1500) return;
        lastEmote = Date.now();
        for (const c of room.clients.values()) c.readyState === 1 && c.send(JSON.stringify({ type: 'emote', id: userId, emoji: e }));
        return;
      }
      broadcast(room);
    } catch (e) {
      joining = false;
      send({ type: 'error', message: e.message });
    }
  });

  ws.on('close', () => {
    if (!ctx) return;
    const { room, roomId, userId } = ctx;
    if (room.clients.get(userId) === ws) {
      room.clients.delete(userId);
      active.delete(userId);
      room.table.removePlayer(userId);
    }
    if (room.clients.size === 0) {
      clearTimeout(room.timer);
      clearTimeout(room.turnTimer);
      rooms.delete(roomId);
    } else {
      broadcast(room);
    }
  });
});

initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Poker server on :${PORT} | ${pool ? 'database: on' : 'database: OFF (chips reset on restart)'}${BOT_TOKEN ? '' : ' | DEV MODE: no auth'}`);
    });
  })
  .catch((e) => {
    console.error('Database init failed:', e.message);
    process.exit(1);
  });
