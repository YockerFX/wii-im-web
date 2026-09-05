// Signaling-Server: In-Memory-Raeume, 1 Console + 4 Controller, SDP/ICE-Routing, TURN-Credentials.
// Plan: plans/server-setup/03-signaling-server.md
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';

const num = (k, d) => Number(process.env[k] ?? d);
const LIM = {
  maxConnections: num('MAX_CONNECTIONS', 5000),
  maxConnPerIp: num('MAX_CONN_PER_IP', 100),
  maxRooms: num('MAX_ROOMS', 2000),
  createPerIp: num('CREATE_PER_IP_PER_MIN', 10),
  failedJoinsPerIp: num('FAILED_JOINS_PER_IP_PER_MIN', 15),
  failedJoinsGlobal: num('FAILED_JOINS_GLOBAL_PER_MIN', 300),
};
const HOST_AWAY_MS = num('HOST_AWAY_MS', 60_000);
const SLOT_RESERVED_MS = num('SLOT_RESERVED_MS', 120_000);
const ROOM_MAX_MS = num('ROOM_MAX_MS', 12 * 3600_000);
const PORT = num('PORT', 8080);
const COLORS = ['#ff5252', '#448aff', '#69f0ae', '#ffd740'];
const ORIGINS = new Set((process.env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean));

const log = (...a) => console.log(new Date().toISOString(), ...a);   // nie IPs (07)
const rooms = new Map();
const connsPerIp = new Map();

/* ---------- Codes, Tokens, TURN ---------- */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';                  // Crockford, ohne I L O U
const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(32)]).join(''); } while (rooms.has(c)); return c; };
const normalizeCode = s => { const c = String(s ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); return /^[0-9A-HJKMNP-TV-Z]{5}$/.test(c) ? c : null; };
const newToken = () => crypto.randomBytes(16).toString('base64url');
const eq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

function iceServers(room, who) {                                      // who = 'host' | Slot-Nummer
  const exp = Math.floor(Date.now() / 1000) + num('TURN_TTL_S', 14400);
  const username = `${exp}:${room}-${who}`;
  const credential = crypto.createHmac('sha1', process.env.TURN_SECRET ?? '').update(username).digest('base64');
  const h = process.env.TURN_HOST;
  if (!h) return [{ urls: ['stun:stun.cloudflare.com:3478'] }];      // ponytail: Live-Test ohne coturn -> STUN only, kein Relay
  return [{ urls: [`stun:${h}:3478`] }, { urls: [`turn:${h}:3478?transport=udp`, `turn:${h}:3478?transport=tcp`], username, credential }];
}

/* ---------- Limits ---------- */
const counters = new Map();                                           // key -> {n, until}
function hit(key, limit) {                                            // true = noch erlaubt
  const now = Date.now();
  let c = counters.get(key);
  if (!c || c.until <= now) { c = { n: 0, until: now + 60_000 }; counters.set(key, c); }
  return ++c.n <= limit;
}
setInterval(() => { const now = Date.now(); for (const [k, c] of counters) if (c.until <= now) counters.delete(k); }, 60_000).unref();

function clientKey(req) {                                             // X-Forwarded-For (Caddy); IPv6 auf /64
  const xff = req.headers['x-forwarded-for'];
  const raw = (xff ? String(xff).split(',')[0] : req.socket.remoteAddress ?? '').trim();
  const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') + '::' : ip;
}
// ponytail: Relay-Datenweg fuer den Fall, dass WebRTC nicht durch das NAT kommt
// (Live-Test ohne eigenen TURN). Eigener Bucket: Sensor-Frames kommen mit ~60 Hz,
// der JSON-Bucket erlaubt nur 30/s. Faellt weg, sobald coturn auf dem VPS steht.
const FRAME_BYTES = 44;
function takeFrame(ws) {                                              // 120 Frames/s, Burst 240
  const now = Date.now();
  const b = ws.fbucket ??= { tokens: 240, ts: now };
  b.tokens = Math.min(240, b.tokens + (now - b.ts) * 0.12);
  b.ts = now;
  if (b.tokens < 1) return false;
  b.tokens -= 1;
  return true;
}
function relayFrame(ws, data) {
  const ctx = ws.ctx;
  if (!ctx || ctx.role !== 'ctrl' || data.length !== FRAME_BYTES || !takeFrame(ws)) return;
  const host = rooms.get(ctx.room)?.host;                             // Slot-Byte vorn, damit die Console demuxen kann
  if (host && host.readyState === 1) host.send(Buffer.concat([Buffer.of(ctx.slot), data]));
}
function takeToken(ws) {                                              // 30 msg/s, Burst 60
  const now = Date.now();
  ws.bucket.tokens = Math.min(60, ws.bucket.tokens + (now - ws.bucket.ts) * 0.03);
  ws.bucket.ts = now;
  if (ws.bucket.tokens < 1) return false;
  ws.bucket.tokens -= 1;
  return true;
}

/* ---------- Raumzustand ---------- */
const send = (ws, o) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); };
const err = (ws, code) => send(ws, { t: 'error', code });

function closeRoom(room, reason) {
  if (!rooms.delete(room.code)) return;
  clearTimeout(room.hostTimer); clearTimeout(room.maxTimer);
  for (const s of room.slots) {
    clearTimeout(s.timer);
    if (s.ws) { send(s.ws, { t: 'room-closed', reason }); s.ws.ctx = null; s.ws.close(1001, 'room-closed'); }
  }
  if (room.host) { send(room.host, { t: 'room-closed', reason }); room.host.ctx = null; room.host.close(1001, 'room-closed'); }
  log('room-closed', room.code, reason);
}

function bind(ws, ctx) { clearTimeout(ws.idle); ws.ctx = ctx; }

function doCreate(ws) {
  if (!hit(`create:${ws.ip}`, LIM.createPerIp)) return err(ws, 'RATE_LIMITED');
  if (rooms.size >= LIM.maxRooms) return err(ws, 'SERVER_FULL');
  const code = newCode();
  const room = {
    code, hostToken: newToken(), host: ws, hostTimer: null, maxTimer: null,
    slots: Array.from({ length: 4 }, () => ({ state: 'free', ws: null, token: null, timer: null, name: null })),
  };
  room.maxTimer = setTimeout(() => closeRoom(room, 'expired'), ROOM_MAX_MS);
  rooms.set(code, room);
  bind(ws, { role: 'host', room: code });
  send(ws, { t: 'created', room: code, hostToken: room.hostToken, iceServers: iceServers(code, 'host') });
  log('create', code);
}

function doJoin(ws, msg) {
  const code = normalizeCode(msg.room);
  const room = code ? rooms.get(code) : null;
  if (!room) {
    const perIp = hit(`join:${ws.ip}`, LIM.failedJoinsPerIp);
    const global = hit('join:*', LIM.failedJoinsGlobal);
    return err(ws, perIp && global ? 'ROOM_NOT_FOUND' : 'RATE_LIMITED');
  }
  const slot = room.slots.findIndex(s => s.state === 'free');
  if (slot < 0) return err(ws, 'ROOM_FULL');
  const s = room.slots[slot];
  s.state = 'connected'; s.ws = ws; s.token = newToken();
  s.name = typeof msg.name === 'string' ? msg.name.slice(0, 24) : null;
  bind(ws, { role: 'ctrl', room: code, slot });
  send(ws, { t: 'joined', room: code, slot, color: COLORS[slot], resumeToken: s.token, iceServers: iceServers(code, slot) });
  send(room.host, { t: 'peer-joined', slot, color: COLORS[slot], iceServers: iceServers(code, 'host') });
  log('join', code, slot);
}

function doResume(ws, msg) {
  const code = normalizeCode(msg.room);
  const room = code ? rooms.get(code) : null;
  const token = String(msg.token ?? '');
  if (!room || !token) return err(ws, 'RESUME_INVALID');
  if (eq(token, room.hostToken)) {
    clearTimeout(room.hostTimer); room.hostTimer = null;
    if (room.host && room.host !== ws) { room.host.ctx = null; room.host.close(1001, 'replaced'); }
    room.host = ws; room.hostToken = newToken();
    bind(ws, { role: 'host', room: code });
    send(ws, { t: 'created', room: code, hostToken: room.hostToken, iceServers: iceServers(code, 'host'), resumed: true });
    for (const [i, s] of room.slots.entries()) if (s.state === 'connected')
      send(ws, { t: 'peer-joined', slot: i, color: COLORS[i], iceServers: iceServers(code, 'host'), resumed: true });
    for (const s of room.slots) send(s.ws, { t: 'host-back' });           // Gegenstueck zu host-away
    log('resume-host', code);
    return;
  }
  const slot = room.slots.findIndex(s => s.token && eq(token, s.token));
  if (slot < 0) return err(ws, 'RESUME_INVALID');
  const s = room.slots[slot];
  clearTimeout(s.timer); s.timer = null;
  if (s.ws && s.ws !== ws) { s.ws.ctx = null; s.ws.close(1001, 'replaced'); }
  s.ws = ws; s.state = 'connected'; s.token = newToken();
  bind(ws, { role: 'ctrl', room: code, slot });
  send(ws, { t: 'joined', room: code, slot, color: COLORS[slot], resumeToken: s.token, iceServers: iceServers(code, slot), resumed: true });
  // fresh: der Controller hat eine neue PeerConnection (Reload) – die Console baut ihre dann neu;
  // ohne fresh behaelt sie eine laufende (der DataChannel haengt nicht am Signaling, Plan 05/5).
  send(room.host, { t: 'peer-joined', slot, color: COLORS[slot], iceServers: iceServers(code, 'host'), resumed: true, fresh: !!msg.fresh });
  log('resume-slot', code, slot);
}

function freeSlot(room, slot, reason) {
  const s = room.slots[slot];
  clearTimeout(s.timer);
  Object.assign(s, { state: 'free', ws: null, token: null, timer: null, name: null });
  send(room.host, { t: 'peer-left', slot, reason });
  log('peer-left', room.code, slot, reason);
}

function handle(ws, msg) {
  if (!ws.ctx) {
    if (msg.t === 'create') return doCreate(ws);
    if (msg.t === 'join') return doJoin(ws, msg);
    if (msg.t === 'resume') return doResume(ws, msg);
    return ws.close(1008, 'no role');
  }
  const { role, room: code, slot } = ws.ctx;
  const room = rooms.get(code);
  if (!room) return ws.close(1001, 'room gone');
  if (msg.t === 'ping') return send(ws, { t: 'pong' });
  if (msg.t === 'turn') return send(ws, { t: 'turn', iceServers: iceServers(code, role === 'host' ? 'host' : slot) });
  if (role === 'host') {
    switch (msg.t) {
      case 'offer': case 'ice': case 'relay': {
        const target = Number.isInteger(msg.to) ? room.slots[msg.to] : null;
        if (!target || target.state !== 'connected') return err(ws, 'BAD_TARGET');
        return send(target.ws, { ...msg, from: 'host' });
      }
      case 'leave': return closeRoom(room, 'host-left');
      default: return ws.close(1008, 'type');
    }
  }
  switch (msg.t) {
    case 'answer': case 'ice': case 'restart': case 'relay': return send(room.host, { ...msg, from: slot });
    case 'leave': { ws.ctx = null; freeSlot(room, slot, 'left'); return ws.close(1000, 'bye'); }
    default: return ws.close(1008, 'type');
  }
}

function onClose(ws) {
  clearTimeout(ws.idle);
  const n = (connsPerIp.get(ws.ip) ?? 1) - 1;
  n > 0 ? connsPerIp.set(ws.ip, n) : connsPerIp.delete(ws.ip);
  const ctx = ws.ctx;
  if (!ctx) return;
  const room = rooms.get(ctx.room);
  if (!room) return;
  if (ctx.role === 'host') {
    if (room.host !== ws) return;
    room.host = null;
    for (const s of room.slots) send(s.ws, { t: 'host-away' });
    room.hostTimer = setTimeout(() => closeRoom(room, 'host-timeout'), HOST_AWAY_MS);
    log('host-away', room.code);
  } else {
    const s = room.slots[ctx.slot];
    if (s.ws !== ws) return;
    s.ws = null; s.state = 'reserved';
    send(room.host, { t: 'peer-reconnecting', slot: ctx.slot });
    s.timer = setTimeout(() => freeSlot(room, ctx.slot, 'timeout'), SLOT_RESERVED_MS);
    log('peer-reconnecting', room.code, ctx.slot);
  }
}

/* ---------- HTTP ---------- */
// ponytail: STATIC_DIR ist reiner Dev-Komfort, damit der Prototyp ohne Caddy unter einer Origin laeuft.
// In Produktion ist STATIC_DIR nicht gesetzt und Caddy (02) liefert die Dateien; dann bleibt es beim 404.
const STATIC_DIR = process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : null;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res) {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  const rel = p === '/' ? '/index.html' : p === '/controller' ? '/controller.html' : p;
  const file = path.resolve(STATIC_DIR, '.' + rel);
  if (!file.startsWith(STATIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (e, buf) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  });
}
function handleHttp(req, res) {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: wss.clients.size, uptime: Math.round(process.uptime()) }));
  }
  if (STATIC_DIR && req.method === 'GET') return serveStatic(req, res);
  res.writeHead(404); res.end();
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false, clientTracking: true });
const server = http.createServer(handleHttp);
server.on('upgrade', (req, socket, head) => {
  socket.on('error', () => socket.destroy());
  const ip = clientKey(req);
  const ok = req.url === '/ws' && ORIGINS.has(req.headers.origin ?? '')
    && wss.clients.size < LIM.maxConnections && (connsPerIp.get(ip) ?? 0) < LIM.maxConnPerIp;
  if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; connsPerIp.set(ip, (connsPerIp.get(ip) ?? 0) + 1); wss.emit('connection', ws, req); });
});
wss.on('wsClientError', (_e, socket) => socket.destroy());

wss.on('connection', ws => {
  ws.on('error', e => log('ws error', e.code ?? e.message));
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  ws.bucket = { tokens: 60, ts: Date.now() };
  ws.idle = setTimeout(() => { if (!ws.ctx) ws.close(1008, 'no role'); }, 10_000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return relayFrame(ws, data);
    if (!takeToken(ws)) return ws.close(1008, 'protocol');
    let msg; try { msg = JSON.parse(data); } catch { return ws.close(1008, 'json'); }
    if (typeof msg?.t !== 'string') return ws.close(1008, 'type');
    try { handle(ws, msg); } catch (e) { log('handle', e.message); ws.close(1011, 'internal'); }
  });
  ws.on('close', () => onClose(ws));
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 30_000).unref();

/* ---------- Start + Shutdown ---------- */
server.listen(PORT, '0.0.0.0', () => log('listen', server.address().port));
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  if (stopping) return; stopping = true;
  for (const ws of wss.clients) ws.close(1001, 'restart');            // Clients kommen per resume zurueck
  wss.close(); server.close(() => process.exit(0));
  // ponytail: 1,5 s statt 5 s, weil die DoD `docker stop` < 2 s verlangt.
  setTimeout(() => process.exit(0), 1500).unref();
});
