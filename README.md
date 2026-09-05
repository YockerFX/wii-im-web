# Wii im Web – Prototyp

Handys als Controller (WebRTC DataChannel) → Console im Laptop-Browser. Code:
- `signaling/` – Room-Server (Node 24 + ws), Plan 03. `npm test` = 16 Tests.
- `out/` – Console (`index.html`), Controller (`controller.html`), gemeinsames `wii.js`, Plan 05. Statische Dateien, kein Build. Controller ist hochkant (Querformat zeigt ein Overlay), der Raum-Code wird über eine Bildschirm-Tastatur eingegeben statt getippt (getippter Text legt einen iOS-Undo-Verlauf an, und ein Hieb im Spiel gilt als Schütteln → „Eingabe widerrufen“-Dialog), und kalibriert nach jedem Join/Resume einmal: erst danach fließen Frames, Richtungsvektor der Handy-Längsachse in der Kalibrier-Basis, Frame-Flag Bit 0 = kalibriert, „Neu kalibrieren“ = Recenter. Kalibriert wird, indem die Handy-Spitze auf die Bildschirmmitte zeigt (die Console blendet dafür ein Fadenkreuz ein). Danach zeigt der Zeiger dorthin, wohin die Spitze zeigt: Strahlprojektion mit virtueller Entfernung 0,87 Bildbreite (≈ ±30° Gieren für die halbe Breite), leicht geglättet; Taste A klickt das Element darunter, Beispiel-Buttons und ein Textfeld zum Ausprobieren liegen über dem Canvas. `__wii.pointer[slot]` liefert die normierte Position für Unity.
- `unity/` – `Wii.jslib` + `WiiInput.cs`: Unity pollt `window.__wii` (Plan 05, Schritt 7). Solange kein Unity-Build da ist, zeigt die Console einen Canvas.
- `out/schnittfest.js` – erstes Spiel (Game-Creation, Plan 02): Wii-Menü → Kachel „Schnittfest“. Objekt hängt in der Mitte, nach 1–5 s Zufall zeigt ein Pfeil die Schnittrichtung (8 Richtungen, z. B. von oben nach unten), der Zeiger ist die Schwertspitze: wer sie als Erster schnell von außen in Pfeilrichtung durch das Objekt fährt (±45°), bekommt den Punkt, falsch oder zu früh ist ein Fail; 10 Objekte, dann Rangliste. Schwelle `SWING_SPEED = 2` Bildschirmhöhen/s per `?swing=3` an der Console übersteuerbar, `?rounds=2` verkürzt die Partie. Fake-Controller: Tasten `h`/`v` oder `__fakeSwing(grad)` lösen Schwünge aus.
- `out/fruitninja.js` – zweites Spiel (Game-Creation, Plan 03): Wii-Menü → Kachel „Fruit Ninja“, ein Spieler (der kleinste kalibrierte Slot, die anderen Handys bleiben gesperrt). Früchte und Bomben fliegen von unten ins Bild, steigen bis 75–95 % der Höhe und fallen wieder heraus; die Klinge sitzt am Zeiger und ist immer sichtbar, ein schneller Hieb (≥ `SWING_SPEED = 2` Bildschirmhöhen/s, `?swing=3` übersteuert) halbiert die Frucht – die 3D-Hälften entstehen per Clipping-Ebene, nicht per Mesh-Schnitt. Verpasste Frucht kostet eins von 3 Leben, eine geschnittene Bombe beendet sofort; `?lives=1` kürzt die Partie (E2E). Gerendert mit three.js in `#g3d`, das HUD (Punkte, Leben, Klinge) liegt als transparentes 2D-Canvas darüber.
- `out/vendor/` – three.js r185 aus `npm pack three@0.185.1`, nur `three.module.min.js`, `three.core.min.js` (relativer Import des Moduls, muss daneben liegen) und `three.LICENSE`. Kein CDN, kein Bundler: `index.html` importiert das ESM-Modul einmal per `<script type="module">` und legt es als `window.THREE` ab, damit `fruitninja.js` ein klassisches Script bleiben kann.
- Rest im Root (Compose, Caddyfiles, coturn, Skripte) = Vorlagen aus `plans/server-setup/files/`, für Prod nach den Plänen 01–08 ausfüllen.

## Lokal ohne Docker (zwei Browser-Tabs, kein Handy)
```sh
cd signaling && npm install
PORT=8090 STATIC_DIR=../out ALLOWED_ORIGINS=http://localhost:8090 TURN_SECRET=dev TURN_HOST=localhost node server.js
```
Console: http://localhost:8090/ → „Raum erstellen“. Controller-Simulation im zweiten Tab: http://localhost:8090/controller?room=CODE&fake=1 (Port 8080 ist auf diesem Mac von Docker Desktop belegt).

## Mit echtem Handy (HTTPS im Heimnetz)
```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build      # Caddy + signaling, Static aus ./out
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt   # Root-CA aufs Handy (Plan 05, Schritt 1)
```
Laptop: https://<LAN_IP>/ – Handy: https://<LAN_IP>/controller (Code eintippen, „Start“). `<LAN_IP>` steht in `.env` und `Caddyfile.dev`; bei neuer IP beide anpassen. Relay/TURN gibt es lokal nicht (coturn aus), erst gegen den VPS.

## Live-Test (öffentliche URL, Handy überall)
```sh
scripts/live.sh          # cloudflared Quick Tunnel + signaling, druckt die URL
```
Echtes Zertifikat, also keine Root-CA aufs Handy. Bei jedem Start neue Zufalls-URL; feste Domain erst mit den Plänen 01/02 auf dem VPS. Der Laptop kann die Console auch über http://localhost:8090/ öffnen.

Der Tunnel läuft über http2 (TCP 443; `CF_PROTOCOL=quic` schaltet zurück) und überlebt weder Netzwechsel noch Standby: ist er ~2 min nicht registriert, startet `live.sh` ihn selbst neu und druckt eine **neue URL** (Handys neu scannen). Nach dem Umzug Heim → Büro also `live.sh` neu starten bzw. laufen lassen, nicht die alte URL weiterbenutzen.

Ohne coturn gibt es nur STUN (`stun.cloudflare.com`). Kommt WebRTC nicht durch das NAT (Büro-WLAN mit Client-Isolation, symmetrisches NAT), schaltet der Controller nach 8 s ohne Verbindung bzw. drei erfolglosen ICE-Restarts auf **Relay über die Signaling-WebSocket** um (Statuszeile: „Relay über Server“, Console-Tabelle: `relay`): Sensor-Frames binär mit Slot-Byte, Events als `{t:'relay'}`. Höhere Latenz, kommt aber überall durch; Zeiger, Spieler-LED und Spielstart funktionieren im Relay genauso. Relay bleibt bis zum nächsten Beitritt/Reload. Erzwingen zum Testen: `/controller?room=CODE&relay=1`. Mit coturn auf dem VPS (Plan 04) ist der Weg wieder WebRTC.

Ein Abriss nur des Signalings (WLAN-Wechsel, Tunnel-Hänger) lässt eine verbundene PeerConnection auf beiden Seiten stehen; neu verhandelt wird nur, wenn der Controller wirklich eine neue hat (`resume` mit `fresh`, Server reicht es als `peer-joined.fresh` an die Console).

## Prüfen
```sh
cd signaling && npm test                                  # Server-Protokoll, Reconnect, Limits
node --test out/schnittfest.test.cjs out/fruitninja.test.cjs   # Schwung-Erkennung, Wurf, Treffertest und Spielregeln beider Spiele
NODE_PATH=$(npm root -g) node e2e/e2e.cjs                 # Browser-E2E (Playwright global) gegen den laufenden Docker-Dev-Stack; startet zwischendurch den signaling-Container neu (R1) und spielt Schnittfest und Fruit Ninja durch (WebGL per SwiftShader)
```
