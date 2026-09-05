# 03 – Signaling-Server (Node 24 + ws)
**Ziel:** Ein In-Memory-Room-Server, der Console und bis zu 4 Controller zusammenbringt, SDP/ICE strikt nach Rolle und Slot routet, Reconnect per Token erlaubt, TURN-Credentials ausgibt – und den kein einzelner Client abschießen kann.
**Voraussetzungen:** 00 (Platzhalter), Node 24 lokal, `files/signaling/Dockerfile`. Kein Server nötig.
**Definition of Done:**
- [ ] `GET /healthz` → `{"ok":true,"rooms":0,"connections":0,"uptime":…}`
- [ ] Abnahmetest unten grün; Prozess überlebt kaputtes JSON, 100-KB-Nachricht, fremden Origin, 200 Verbindungen von einer IP
- [ ] Console-Verbindung weg → Controller erhält `host-away`; `resume` mit `hostToken` binnen 60 s stellt den Raum her, sonst `room-closed`
- [ ] Controller-Verbindung weg → Console erhält `peer-reconnecting`; `resume` gibt denselben Slot; nach 120 s `peer-left`
- [ ] `docker build` läuft; Prozess läuft als User `node`; `docker stop` endet in < 2 s, Clients bekommen Close-Code 1001

## Schritte
1. **Projekt**: `signaling/package.json` mit `"type":"module"`, `"engines":{"node":">=24"}`, `"dependencies":{"ws":"^8.21.3"}`; alles in `server.js` (≈ 300 Zeilen). Kein Framework, kein Socket.IO.
   Die Snippets unten sind Ausschnitte; die Hilfsfunktionen `clientKey`, `takeToken`, `handle`, `onClose`, `log` und die Maps `rooms`/`connsPerIp` sowie `LIM` (Schritt 8) gehören in dieselbe Datei.
2. **HTTP + Upgrade-Handler** – Origin-Check und Verbindungslimits hier, nicht per `verifyClient`:
   ```js
   import http from 'node:http'; import crypto from 'node:crypto'; import { WebSocketServer } from 'ws';
   const ORIGINS = new Set(process.env.ALLOWED_ORIGINS.split(','));
   const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false, clientTracking: true });
   const server = http.createServer(handleHttp);                       // /healthz, sonst 404
   server.on('upgrade', (req, socket, head) => {
     socket.on('error', () => socket.destroy());
     const ip = clientKey(req);                                         // X-Forwarded-For (Caddy); IPv6 auf /64 gekürzt
     const ok = req.url === '/ws' && ORIGINS.has(req.headers.origin ?? '')
       && wss.clients.size < LIM.maxConnections && (connsPerIp.get(ip) ?? 0) < LIM.maxConnPerIp;
     if (!ok) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); }
     wss.handleUpgrade(req, socket, head, ws => { ws.ip = ip; wss.emit('connection', ws, req); });
   });
   wss.on('wsClientError', (_e, socket) => socket.destroy());
   server.listen(8080, '0.0.0.0');
   ```
   `X-Forwarded-For` ist nur vertrauenswürdig, weil Port 8080 nie veröffentlicht wird (`expose`, nicht `ports`).
3. **Pro Verbindung** – ohne `error`-Listener beendet ein einziger kaputter Frame den gesamten Prozess:
   ```js
   wss.on('connection', ws => {
     ws.on('error', e => log('ws error', e.code ?? e.message));
     ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
     ws.bucket = { tokens: 60, ts: Date.now() };                          // 30 msg/s, Burst 60
     ws.idle = setTimeout(() => { if (!ws.ctx) ws.close(1008, 'no role'); }, 10_000);
     ws.on('message', (data, isBinary) => {
       if (isBinary || !takeToken(ws)) return ws.close(1008, 'protocol');
       let msg; try { msg = JSON.parse(data); } catch { return ws.close(1008, 'json'); }
       if (typeof msg?.t !== 'string') return ws.close(1008, 'type');
       try { handle(ws, msg); } catch (e) { log(e); ws.close(1011, 'internal'); }
     });
     ws.on('close', () => onClose(ws));                                   // Zähler, Slot-/Host-Timer
   });
   ```
4. **Protokoll** (JSON-Text, Feld `t`). Der Server setzt `from` selbst und ignoriert client-gesetztes `from`.
   | Richtung | Nachricht | Antwort / Wirkung |
   |---|---|---|
   | Console → S | `{t:"create"}` | `{t:"created", room, hostToken, iceServers}` |
   | Controller → S | `{t:"join", room, name?}` | `{t:"joined", room, slot, color, resumeToken, iceServers}` oder `{t:"error", code}` |
   | beide → S | `{t:"resume", room, token}` | wie `created`/`joined` mit `resumed:true`; Console erhält danach `peer-joined` je verbundenem Slot |
   | Console → S | `{t:"offer", to, sdp}`, `{t:"ice", to, candidate}` | an Slot `to` (0–3, Zustand `connected`), sonst `error BAD_TARGET` |
   | Controller → S | `{t:"answer", sdp}`, `{t:"ice", candidate}`, `{t:"restart"}` | an die Console des eigenen Raums, mit `from: slot` |
   | beide → S | `{t:"turn"}` | `{t:"turn", iceServers}` – frische Credentials (vor ICE-Restart) |
   | beide → S | `{t:"ping"}`, `{t:"leave"}` | `{t:"pong"}` / Slot frei bzw. Raum zu |
   | S → Console | `{t:"peer-joined", slot, color, iceServers, resumed?}`, `{t:"peer-reconnecting", slot}`, `{t:"peer-left", slot, reason}` | |
   | S → Controller | `{t:"host-away"}`, `{t:"room-closed", reason}` | |
   | S → beide | `{t:"error", code}`: `ROOM_NOT_FOUND`, `ROOM_FULL`, `RATE_LIMITED`, `SERVER_FULL`, `RESUME_INVALID`, `BAD_TARGET` | |
   Regeln: Die Console ist immer Offerer und baut pro `peer-joined` eine neue RTCPeerConnection (kein Glare). Unbekannter Typ, Nachricht vor create/join/resume oder zweites `create` auf derselben Verbindung → `close(1008)`.
5. **Zustände und Timer**
   | Objekt | Zustände | Übergänge |
   |---|---|---|
   | Raum | `open` → `host-away` → `closed` | Host-Socket zu → `host-away` an alle Controller + 60-s-Timer; `resume` mit `hostToken` → `open`; Timer → `room-closed` + `close(1001)` an alle, Raum löschen |
   | Raum | max. Lebensdauer | 12 h nach `create` → `closed` (Sicherheitsnetz). **Kein** Idle-Timeout: während des Spiels läuft kein Signaling-Verkehr, Aufräumen passiert über Host-Weg (60 s) und Heartbeat |
   | Slot | `free` → `connected` → `reserved` → `free` | Controller-Socket zu → `reserved` + `peer-reconnecting` + 120-s-Timer; `resume` → `connected` (Token rotiert); Timer → `free` + `peer-left {reason:"timeout"}` |
6. **Codes und Tokens** – nur `node:crypto`, nie `Math.random`:
   ```js
   const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';                    // Crockford, 32 Zeichen
   const newCode = () => { let c; do { c = Array.from({ length: 5 }, () => ALPHABET[crypto.randomInt(32)]).join(''); } while (rooms.has(c)); return c; };
   const normalizeCode = s => { const c = String(s ?? '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1'); return /^[0-9A-HJKMNP-TV-Z]{5}$/.test(c) ? c : null; };
   const newToken = () => crypto.randomBytes(16).toString('base64url');   // hostToken, resumeToken
   ```
   Vergleich mit `crypto.timingSafeEqual` bei gleicher Länge; Tokens nie in URLs.
7. **TURN-Credentials** (coturn-REST-Format `ablauf:userid`; Username = Raum + Rolle, damit `user-quota` pro Spieler greift):
   ```js
   function iceServers(room, who) {                                        // who = 'host' | Slot-Nummer
     const exp = Math.floor(Date.now() / 1000) + Number(process.env.TURN_TTL_S ?? 14400);
     const username = `${exp}:${room}-${who}`;
     const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
     const h = process.env.TURN_HOST;
     return [{ urls: [`stun:${h}:3478`] }, { urls: [`turn:${h}:3478?transport=udp`, `turn:${h}:3478?transport=tcp`], username, credential }];
   }
   ```
   Credentials nur nach erfolgreichem create/join/resume oder auf `{t:"turn"}` innerhalb der Session – nie über einen offenen HTTP-Endpunkt.
8. **Limits** (ENV, Defaults im Code): `MAX_CONNECTIONS=5000`, `MAX_CONN_PER_IP=100`, `MAX_ROOMS=2000`, `CREATE_PER_IP_PER_MIN=10`, `FAILED_JOINS_PER_IP_PER_MIN=15`, `FAILED_JOINS_GLOBAL_PER_MIN=300`. Es zählen nur **fehlgeschlagene** Joins (unbekannter Code) – 4 Handys hinter einem Heim-NAT dürfen nie ausgesperrt werden. `SERVER_FULL`/`RATE_LIMITED` als `error`-Nachricht, nicht als Close.
9. **Heartbeat**: alle 30 s `ws.ping()` an alle; wer beim nächsten Durchlauf `isAlive === false` hat → `terminate()` (löst `close` aus → Slot `reserved`). `{t:"ping"}` mit `{t:"pong"}` beantworten.
10. **/healthz + Shutdown**:
    ```js
    function handleHttp(req, res) {
      if (req.url !== '/healthz') { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, connections: wss.clients.size, uptime: Math.round(process.uptime()) }));
    }
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
      for (const ws of wss.clients) ws.close(1001, 'restart');              // Clients kommen per resume zurück
      wss.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref();
    });
    ```
11. **Logging**: Ereignis + Raum-Code + Slot, keine Client-IPs (Datenschutz, 07).
12. **Dockerfile** aus `files/signaling/Dockerfile` (node:24-alpine, `npm ci --omit=dev`, `USER node`, `CMD ["node","server.js"]`). Compose (06) setzt `init: true`, `stop_grace_period: 15s`, Healthcheck auf `/healthz`.

## Abnahmetest
```sh
ALLOWED_ORIGINS=http://localhost:8080 TURN_SECRET=x TURN_HOST=turn.test node server.js &
curl -s localhost:8080/healthz                                                  # {"ok":true,...}
npx wscat -c ws://localhost:8080/ws -o http://localhost:8080    # > {"t":"create"}            → created + room
npx wscat -c ws://localhost:8080/ws -o http://localhost:8080    # > {"t":"join","room":"<code>"} → joined, slot 0
npx wscat -c ws://localhost:8080/ws -o http://evil.example      # → 403
npx wscat -c ws://localhost:8080/ws -o http://localhost:8080    # > nix{   → Close 1008; healthz erneut prüfen: Prozess lebt
```
Dann Console-wscat beenden → Controller-wscat zeigt `host-away`, nach 60 s `room-closed`. `docker build -t wii-signaling signaling && docker run --rm -e ALLOWED_ORIGINS=http://localhost:8080 -e TURN_SECRET=x -e TURN_HOST=t -p 8080:8080 wii-signaling`; `docker stop` endet in < 2 s.

## Rollback
Kein Zustand außerhalb des Prozesses: vorherigen Stand von `signaling/` aus Git holen und `docker compose up -d --build signaling` (06). Clients reconnecten per Token.

## Stolperfallen
- `req.socket.remoteAddress` ist hinter Caddy immer Caddys Container-IP → Per-IP-Logik nur über `X-Forwarded-For`.
- `maxPayload`-Überschreitung emittiert `error` auf dem Socket – deshalb der `error`-Listener als Erstes.
- Crockford-Autokorrektur gilt beim **Dekodieren**: Eingabe `O`→`0`, `I`/`L`→`1`. Erzeugt werden nie I/L/O/U.
- Nach `resume` der Console brauchen alle Controller neue PeerConnections (`peer-joined` erneut senden) – alte DataChannels sind tot.
- TURN-Usernames sind Unix-Timestamps; der Container nutzt die Host-Uhr (NTP-Check in 01).

## Nicht Teil dieses Plans
Client-Code → 05; coturn → 04; Compose/Deploy → 06; Lasttest → 08.
