# 05 – Client-Integration: Controller (Handy) und Console (Browser)
**Ziel:** Handy und Console bauen pro Slot eine RTCPeerConnection mit zwei DataChannels auf (Sensoren ungeordnet/unzuverlässig, Events zuverlässig), überleben Netzwechsel, Displaysperre und App-Wechsel, und Unity liest die Daten allokationsfrei.
**Voraussetzungen:** 03 läuft (lokal reicht); 04 nur für Relay-Tests. Lokale HTTPS-Umgebung (Schritt 1) – ohne HTTPS gibt es auf dem Handy weder Sensoren noch Brotli. Vorlagen: `files/compose.dev.yaml`, `files/Caddyfile.dev`.
**Definition of Done:**
- [ ] Handy im Heim-WLAN: Sensordaten kommen mit ≈ 60 Hz in Unity an (`WiiReadState` liefert laufend neue `seq`)
- [ ] `?forceRelay=1` gegen den Prod-Server, Handy im Mobilfunk: Verbindung steht, `selectedPath()` meldet `relay/…`
- [ ] Reconnect-Matrix R1–R6 aus 08 ohne Neuladen bestanden
- [ ] iOS: Berechtigungsdialog nur nach Button-Klick; Display bleibt an (Wake Lock)

## Schritte
1. **Lokale HTTPS-Umgebung** (einmalig): `files/compose.dev.yaml` und `files/Caddyfile.dev` ins Repo-Root; lokale `.env` mit `LAN_IP=<LAN_IP>`, `TURN_SECRET=dev`, `DOMAIN=dev`, `SERVER_IPV4=<LAN_IP>`, `SERVER_IPV6=::1`. Start: `docker compose -f compose.yaml -f compose.dev.yaml up --build` (coturn ist lokal deaktiviert; Static kommt aus `./out`). Caddy stellt per `tls internal` ein Zertifikat aus; Root-CA aufs Handy:
   ```sh
   docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt   # per AirDrop/Mail aufs Handy
   ```
   iOS: Profil installieren → Einstellungen › Allgemein › Info › Zertifikatsvertrauen → volle Vertrauensstellung. Android: Einstellungen › Sicherheit › CA-Zertifikat installieren. Prüfen: `https://<LAN_IP>/controller` öffnet ohne Warnung.
2. **PeerConnection**: Console erzeugt pro `peer-joined` eine neue PC mit den **mitgelieferten** `iceServers`; Controller bei `joined`. Nie ein altes `iceServers`-Array wiederverwenden.
   ```js
   const forceRelay = new URLSearchParams(location.search).get('forceRelay') === '1';
   const pc = new RTCPeerConnection({ iceServers: msg.iceServers, iceTransportPolicy: forceRelay ? 'relay' : 'all' });
   pc.onicecandidate = e => e.candidate && sig.send({ t: 'ice', to: slot, candidate: e.candidate });   // Controller ohne `to`
   ```
   Console: `createOffer` → `setLocalDescription` → `{t:"offer"}`; Controller: `setRemoteDescription` → `createAnswer` → `{t:"answer"}`. ICE-Kandidaten, die vor `setRemoteDescription` eintreffen, puffern.
3. **DataChannels** – beide Seiten identisch, `negotiated: true` mit festen IDs (kein `ondatachannel`-Roundtrip):
   ```js
   const sensors = pc.createDataChannel('sensors', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
   const events  = pc.createDataChannel('events',  { negotiated: true, id: 1 });   // Default: ordered + reliable
   sensors.binaryType = events.binaryType = 'arraybuffer';
   ```
   Sensor-Frame 44 Byte, Little-Endian: `u16 seq | u16 flags | f32 t | f32 ax ay az | f32 rx ry rz | f32 dx dy dz` (`d` = Einheitsvektor der Handy-Längsachse in der Kalibrier-Basis: x rechts, y zur Bildschirmmitte, z oben). Senden nur bei `sensors.bufferedAmount < 4*44`, sonst Frame verwerfen. Empfänger verwirft verspätete Frames: `((seq - last) & 0xffff) >= 0x8000 → drop`. Buttons als JSON über `events`: `{t:"btn", id, down}`.
4. **Controller-Start** – alles im selben Klick-Handler (iOS verlangt User-Gesture; kein `await` davor):
   ```js
   startBtn.onclick = async () => {
     if (!isSecureContext) return hint('Bitte über https:// öffnen');
     for (const E of [DeviceMotionEvent, DeviceOrientationEvent])
       if (typeof E?.requestPermission === 'function' && await E.requestPermission() !== 'granted') return hint('Bewegungszugriff abgelehnt – Tab schließen und neu öffnen');
     await keepAwake();                                   // navigator.wakeLock?.request('screen'), Fehler ignorieren
     addEventListener('devicemotion', onMotion);
     connect();                                           // WebSocket → join oder resume
   };
   ```
   Console: `keepAwake()` im Klick auf „Raum erstellen“. Beide: bei `visibilitychange → visible` erneut anfordern (Lock wird beim Verstecken automatisch freigegeben).
5. **Resume/Reconnect** – Controller hält `room` + `resumeToken`, Console `room` + `hostToken` in `sessionStorage`:
   ```js
   function ensureConnected() {
     if (sig.readyState !== WebSocket.OPEN) return reconnectSignaling();        // → {t:"resume", room, token}, Backoff 1/2/4/8 s
     if (['disconnected', 'failed'].includes(pc?.connectionState)) requestRestart();
   }
   document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' ? (keepAwake(), ensureConnected()) : stopSending());
   addEventListener('pageshow', e => e.persisted && ensureConnected());
   addEventListener('online', ensureConnected);
   ```
   App-Ping `{t:"ping"}` alle 25 s; kein `pong` binnen 10 s → `sig.close()` → reconnect. Nach `resume` der Console kommt für jeden Slot ein neues `peer-joined` → neue PC.
6. **ICE-Restart** – nur die Console erzeugt Offers:
   - Controller: `iceConnectionState === 'failed'` → sofort `{t:"restart"}`; `connectionState === 'disconnected'` → nach 5 s Karenz `{t:"restart"}`.
   - Console bei `{t:"restart", from}` oder eigenem `failed`: `{t:"turn"}` anfordern → `pc.setConfiguration({ ...pc.getConfiguration(), iceServers })` → `pc.restartIce()` → `negotiationneeded` → neues Offer an `from`.
   - Bleibt die PC 10 s nach dem Restart nicht `connected`: Console schließt sie; Controller lädt nach zwei erfolglosen Restarts die Seite neu (Slot bleibt per `resumeToken` 120 s reserviert).
7. **Unity-Brücke** – kein `SendMessage` pro Frame (240 Aufrufe/s, String-Allokationen). JS hält den letzten Frame je Slot, Unity pollt in `Update()`:
   ```js
   // Console (JS): window.__wii = { state: [null,null,null,null], seq: [0,0,0,0], buttons: [0,0,0,0] };
   sensors.onmessage = ({ data }) => { __wii.state[slot] = new Float32Array(data, 4, 10); __wii.seq[slot] = new DataView(data).getUint16(0, true); };
   events.onmessage  = ({ data }) => { const m = JSON.parse(data); if (m.t === 'btn') __wii.buttons[slot] = m.down ? __wii.buttons[slot] | 1 << m.id : __wii.buttons[slot] & ~(1 << m.id); };
   ```
   ```js
   // Assets/Plugins/WebGL/Wii.jslib
   mergeInto(LibraryManager.library, {
     WiiReadState: function (slot, outPtr) { var w = window.__wii; if (!w || !w.state[slot]) return 0; HEAPF32.set(w.state[slot], outPtr >> 2); return w.seq[slot]; },
     WiiPollButtons: function (slot) { var w = window.__wii; return w ? w.buttons[slot] : 0; }   // gehaltene Tasten
   });
   ```
   ```csharp
   [DllImport("__Internal")] static extern int WiiReadState(int slot, float[] outBuf);
   [DllImport("__Internal")] static extern int WiiPollButtons(int slot);
   readonly float[] buf = new float[10]; readonly int[] lastSeq = new int[4]; readonly int[] held = new int[4];
   void Update() { for (int s = 0; s < 4; s++) { int seq = WiiReadState(s, buf); if (seq != 0 && seq != lastSeq[s]) { lastSeq[s] = seq; Apply(s, buf); }
     int b = WiiPollButtons(s); int pressed = b & ~held[s], released = held[s] & ~b; held[s] = b; if (pressed != 0) OnPressed(s, pressed); if (released != 0) OnReleased(s, released); } }
   public bool IsHeld(int slot, int button) { return (held[slot] & (1 << button)) != 0; }
   ```
   `SendMessage` nur für seltene Ereignisse (`OnPlayerJoined(slot)`, `OnPlayerLeft(slot)`).
8. **Telemetrie** (Grundlage für 09): alle 30 s den gewählten Pfad loggen (`console.info`, später Zähler im Signaling):
   ```js
   async function selectedPath(pc) { const st = await pc.getStats(); let pair; st.forEach(s => { if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) pair = s; });
     if (!pair) return 'none'; const l = st.get(pair.localCandidateId), r = st.get(pair.remoteCandidateId); return `${l.candidateType}/${l.protocol}->${r.candidateType}`; }
   ```

## Abnahmetest
1. Laptop `https://<LAN_IP>/` (Console) + Handy `https://<LAN_IP>/controller`: Code eingeben → Unity zeigt Bewegung; `selectedPath()` = `host/udp->host`.
2. Handy ohne WLAN, `https://<DOMAIN>/controller?forceRelay=1` (nach 04/06): `relay/udp->…`, Spiel spielbar.
3. iOS Safari und Android Chrome je einmal komplett durch; Berechtigungsdialog nur nach Klick; Display bleibt 5 min an.
4. Reconnect-Matrix in 08.

## Rollback
Reiner Client-Code – vorheriges Static-Release per Symlink (02/06).

## Stolperfallen
- `maxRetransmits` und `maxPacketLifeTime` gleichzeitig setzen wirft `SyntaxError`; Optionen gelten nur bei `createDataChannel`.
- Safari kennt `navigator.connection` nicht – Netzwechsel nur über `disconnected`/`failed` erkennen.
- iOS < 18.4 hält in Home-Screen-PWAs keinen Wake Lock → bei `navigator.standalone` und altem iOS Hinweis „im Safari-Tab öffnen“.
- Hintergrund-Tab: Browser frieren Timer ein und schließen WebSockets; nie auf `close`-Events allein vertrauen, `visibilitychange`/`pageshow` behandeln.
- `RTCPeerConnection` wirft bei `turn:`-URLs ohne `username`/`credential` – `iceServers` immer aus der Server-Nachricht übernehmen.
- Compose **merged** `volumes` aus `compose.yaml` und `compose.dev.yaml`; ohne `volumes: !override` im Dev-File landet `./out` in einem read-only `/srv` und Caddy startet nicht.
- Docker Desktop auf macOS kann `network_mode: host` nicht sauber – deshalb ist coturn lokal deaktiviert; Relay-Tests laufen gegen Prod.

## Nicht Teil dieses Plans
Server-Protokoll/Tokens → 03; coturn → 04; Testmatrix/Lasttest → 08; WebSocket-Fallback-Relay → 09.
