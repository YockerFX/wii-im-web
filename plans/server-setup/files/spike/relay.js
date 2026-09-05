// Wegwerf-Signaling für den Spike (Plan 10): reicht jede Nachricht an alle anderen Clients weiter.
// KEIN Origin-Check, KEINE Räume – nie auf den VPS kopieren. Start: npm i ws && node relay.js
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8080, maxPayload: 65536 });
wss.on('connection', ws => {
  ws.on('error', () => {});
  ws.on('message', d => { for (const c of wss.clients) if (c !== ws && c.readyState === 1) c.send(d.toString()); });
});
console.log('spike relay on ws://localhost:8080 – clients:', () => wss.clients.size);
