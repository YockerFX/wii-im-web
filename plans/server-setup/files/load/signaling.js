// Lasttest Signaling (k6 >= 1.0, Modul k6/websockets). Aufruf: DOMAIN=<DOMAIN> k6 run load/signaling.js
// 200 VUs = 200 Räume: jede VU öffnet eine Console (create) und einen Controller (join), hält 4 min mit App-Pings.
// Vorher auf dem Server MAX_CONN_PER_IP=1000 und CREATE_PER_IP_PER_MIN=1000 setzen (08), danach zurück.
import { WebSocket } from 'k6/websockets';

export const options = { vus: 200, duration: '5m' };
const url = `wss://${__ENV.DOMAIN}/ws`;
const params = { headers: { Origin: `https://${__ENV.DOMAIN}` } };   // ohne Origin → 403 (Plan 03)

function open(onOpen, onMsg) {
  const ws = new WebSocket(url, null, params);
  ws.addEventListener('open', () => onOpen(ws));
  ws.addEventListener('message', e => onMsg(ws, JSON.parse(e.data)));
  ws.addEventListener('error', e => console.error('ws error', e));
  const hb = setInterval(() => ws.send(JSON.stringify({ t: 'ping' })), 20000);
  setTimeout(() => { clearInterval(hb); ws.close(); }, 240000);
  return ws;
}

export default function () {
  open(host => host.send(JSON.stringify({ t: 'create' })), (host, m) => {
    if (m.t === 'error') return console.error('create', m.code);
    if (m.t !== 'created') return;
    open(c => c.send(JSON.stringify({ t: 'join', room: m.room, name: `vu${__VU}` })),
         (c, m2) => { if (m2.t === 'error') console.error('join', m2.code); });
  });
}
