// Abnahmetest aus 03-signaling-server.md, automatisiert gegen einen echten Serverprozess.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';

const ORIGIN = 'http://localhost:8080';
const SECRET = 'testsecret';
const procs = [];
const socks = [];

function startServer(env = {}) {
  const proc = spawn(process.execPath, ['server.js'], {
    cwd: import.meta.dirname,
    env: { ...process.env, PORT: '0', ALLOWED_ORIGINS: `${ORIGIN},http://other.test`, TURN_SECRET: SECRET, TURN_HOST: 'turn.test', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  procs.push(proc);
  return new Promise((res, rej) => {
    let buf = '';
    proc.stdout.on('data', d => { buf += d; const m = buf.match(/listen (\d+)/); if (m) res({ proc, port: Number(m[1]) }); });
    proc.on('exit', c => rej(new Error(`server exited ${c}`)));
  });
}

function connect(port, { origin = ORIGIN, path = '/ws' } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { origin });
  socks.push(ws);
  const q = [], waiters = [];
  ws.on('error', () => {});
  ws.on('message', d => { let m; try { m = JSON.parse(d.toString()); } catch { return; }   // Binaerframes ignorieren
    waiters.length ? waiters.shift()(m) : q.push(m); });
  ws.closed = new Promise(r => ws.on('close', (code, reason) => r({ code, reason: reason.toString() })));
  ws.ready = new Promise((res, rej) => { ws.on('open', () => res(ws)); ws.on('error', rej); });
  ws.j = o => ws.send(JSON.stringify(o));
  ws.next = (ms = 3000) => new Promise((res, rej) => {
    if (q.length) return res(q.shift());
    const t = setTimeout(() => rej(new Error('timeout waiting for message')), ms);
    waiters.push(m => { clearTimeout(t); res(m); });
  });
  return ws;
}

const health = port => fetch(`http://127.0.0.1:${port}/healthz`).then(r => r.json());

async function makeConsole(port) {
  const ws = await connect(port).ready;
  ws.j({ t: 'create' });
  return [ws, await ws.next()];
}
async function makeCtrl(port, room) {
  const ws = await connect(port).ready;
  ws.j({ t: 'join', room });
  return [ws, await ws.next()];
}

let main;
before(async () => { main = await startServer({ HOST_AWAY_MS: '600', SLOT_RESERVED_MS: '600', CREATE_PER_IP_PER_MIN: '500' }); });
after(() => { for (const s of socks) s.terminate(); for (const p of procs) p.kill('SIGKILL'); });

test('GET /healthz', async () => {
  const j = await health(main.port);
  assert.deepEqual({ ok: j.ok, rooms: j.rooms, connections: j.connections }, { ok: true, rooms: 0, connections: 0 });
  assert.equal(typeof j.uptime, 'number');
  assert.equal((await fetch(`http://127.0.0.1:${main.port}/nope`)).status, 404);
});

test('Upgrade: fremder Origin und falscher Pfad -> 403', async () => {
  await assert.rejects(connect(main.port, { origin: 'http://evil.example' }).ready, /403/);
  await assert.rejects(connect(main.port, { path: '/nope' }).ready, /403/);
});

test('create -> created mit Code, hostToken und TURN-Credentials', async () => {
  const [, m] = await makeConsole(main.port);
  assert.equal(m.t, 'created');
  assert.match(m.room, /^[0-9A-HJKMNP-TV-Z]{5}$/);
  assert.equal(typeof m.hostToken, 'string');
  const [stun, turn] = m.iceServers;
  assert.deepEqual(stun.urls, ['stun:turn.test:3478']);
  assert.deepEqual(turn.urls, ['turn:turn.test:3478?transport=udp', 'turn:turn.test:3478?transport=tcp']);
  const [exp, id] = turn.username.split(':');
  assert.equal(id, `${m.room}-host`);
  assert.ok(Number(exp) > Date.now() / 1000);
  assert.equal(turn.credential, crypto.createHmac('sha1', SECRET).update(turn.username).digest('base64'));
});

test('join: Slot 0 + Farbe, peer-joined, Autokorrektur, ROOM_FULL, ROOM_NOT_FOUND', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [, joined] = await makeCtrl(main.port, created.room);
  assert.equal(joined.t, 'joined');
  assert.equal(joined.slot, 0);
  assert.equal(joined.color, '#ff5252');
  assert.equal(typeof joined.resumeToken, 'string');
  assert.equal(joined.iceServers[1].username.split(':')[1], `${created.room}-0`);
  const pj = await cons.next();
  assert.equal(pj.t, 'peer-joined');
  assert.equal(pj.slot, 0);
  assert.equal(pj.color, '#ff5252');
  assert.equal(pj.iceServers[1].username.split(':')[1], `${created.room}-host`);
});

test('Crockford-Autokorrektur beim join', async () => {
  let last;
  for (let i = 0; i < 40; i++) {
    const cur = await makeConsole(main.port);
    if (last) last[0].close();
    last = cur;
    if (/[01]/.test(cur[1].room)) break;
  }
  const code = last[1].room;
  const mangled = code.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l');
  const [, joined] = await makeCtrl(main.port, mangled);
  assert.equal(joined.t, 'joined');
  assert.equal(joined.room, code);
});

test('ROOM_FULL und ROOM_NOT_FOUND', async () => {
  const [, created] = await makeConsole(main.port);
  for (let i = 0; i < 4; i++) {
    const [, m] = await makeCtrl(main.port, created.room);
    assert.equal(m.slot, i);
  }
  const [, full] = await makeCtrl(main.port, created.room);
  assert.deepEqual(full, { t: 'error', code: 'ROOM_FULL' });
  const [, nf] = await makeCtrl(main.port, 'ZZZZZ');
  assert.deepEqual(nf, { t: 'error', code: 'ROOM_NOT_FOUND' });
});

test('Routing offer/answer/ice inkl. from, BAD_TARGET', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await cons.next();                                                  // peer-joined
  cons.j({ t: 'offer', to: 0, sdp: 'SDP-A', from: 'gefaelscht' });
  const off = await ctrl.next();
  assert.equal(off.t, 'offer');
  assert.equal(off.sdp, 'SDP-A');
  assert.equal(off.from, 'host');
  ctrl.j({ t: 'answer', sdp: 'SDP-B', from: 99 });
  assert.deepEqual(await cons.next(), { t: 'answer', sdp: 'SDP-B', from: 0 });
  ctrl.j({ t: 'ice', candidate: 'C1', from: 99 });
  assert.deepEqual(await cons.next(), { t: 'ice', candidate: 'C1', from: 0 });
  cons.j({ t: 'ice', to: 0, candidate: 'C2' });
  assert.equal((await ctrl.next()).candidate, 'C2');
  ctrl.j({ t: 'restart' });
  assert.deepEqual(await cons.next(), { t: 'restart', from: 0 });
  cons.j({ t: 'offer', to: 1, sdp: 'x' });
  assert.deepEqual(await cons.next(), { t: 'error', code: 'BAD_TARGET' });
  cons.j({ t: 'ice', to: 9, candidate: 'x' });
  assert.deepEqual(await cons.next(), { t: 'error', code: 'BAD_TARGET' });
});

test('ping -> pong, turn -> frische iceServers', async () => {
  const [cons, created] = await makeConsole(main.port);
  cons.j({ t: 'ping' });
  assert.deepEqual(await cons.next(), { t: 'pong' });
  cons.j({ t: 'turn' });
  const m = await cons.next();
  assert.equal(m.t, 'turn');
  assert.equal(m.iceServers[1].username.split(':')[1], `${created.room}-host`);
});

test('Robustheit: kaputtes JSON, binaer, Nachricht vor Rolle, 100-KB-Nachricht', async () => {
  for (const [what, payload] of [['json', 'nix{'], ['role', JSON.stringify({ t: 'ping' })], ['unknown', JSON.stringify({ t: 'quatsch' })]]) {
    const ws = await connect(main.port).ready;
    ws.send(payload);
    assert.equal((await ws.closed).code, 1008, what);
  }
  const bin = await connect(main.port).ready;
  bin.send(Buffer.alloc(16));
  assert.equal((await bin.closed).code, 1008);
  const big = await connect(main.port).ready;
  big.send('x'.repeat(100 * 1024));
  await big.closed;
  assert.equal((await health(main.port)).ok, true);
});

test('Controller weg -> peer-reconnecting, resume, alter Token ungueltig', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl, joined] = await makeCtrl(main.port, created.room);
  await cons.next();                                                  // peer-joined
  ctrl.close();
  assert.deepEqual(await cons.next(), { t: 'peer-reconnecting', slot: 0 });
  const back = await connect(main.port).ready;
  back.j({ t: 'resume', room: created.room, token: joined.resumeToken, fresh: true });
  const rj = await back.next();
  assert.equal(rj.t, 'joined');
  assert.equal(rj.slot, 0);
  assert.equal(rj.resumed, true);
  assert.notEqual(rj.resumeToken, joined.resumeToken);
  const pj = await cons.next();
  assert.deepEqual({ t: pj.t, slot: pj.slot, resumed: pj.resumed, fresh: pj.fresh }, { t: 'peer-joined', slot: 0, resumed: true, fresh: true });
  const stale = await connect(main.port).ready;
  stale.j({ t: 'resume', room: created.room, token: joined.resumeToken });
  assert.deepEqual(await stale.next(), { t: 'error', code: 'RESUME_INVALID' });
});

test('Controller ohne resume -> peer-left timeout nach SLOT_RESERVED_MS', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await cons.next();
  ctrl.close();
  assert.deepEqual(await cons.next(), { t: 'peer-reconnecting', slot: 0 });
  assert.deepEqual(await cons.next(2000), { t: 'peer-left', slot: 0, reason: 'timeout' });
});

test('Console weg -> host-away, resume stellt Raum her', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await cons.next();
  cons.close();
  assert.deepEqual(await ctrl.next(), { t: 'host-away' });
  const back = await connect(main.port).ready;
  back.j({ t: 'resume', room: created.room, token: created.hostToken });
  const re = await back.next();
  assert.equal(re.t, 'created');
  assert.equal(re.room, created.room);
  assert.equal(re.resumed, true);
  assert.notEqual(re.hostToken, created.hostToken);
  const pj = await back.next();
  assert.deepEqual({ t: pj.t, slot: pj.slot, color: pj.color, resumed: pj.resumed }, { t: 'peer-joined', slot: 0, color: '#ff5252', resumed: true });
  assert.ok(pj.iceServers[1].credential);
  assert.deepEqual(await ctrl.next(), { t: 'host-back' });
  back.j({ t: 'offer', to: 0, sdp: 'nach-resume' });
  assert.equal((await ctrl.next()).sdp, 'nach-resume');
});

test('Console ohne resume -> room-closed + Close 1001', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await cons.next();
  cons.close();
  assert.deepEqual(await ctrl.next(), { t: 'host-away' });
  assert.deepEqual(await ctrl.next(2000), { t: 'room-closed', reason: 'host-timeout' });
  assert.equal((await ctrl.closed).code, 1001);
});

test('leave: Controller gibt Slot frei, Console schliesst den Raum', async () => {
  const [cons, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await cons.next();
  ctrl.j({ t: 'leave' });
  assert.deepEqual(await cons.next(), { t: 'peer-left', slot: 0, reason: 'left' });
  const [ctrl2] = await makeCtrl(main.port, created.room);
  await cons.next();                                                  // peer-joined
  cons.j({ t: 'leave' });
  assert.deepEqual(await ctrl2.next(), { t: 'room-closed', reason: 'host-left' });
});

test('Rate-Limit: zu viele fehlgeschlagene Joins -> RATE_LIMITED', async () => {
  const s = await startServer({ FAILED_JOINS_PER_IP_PER_MIN: '2' });
  const ws = await connect(s.port).ready;
  const codes = [];
  for (let i = 0; i < 3; i++) { ws.j({ t: 'join', room: 'ZZZZZ' }); codes.push((await ws.next()).code); }
  assert.deepEqual(codes, ['ROOM_NOT_FOUND', 'ROOM_NOT_FOUND', 'RATE_LIMITED']);
  s.proc.kill('SIGKILL');
});

test('SIGTERM: Close 1001 fuer alle Clients, Prozessende < 2 s', async () => {
  const s = await startServer();
  const [cons] = await makeConsole(s.port);
  const t0 = Date.now();
  const exited = new Promise(r => s.proc.on('exit', () => r(Date.now() - t0)));
  s.proc.kill('SIGTERM');
  assert.equal((await cons.closed).code, 1001);
  const ms = await exited;
  assert.ok(ms < 2000, `Prozessende nach ${ms} ms`);
});

test('Relay: Binaerframe Controller -> Console mit Slot-Byte, JSON-Relay in beide Richtungen', async () => {
  const [host, created] = await makeConsole(main.port);
  const [ctrl] = await makeCtrl(main.port, created.room);
  await host.next();                                                  // peer-joined

  const bin = new Promise(res => host.once('message', (d, isBinary) => res({ d, isBinary })));
  const frame = Buffer.alloc(44); frame.writeUInt16LE(7, 0);          // seq = 7
  ctrl.send(frame);
  const got = await bin;
  assert.equal(got.isBinary, true);
  assert.equal(got.d.length, 45);
  assert.equal(got.d[0], 0);                                          // Slot-Byte
  assert.equal(got.d.readUInt16LE(1), 7);

  ctrl.send(Buffer.alloc(43));                                        // falsche Laenge -> verworfen, Socket bleibt offen
  host.j({ t: 'relay', to: 0, d: '{"t":"mode"}' });
  assert.equal((await ctrl.next()).d, '{"t":"mode"}');
  ctrl.j({ t: 'relay', d: '{"t":"btn"}' });
  const back = await host.next();
  assert.equal(back.d, '{"t":"btn"}');
  assert.equal(back.from, 0);
});
