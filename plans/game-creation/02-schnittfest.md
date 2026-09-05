# 02 – Schnittfest (erstes Spiel, Speed-Slice-Variante)
**Ziel:** Erstes spielbares Motion-Spiel. Ein Objekt fliegt in die Bildmitte und bleibt hängen, dann zeigt ein Pfeil die Schnittrichtung (8 Richtungen, z. B. von oben nach unten oder von unten nach oben). Wer als Erster in dieser Richtung mit dem Handy schwingt, bekommt den Punkt; falsch oder zu früh ist ein sichtbarer Fail. 10 Objekte, dann Rangliste. 1–4 Spieler.
**Voraussetzungen:** Console/Controller vom Stand 2026-09-03 (`out/`), Plan 01 (Motion-Modus). Kein Unity: das Spiel läuft als Plain-JS-Kanal in der Console (`out/schnittfest.js`), pollt `window.__wii` genau wie `WiiInput.Update()`. Wenn Unity kommt, wandern `detector()` und `match()` 1:1 nach C#.
**Definition of Done:**
- [ ] Im Wii-Menü heißt Kachel 1 „Schnittfest“; Klick per Zeiger + A startet das Spiel mit allen verbundenen, kalibrierten Handys
- [ ] Ablauf nach Plan 01: Countdown → Spiel (Motion-Modus an, Zeiger aus) → Ergebnis (Motion-Modus aus, Zeiger an, „Nochmal“ / „Menü“)
- [ ] Schwung-Erkennung und Spielregeln sind reine Funktionen mit `node --test`-Check
- [ ] Fake-Controller kann Schwünge auslösen (`__fakeSwing(deg)`, Tasten `h`/`v`), E2E spielt eine verkürzte Partie durch
- [ ] Wii-Knopf mitten im Spiel: Spiel gestoppt, Handys entsperrt, Start-Screen

## Regeln
| Phase je Objekt | Dauer | Schwung in dieser Phase |
|---|---|---|
| `flyin` – Objekt fliegt von links/rechts/oben zur Mitte | 600 ms | ignoriert |
| `wait` – Objekt hängt, kein Pfeil | zufällig 1000–5000 ms, damit kein Rhythmus entsteht | **zu früh**: Fail-Anzeige („Zu früh!“ in Spielerfarbe), Spieler für dieses Objekt gesperrt |
| `cut` – Pfeil zeigt Zielrichtung | max. 2000 ms | richtig (±45°) → Punkt, Objekt gelöst; falsch → Fail-Anzeige („Daneben!“), Spieler gesperrt. Sind alle Spieler gesperrt → sofort `resolved` als „Niemand“ |
| `resolved` – Hälften fliegen auseinander bzw. Objekt fällt („Niemand“) | 700 ms | ignoriert |

- Zielrichtung: zufällig aus den 8 Pfeilrichtungen `[0, 45, 90, …, 315]`, mathematisch mit y nach oben: 0 = nach rechts, 90 = nach oben, 180 = nach links, 270 = nach unten (also „von oben nach unten“). Der Pfeil läuft durch das Objekt und zeigt mit der Spitze, wohin geschnitten wird. Nachbarrichtungen liegen 45° auseinander, ±45°: die nächstgelegene Richtung zählt.
- Winkelvergleich gerichtet, modulo 360: `diff = |((swing − target + 180) mod 360) − 180| ≤ 45`. Ein Hieb nach unten trifft „von oben nach unten“ und failt „von unten nach oben“.
- Der erste passende Schwung gewinnt (Ankunftszeit auf der Console). Gesperrt heißt: bis `resolved` keine weitere Wertung für diesen Spieler.
- 10 Objekte (`ROUNDS`), Rangliste nach Punkten, Gleichstand erlaubt. Spieler, der mitten im Spiel geht: bleibt in der Wertung, bekommt nur nichts mehr. Neuer Spieler mitten im Spiel: erst bei „Nochmal“ dabei.

## Schnitt-Erkennung (`detector`) und Schwert-Richtung
Ein Schnitt ist, wenn die Schwertspitze **schnell von außen durch das Objekt fährt**. Ausholen beginnt auf dem Objekt und führt von ihm weg, das ist kein Schnitt; erst der Rückweg durch das Objekt zählt. Gyroskop und Beschleunigung werden **nicht** benutzt (Ausholen und Schlag nicht unterscheidbar, Vorzeichen Raterei; echtes iPhone 2026-09-03). Das Gier/Nick-Differenzmodell des Zeigers reicht ebenfalls nicht: aufrecht gehaltenes Handy (Schwert-Griff) liegt in der Gimbal-Singularität, der Zeiger springt, nichts wird erkannt.

**Schwert-Richtung `d`** (Controller rechnet, Console bekommt sie im Frame an Index 7–9 statt der relativen Winkel): Aus `deviceorientation` folgt die Richtung der Handy-Längsachse in Weltkoordinaten ohne Gimbal-Problem, `gamma` (Rollen) spielt keine Rolle: `d_w = (−cos β·sin α, cos α·cos β, sin β)` (W3C-Rotationsmatrix, 2. Spalte). Beim Kalibrieren („Spitze auf die Bildschirmmitte“) bildet der Controller eine Basis: `y_ref = d_w`, `z_ref` = Welt-oben `(0,0,1)` orthogonalisiert gegen `y_ref` und normiert, `x_ref = y_ref × z_ref` (rechts). Je Frame sendet er `d = (d_w·x_ref, d_w·y_ref, d_w·z_ref)`: x = rechts, y = zur Bildschirmmitte, z = oben, Einheitsvektor. Zeiger auf der Console: `x = W/2 + D·dx/dy`, `y = H/2 − D·dz/dy` mit `dy ≥ cos 80°` geklemmt (exakte Strahlprojektion, ersetzt `−D·tan(alpha)` / `−D·tan(beta)`).

**Spitze relativ zur Ruhelage** (`Schnittfest.sword()` je Spieler, reine Funktion): `r` = Ruhelage, folgt `d` mit Zeitkonstante `REST_MS = 300` nur solange die Winkelgeschwindigkeit von `d` unter `REST_RATE = 60` °/s liegt, sonst eingefroren; Start `r = d`. Spitze auf dem Bildschirm: `tx = cx + G·(dx − rx)`, `ty = cy − G·(dz − rz)`, `G = 1,2·H`. Ruhe = Spitze auf dem Objekt, in jeder Haltung. Das Spiel zeichnet diese Spitze je Spieler in Spielerfarbe (kleiner Kreis plus kurzer Schweif); die normalen Zeiger (`.wii-pointer`) sind im Spiel wieder versteckt.

`detector(H).feed(tx, ty, nowMs, cx, cy, r)` bleibt wie gehabt: `speed` in Bildschirmhöhen/s, `inside`, scharf für `ARM_MS = 150` ms nach Eintritt von außen, Schnitt bei Abstand Mitte–Strecke ≤ `CUT_R = 0,7·r`, `speed ≥ SWING_SPEED = 2` H/s, kein Cooldown, (P₀ außerhalb oder scharf); `angle = atan2(−Δy, Δx)` auf `[0, 360)`; danach `SWING_COOLDOWN_MS = 300`.

Konstanten oben in `schnittfest.js`, `?swing=3` setzt `SWING_SPEED`. Debug-Zeile: Versionsstempel „Stand 17:33 · swing 2 · tol 45“, je Spieler „Spieler 1: 60 fps · letzter Schnitt: 4,1 H/s @ 270°“ (fps aus den `seq`-Wechseln, damit man am Handy-Test sieht, ob im Motion-Modus überhaupt Frames kommen). Am Controller liegt die Statuszeile (`#bar`: Status, Stand, fps) **über** dem Motion-Overlay.

## Schnittstellen (Vertrag für alle Teile)
```js
// out/schnittfest.js – klassisches Script (CSP: kein Modul, kein CDN). Am Ende:
// if (typeof module === 'object' && module.exports) module.exports = Schnittfest;
Schnittfest.detector(H)                    // → { feed(x, y, nowMs, cx, cy, r) → null | { angle, mag } }  (Pixel; mag = H/s)
Schnittfest.sword(G)                       // → { feed(dx, dy, dz, nowMs) → { x, y } }  Spitze relativ zur Ruhelage, in Pixeln um 0
Schnittfest.match(slots, opts)             // slots: [0, 2], opts: { rounds, rnd } (rnd für Tests deterministisch)
  .tick(nowMs)                             // treibt Phasen weiter; → Liste Events, z. B. { t:'cut', target }, { t:'hit', slot }, { t:'nobody' }, { t:'over', ranking }
  .swing(slot, angle, nowMs)               // → 'hit' | 'wrong' | 'early' | 'locked' | 'ignored'
  .state()                                 // { phase, round, target, scores: { slot: n }, lockedSlots, winner, objectFrom }
Schnittfest.start({ canvas, players: [{ slot, color }], rounds, onEnd(ranking) })   // rAF-Schleife, pollt __wii.state/seq je Spieler, zeichnet
Schnittfest.stop()                         // Schleife aus, Canvas leer
Schnittfest.debug()                        // { phase, target, last: { slot: { angle, mag, at } } } für E2E und Tuning
```
- `start` ruft **nicht** `__wii.motion` – Lebenszyklus gehört `index.html` (Plan 01, Schritt 2/3).
- Ranking: `[{ slot, score }]` absteigend sortiert.
- Controller (`?fake=1&hold=A,B`): `hold` sind Azimut/Elevation in Grad, `az = −A`, `el = B` (wie bisher: A ist der alte relative Gierwinkel), `d = (sin az·cos el, cos az·cos el, sin el)`. `window.__fakeSwing(deg)` fährt in 8 Frames auf einer Geraden **durch die hold-Richtung**: Frame k mit `s = −1 + 2k/7`, `az = az_hold + 25°·cos(deg)·s`, `el = el_hold + 25°·sin(deg)·s`, danach wieder `hold`; Tasten `h` → `__fakeSwing(0)`, `v` → `__fakeSwing(90)`.

## Schritte
1. **`out/schnittfest.js`** – `detector`, `match`, `start/stop/debug` wie oben. Zeichnen mit Canvas 2D: Objekt = Kreis (Radius ≈ 12 % der Höhe), im `cut` ein dicker Pfeil durch das Objekt in Zielrichtung (Schaft von der einen Seite bis über das Objekt hinaus, große Spitze am Ende), Treffer = zwei Halbkreise (Clip an der Schnittlinie), die senkrecht zur Linie auseinanderdriften und fallen; Spielerfarbe als kurzer Schriftzug „Spieler 2!“. Jeder erkannte Schwung (auch wrong/early/ignored) steht 900 ms als dünnerer Pfeil in Spielerfarbe vom Objektmittelpunkt aus im erkannten Winkel, mit Gradzahl am Ende – daran liest man die Achsen-Zuordnung ab. Fail = rotes ✕ am HUD-Feld des Spielers plus „Daneben!“ bzw. „Zu früh!“ unter dem Objekt in Spielerfarbe, bis `resolved` vorbei ist. HUD: Punktestand je Spieler in Spielerfarbe oben, Runde „3 / 10“. Countdown 3-2-1 vor dem ersten Objekt. Canvas füllt das Fenster (`devicePixelRatio`, `resize`).
2. **`out/schnittfest.test.cjs`** – `node --test out/schnittfest.test.cjs` (Verzeichnisform geht unter Node 24 nicht): Detektor erkennt eine synthetische Schwung-Salve mit Winkel ±5°, nichts unter der Schwelle, keinen Doppelschlag im Cooldown; `match` mit festem `rnd`: `early` sperrt, `wrong` sperrt, `hit` gibt Punkt und löst, zweiter richtiger Schwung ist `ignored`, nach `rounds` kommt `over` mit sortiertem Ranking.
3. **`out/index.html`** – neue Ansicht `view = 'game'`: `<div id="game" hidden>` mit `<canvas id="gc">` und Ergebnisbox (`#gresult`: Rangliste, Buttons `#again`, `#gmenu`). `render()` schaltet sie wie `#menu`. Kachel 1 im Grid wird „Schnittfest“ (`data-game="schnittfest"`); Klick: Spielerliste aus `slots` (verbunden + kalibriert), keine → `hint('Kein Handy kalibriert')`; sonst `view='game'`, `__wii.motion(true)`, `Schnittfest.start(...)`. `onEnd`: `__wii.motion(false)`, Ergebnisbox zeigen. „Nochmal“ = derselbe Klickpfad, „Menü“ = `view='menu'`. Wii-Knopf zusätzlich `Schnittfest.stop()`. Zeiger (`.wii-pointer`) bleiben im Spiel sichtbar (Schwertspitze), aber ohne Hover-Rahmen, Klick und Fadenkreuz; auf dem Ergebnis wieder normal.
4. **`out/controller.html`** – `__fakeSwing` + Tasten `h`/`v` in `startFake()` (Queue, die der 60-Hz-Ticker abarbeitet; sonst Nullen wie bisher).
5. **`e2e/e2e.cjs`** – neue Schritte nach der Kalibrierung: Start-Screen per Zeiger starten, Kachel „Schnittfest“ anklicken (Klickpfad wie `sample-1`, notfalls `.click()` auf der Kachel), `#game` sichtbar, Controller-Overlay sichtbar; warten bis `Schnittfest.debug().phase === 'cut'`, `__fakeSwing(target)` auf dem Controller, `scores[0] === 1`; mit `rounds` klein (Start-Option per `?rounds=2` in der Console) bis `over`; Ergebnisbox sichtbar, Overlay weg; „Menü“ klickt zurück ins Grid.
6. **README.md** ergänzen: Spiel starten, Fake-Schwünge, Tests. `plans/game-creation/README.md`: Zeile 02 auf `[x]`.

## Abnahmetest
1. Console + 1 Handy, Menü → „Schnittfest“: Handy schwarz, Countdown, Objekt fliegt ein. Pfeil nach unten: Hieb nach oben → rotes ✕ und „Daneben!“, Objekt fällt sofort (einziger Spieler gesperrt); Hieb nach unten → Punkt, Hälften fliegen auseinander.
2. Schwung vor dem Pfeil → „Zu früh!“, dieses Objekt bringt keinen Punkt mehr, das nächste wieder. Der Pfeil kommt spürbar unregelmäßig (1 bis 5 s).
3. 2 Handys: beide schwingen richtig, nur der Erste bekommt den Punkt.
4. Nach 10 Objekten Rangliste, Handy entsperrt, „Nochmal“ startet sofort neu, „Menü“ zurück ins Grid.
5. Wii-Knopf mitten im Spiel → Start-Screen, Handys entsperrt.
6. `node --test out/schnittfest.test.cjs` grün, `NODE_PATH=$(npm root -g) node e2e/e2e.cjs` grün.

## Rollback
Alles liegt in `out/` und `e2e/`; `schnittfest.js` löschen, Kachel-Schleife in `index.html` und `startFake()` im Controller auf den Stand vor Plan 02 setzen. Server und Brücke sind unberührt.

## Stolperfallen
- `__wii.state[slot]` ist ein `Float32Array`, das bei jedem Frame ersetzt wird; nicht cachen, je rAF-Tick über `__wii.seq[slot]` prüfen, ob ein neuer Frame da ist. Nur kalibrierte Slots pollen (Bit 0 in den Frame-Flags setzt die Console als `s.cal`).
- Latenz Handy → Console 30–80 ms: für alle gleich, das Ranking bleibt fair. Deshalb hängt das Objekt, statt durchzufliegen.
- Schwelle `SWING_SPEED = 2` H/s ist ein Startwert. Zählt langsames Zurücklegen der Spitze als Schnitt → höher; zügige Schnitte werden nicht erkannt → tiefer. Die Debug-Zeile im Spiel zeigt die Werte.
- Geschichte: Beschleunigung (Vorzeichen kippt beim Bremsen, iOS invertiert) und Drehrate (Ausholen sieht aus wie ein Schlag in Gegenrichtung) sind beide am echten iPhone gescheitert (2026-09-03). Nicht wieder darauf zurück.
- Yaw (`alpha`) driftet über Minuten: der normale Zeiger wandert, die Spiel-Spitze nicht (sie ist relativ zur Ruhelage). Für Menü und Ergebnis: entsperren (2 s halten), „Neu kalibrieren“, sperren.
- Frame-Layout ist jetzt `[t, ax, ay, az, rx, ry, rz, dx, dy, dz]`; `WiiInput.cs`, `Wii.jslib`, Server-Setup Plan 05 und README nennen das Layout und sind nachzuziehen.
- CSP erlaubt nur `script-src 'self' 'unsafe-inline'`: `schnittfest.js` als `<script src="/schnittfest.js">` einbinden, keine Module, kein CDN.
- Headless-Chromium sendet ohne `fake=1` keinen einzigen Sensor-Frame; im E2E immer `fake=1&hold=…`.

## Nicht Teil dieses Plans
Unity-Port, Sound, eigener Lobby-Screen, verschiedene Objektarten, Bestenliste über Partien hinweg, Zuschauer.
