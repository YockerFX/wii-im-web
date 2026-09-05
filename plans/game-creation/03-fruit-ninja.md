# 03 – Fruit Ninja (3D, three.js, Single-Player mit Leben)
**Ziel:** Zweites Motion-Spiel, ein Spieler. Früchte und Bomben werden von unten ins Bild geworfen, steigen mindestens bis 75 % der Bildhöhe und fallen wieder unten raus. Die Klinge sitzt am Zeiger des Spielers und ist immer sichtbar; eine schnelle Bewegung durch eine Frucht halbiert sie (3D-Hälften fliegen auseinander). Verpasste Frucht kostet ein Leben, Bombe beendet das Spiel. 3 Leben, dann Ergebnis. Gerendert mit three.js, Früchte als prozedurale 3D-Körper (keine Modell-Dateien).
**Voraussetzungen:** Console/Controller vom Stand 2026-09-03 (`out/`), Plan 01 (Lebenszyklus), Plan 02 nur für `__fakeSwing` im Fake-Controller und den Spielpfad in `index.html`. Netz für `npm pack three` einmalig. Kein Unity.
**Definition of Done:**
- [ ] Kachel 2 im Wii-Menü heißt „Fruit Ninja“; Klick per Zeiger + A startet das Spiel mit dem ersten kalibrierten Handy (kleinster Slot)
- [ ] Ablauf nach Plan 01: Countdown → Spiel (Motion-Modus an) → Ergebnis (Motion-Modus aus, „Nochmal“ / „Menü“)
- [ ] Klinge (Kreis + Spur in Spielerfarbe) ist während des ganzen Spiels am Zeiger sichtbar, auch in Ruhe
- [ ] Jedes Objekt erreicht seinen Scheitel bei 75–95 % der Bildhöhe (von der Unterkante gemessen), Scheitel liegt seitlich im Bild
- [ ] Physik, Wurf, Treffertest und Wertung sind reine Funktionen ohne three.js mit `node --test`-Check
- [ ] three.js liegt unter `out/vendor/`, keine CDN, keine Bundler; Console läuft weiter ohne Build-Schritt
- [ ] E2E spielt eine Partie mit `?lives=1` bis zum Ergebnis durch (Start, Objekte erscheinen, verpasste Frucht → Ergebnis, Menü)
- [ ] Wii-Knopf mitten im Spiel: Spiel gestoppt, Handys entsperrt, Start-Screen

## Regeln
| Was | Wert | Wo |
|---|---|---|
| Leben | `LIVES = 3` (`?lives=1` für E2E), HUD oben rechts drei ✕-Felder, verlorene rot | `match` |
| Frucht geschnitten | +1, Saft-Spritzer, „+1“ am Schnittpunkt | `match.slice` |
| Combo | ≥ 3 Früchte binnen `COMBO_MS = 250` → +2 extra, HUD „Combo ×3!“ | `match.slice` |
| Frucht verpasst | fällt ungeschnitten unter die Unterkante → −1 Leben, rotes ✕ blinkt; Hälften und Bomben zählen nicht als verpasst | `match.tick` |
| Bombe geschnitten | sofort `over`, roter Vollbild-Blitz 300 ms, HUD „Bombe!“ | `match.slice` |
| Spielende | Leben 0 oder Bombe → Event `over` mit Ranking `[{ slot, score }]` (ein Eintrag) | `match.tick` / `slice` |
| Wellen | alle `WAVE_MS` 1400 → 700 ms (linear über die ersten 90 s, danach konstant), 1–4 Objekte, Versatz 0–300 ms, `BOMB_P = 0.15`, nie mehr als `MAX_LIVE = 12` Objekte gleichzeitig | `match.tick` |
| Wurf | Start knapp unter der Unterkante bei x ∈ [0,15; 0,85]·W, Scheitel bei Höhe h ∈ [0,75; 0,95]·H über der Unterkante und x ∈ [0,2; 0,8]·W; `vy = √(2·G·Δy)`, `vx = Δx / (vy/G)` | `launch` |
| Welt | Spielebene z = 0, Höhe `H_WORLD = 10`, Breite nach Seitenverhältnis, `G = 12` Einheiten/s², Frucht `R = 0,8`, Bombe `R = 0,7`, Drall 1–4 rad/s um zufällige Achse | Konstanten oben in `fruitninja.js` |
| Schnitt | Zeiger bewegt sich ≥ `SWING_SPEED = 2` H/s (`?swing=`) und die Strecke alter→neuer Zeiger kommt dem Objektmittelpunkt (in Pixeln) näher als `R` | `sliceTest` |

Alle Objekte fliegen in der Ebene z = 0, der Treffertest ist 2D in Pixeln: `px = W/2 + x·s`, `py = H/2 − y·s`, `s = H_px / H_WORLD`. Die Kamera schaut frontal auf die Ebene; ihr Abstand ist so gewählt, dass bei z = 0 genau `H_WORLD` sichtbar ist (`d = (H_WORLD/2) / tan(fov/2)`, `fov = 50°`). Dadurch stimmt der Pixelmaßstab exakt, 3D kommt aus Drall, Licht und den Hälften.

## Rendering (three.js, prozedural)
- **three.js r185 vendored:** `npm pack three@0.185.1` im Scratch-Ordner, aus dem Tarball `build/three.module.min.js`, `build/three.core.min.js` (das Modul importiert `./three.core.min.js`) und `LICENSE` als `out/vendor/three.LICENSE` nach `out/vendor/`. CSP `script-src 'self'` erlaubt ESM vom eigenen Origin. In `index.html`: `<script type="module">import * as THREE from '/vendor/three.module.min.js'; window.THREE = THREE;</script>`. `fruitninja.js` bleibt klassisches Script und fasst `window.THREE` erst in `start()` an (fehlt es → `hint`).
- **Warum three.js und nichts „Natives“:** Der Browser hat WebGL2 und WebGPU als native 3D-APIs; three.js ist eine dünne Schicht darüber (Matrizen, Shader, Szene). Rohes WebGL/WebGPU wäre bei 12 Objekten nicht schneller, nur viel mehr Code. Ruckelt es je, ist der Tausch auf `WebGPURenderer` aus demselben Paket ein Zeilenwechsel.
- **Szene:** `PerspectiveCamera(50)` bei `(0, 0, d)` auf den Ursprung, `HemisphereLight(#fff, #444, 0.8)` + `DirectionalLight` aus `(3, 5, 6)` Stärke 1.2, `WebGLRenderer({ canvas: canvas3d, alpha: true, antialias: true, powerPreference: 'high-performance' })`, `setPixelRatio(min(dpr, 2))`, `localClippingEnabled = true`, `resize` setzt Größe und `camera.aspect`. Hintergrund bleibt CSS (`#191919`).
- **Früchte** (eine `SphereGeometry(1, 32, 24)` für alle, Skalierung auf der Gruppe):

| kind | Schale | Skalierung | Fruchtfleisch | Extra |
|---|---|---|---|---|
| apple | `#d3262b`, roughness 0.5 | 1 / 1 / 1 | `#f4e9c8` | Stiel: `CylinderGeometry(0.05, 0.05, 0.35)` braun oben |
| orange | `#f57f17`, roughness 0.9 | 1 / 1 / 1 | `#ffb347` | – |
| melon | `CanvasTexture` mit dunkelgrünen Streifen auf `#2e8b3d` | 1.35 / 1 / 1 | `#e0323c` | – |
| lemon | `#f5d800`, roughness 0.6 | 1.25 / 0.9 / 0.9 | `#fff3a0` | – |
| bomb | `#222`, metalness 0.6, R 0.7 | 1 / 1 / 1 | – | Lunte: kurzer grauer Zylinder oben, Funke: `emissive` orange Kugel r 0.08, `emissiveIntensity` flackert |

- Jedes Objekt ist eine `Group` (Position, Quaternion, Skalierung) mit zwei Meshes über derselben Geometrie: **Schale** (`FrontSide`, Schalenfarbe) und **Fruchtfleisch** (`BackSide`, Fleischfarbe, roughness 1). Ungeschnitten hat keins eine Clipping-Ebene.
- **Halbieren ohne Mesh-Cutting:** Beim Schnitt mit Bildschirmwinkel θ ist die Schnittnormale `n = (−sin θ, cos θ, 0)`. Zwei neue Gruppen derselben Fabrik (`makeObject(kind)`, eigene Materialien), gleiche Position/Quaternion/Skalierung; Hälfte 1 bekommt `clippingPlanes = [plane(n)]`, Hälfte 2 `[plane(−n)]` auf **beiden** Meshes. Das `BackSide`-Fleisch wird durch die Öffnung sichtbar und wirkt frontal wie ein Schnittdeckel; kein Deckel, keine CSG. Je Hälfte einmal `nLocal = n · quaternion⁻¹`; je Frame `plane.normal = nLocal · quaternion`, `plane.constant = −normal · position`. Hälften: `vx ± 1.5·n.x`, `vy` behalten, Drall ±3 rad/s um `n`, unten raus → weg (kein Lebensverlust). Original-Gruppe entfernen. Bombe: kein Halbieren, Blitz + `over`.
- **Kein Modell-Import:** Alles prozedural. GLTF-Modelle wären später ein Tausch der Fabrik (`GLTFLoader` aus `three/examples/jsm/` per ESM), nicht Teil dieses Plans.
- `// ponytail:` alle Objekte bei z = 0; Fleisch-Innenseite statt Schnittdeckel; Geometrien werden geteilt, Materialien je Objekt (Clipping ist Material-Eigenschaft) – bei `MAX_LIVE = 12` egal.

## HUD, Klinge, Eingabe
- Zwei Canvases in `#game`: `<canvas id="g3d">` (WebGL, zuerst im DOM) und darüber das bestehende `<canvas id="gc">` (2D, transparent, je Frame geleert; `pointer-events: none`). Beide füllen das Fenster wie in Plan 02 (`devicePixelRatio`, `resize`).
- **Klinge = Zeiger.** Die Console rechnet `__wii.pointer[slot] = [x/W, y/H]` in jedem Frame auch im Spiel (`updatePointers`, geglättet, geklemmt); nur das Hand-Icon ist im Spiel versteckt. Das Spiel liest diesen Wert je rAF-Tick, zeichnet dort **immer** die Klinge (Kreis r 10 px in Spielerfarbe mit weißem Rand, dahinter die Spur der letzten 12 Positionen mit auslaufender Breite) und rechnet die Strecke alter→neuer Zeiger, `speed` in H/s. Bei `speed ≥ SWING_SPEED` `sliceTest` gegen alle lebenden Objekte, Schnittwinkel `atan2(−Δy, Δx)`. Kein `Schnittfest.sword()`: Fruit Ninja will zielen, nicht aus der Ruhelage hauen.
- Andere verbundene Handys bekommen keine Klinge; ihr Motion-Modus wird von `index.html` trotzdem gesetzt (gleicher Pfad wie Plan 02), das stört nicht.
- HUD: Punkte oben links in Spielerfarbe, Leben oben rechts (drei ✕, verlorene rot), Countdown 3-2-1, schwebende Texte („+1“, „Combo ×3! +2“, „Bombe!“) 800 ms, Saft-Spritzer: Kreis in Fleischfarbe 400 ms ausblendend am Schnittpunkt, Bombe: roter Vollbild-Blitz 300 ms. Debug-Zeile wie Plan 02: „Stand HH:MM · swing 2 · live 7 · 60 fps“ und „letzter Schnitt: 4,1 H/s @ 270°“.
- `start` ruft **nicht** `__wii.motion` (Plan 01 gehört `index.html`).

## Schnittstellen (Vertrag für alle Teile)
```js
// out/fruitninja.js – klassisches Script (kein Modul). window.THREE erst in start(). Am Ende:
// if (typeof module === 'object' && module.exports) module.exports = FruitNinja;
FruitNinja.launch(rnd, view)            // view { W, H } Weltmaße → { x, y, vx, vy }; Scheitel 75–95 % H über der Unterkante
FruitNinja.step(obj, dt)                // Schwerkraft + Drall, mutiert obj; obj.gone = true unter der Unterkante
FruitNinja.sliceTest(p0, p1, c, r)      // Strecke p0→p1 (Pixel) kommt Kreis (c, r) näher als r → bool
FruitNinja.match(slot, opts)            // opts { lives, rnd, W, H }
  .tick(nowMs)                          // Countdown, Wellen, Physik → Events [{t:'spawn',obj},{t:'miss',id,lives},{t:'gone',id},{t:'over',ranking}]
  .slice(id, angleDeg, nowMs)           // → 'fruit' | 'combo' | 'bomb' | 'ignored'; Hälften erscheinen als neue Objekte in state().live
  .state()                              // { phase: 'countdown'|'play'|'over', lives, score, live: [obj], elapsed }
FruitNinja.start({ canvas3d, canvas, players: [{ slot, color }], lives, onEnd(ranking) })  // nutzt players[0]; rAF-Schleife, pollt __wii.pointer, rendert
FruitNinja.stop()                       // Schleife aus, Szene geleert, Renderer bleibt (Wiederverwendung bei „Nochmal“)
FruitNinja.debug()                      // { phase, lives, score, live: [{ id, kind, px, py }], spawned, sliced, missed, renderer: 'webgl', tip: { x, y }, last: { angle, mag, at }, fps }
```
- `obj`: `{ id, kind, x, y, vx, vy, r, axis: [ax, ay, az], w, angle, half?: 1|-1, n?: [nx, ny, nz], gone }` – ohne three.js-Typen, damit `match` in Node läuft. Der Renderer hält `Map id → Group` und spiegelt je Frame Position und `quaternion.setFromAxisAngle(axis, angle)`.
- Ranking `[{ slot, score }]` mit einem Eintrag, damit `endGame` in `index.html` unverändert passt.

## Schritte
1. **`out/vendor/`** – three.js wie oben ablegen (drei Dateien). Kontrolle: `https://localhost/vendor/three.module.min.js` liefert `text/javascript`, Konsole zeigt `THREE.REVISION === '185'`.
2. **`out/fruitninja.js`** – Konstanten, `launch`, `step`, `sliceTest`, `match` (rein), dann `start/stop/debug` mit Szene, Fabrik `makeObject(kind)`, Halbieren, HUD, Klinge. Nach jedem `stop()` sind Szene und `Map` leer, `renderer` bleibt.
3. **`out/fruitninja.test.cjs`** – `node --test out/fruitninja.test.cjs`: `launch` mit festem `rnd` 200× → Scheitel `(y0 + vy²/(2G) + H/2) / H` ∈ [0,75; 0,95], Scheitel-x ∈ [0,2; 0,8]·W, Start unter der Unterkante; `step` steigt, fällt, `gone`; `sliceTest` trifft durch die Mitte, tangential außen nicht, Strecke mit beiden Enden außerhalb aber durch den Kreis trifft; `match`: `tick` spawnt nie über `MAX_LIVE`, Frucht +1, drei Früchte binnen 250 ms → `'combo'` und +2 extra, doppelter Schnitt derselben id → `'ignored'`, ungeschnittene Frucht unten raus → `miss` und Leben −1, Hälfte unten raus → kein `miss`, Leben 0 → genau ein `over`, Bombe → sofort `over`, danach kein `spawn` und `slice` → `'ignored'`.
4. **`out/index.html`** – `<canvas id="g3d">` vor `#gc` in `#game`, CSS beide absolut und fensterfüllend, `#gc` mit `pointer-events: none`; Modul-Shim für `window.THREE`; `<script src="/fruitninja.js">`. Kachel 2 → „Fruit Ninja“ (`data-game="fruitninja"`, Klick `startGame`). `startGame` wird spielneutral: `GAMES = { schnittfest: 'Schnittfest', fruitninja: 'FruitNinja' }`, `current = window[GAMES[name]]`, Name aus `dataset.game`, „Nochmal“ startet das zuletzt gespielte; Optionen `rounds` und `lives` (`?lives=1`) werden beide übergeben, jedes Spiel ignoriert die fremde. `leaveGame` ruft `current.stop()`. `endGame` und `updatePointers` bleiben unverändert.
5. **`e2e/e2e.cjs`** – `chromium.launch({ headless: true, args: ['--enable-unsafe-swiftshader'] })`; neue Schritte nach Schnittfest: Console mit `?lives=1` öffnen, Kachel „Fruit Ninja“ per `aimClick`, `#g3d` sichtbar, `debug().renderer === 'webgl'`, `debug().tip` gesetzt, `spawned ≥ 1` binnen 3 s, `phase === 'over'` binnen 8 s (erste verpasste Frucht), `#gresult` sichtbar mit einem Eintrag, Controller-Overlay weg, „Menü“ zurück ins Grid.
6. **README.md** (Spiel starten, `?lives`, `?swing`, Tests, Vendor-Herkunft) und `plans/game-creation/README.md`: Zeile 03 auf `[x]`.

## Abnahmetest
1. Console + 1 Handy, Menü → „Fruit Ninja“: Handy schwarz, Countdown, Klinge steht sofort dort, wohin das Handy zeigt, und bleibt sichtbar. Früchte fliegen von unten ein, drehen sich, erreichen sichtbar mindestens Dreiviertelhöhe, fallen unten raus.
2. Schneller Hieb durch eine Frucht → zwei Hälften mit farbigem Inneren fliegen auseinander, „+1“. Langsames Führen der Klinge durch eine Frucht → nichts.
3. Ein Hieb durch drei Früchte → „Combo ×3! +2“. Frucht durchfallen lassen → ein ✕ rot. Drittes ✕ → Ergebnis mit Punktzahl.
4. Bombe schneiden → roter Blitz, sofort Ergebnis.
5. Zweites Handy verbunden: gesperrt, keine zweite Klinge, keine Wertung.
6. Ergebnis: Handy entsperrt, „Nochmal“ startet sofort neu (kein zweiter WebGL-Kontext, keine Konsolenwarnung), „Menü“ zurück ins Grid. Wii-Knopf mitten im Spiel → Start-Screen, Handy entsperrt.
7. `node --test out/schnittfest.test.cjs out/fruitninja.test.cjs` grün, `NODE_PATH=$(npm root -g) node e2e/e2e.cjs` grün. Debug-Zeile bei 12 Objekten: fps bleibt bei 60.

## Rollback
`out/fruitninja.js`, `out/fruitninja.test.cjs`, `out/vendor/` löschen; Kachel-Schleife, `startGame`/`leaveGame` und das `#game`-Markup in `index.html` sowie die E2E-Schritte auf den Stand von Plan 02 setzen. Schnittfest, Controller, Server und Brücke sind unberührt.

## Stolperfallen
- three.js hat seit r160 keinen UMD-Build mehr; nur ESM. Deshalb der Modul-Shim auf `window.THREE`. Module laden deferred: `FruitNinja.start` darf THREE nicht beim Script-Laden anfassen.
- `three.module.min.js` importiert relativ `./three.core.min.js` – beide Dateien müssen im selben Ordner liegen, sonst 404 und ein leeres `THREE`.
- Clipping-Ebenen sind Welt-Koordinaten und wandern nicht mit dem Objekt: die zwei Zeilen pro Hälfte und Frame sind Pflicht, sonst „frisst“ die feste Ebene die fliegende Hälfte auf.
- `WebGLRenderer` nur einmal anlegen (in `start`, wenn noch keiner da); mehr als 16 Kontexte pro Tab werfen Chrome-Warnungen und der älteste stirbt.
- Headless-Chromium ohne `--enable-unsafe-swiftshader` liefert keinen WebGL-Kontext → three wirft „Error creating WebGL context“. Falls es weiter fehlschlägt: zusätzlich `--use-angle=swiftshader`.
- Ein fetter Hieb erzeugt bei 60 Hz Sensorrate Strecken von mehreren hundert Pixeln pro Frame; der Streckentest (nicht Punkt-in-Kreis) ist deshalb Pflicht, sonst werden schnelle Schnitte übersprungen.
- Der Zeiger ist absolut: Gier-Drift (`alpha`) über Minuten wandert die Klinge seitlich. Sichtbar am Zeiger selbst; Abhilfe wie im Menü: entsperren (2 s halten), „Neu kalibrieren“, sperren. Am Bildrand ist der Zeiger geklemmt – Früchte am äußersten Rand sind absichtlich nicht vorgesehen (Scheitel-x 20–80 %).
- `__wii.pointer[slot]` kann `null` sein (Handy weg, nicht kalibriert): Klinge ausblenden, keine Strecke bilden, beim nächsten Wert neu starten (sonst ein Riesen-Hieb quer über den Schirm).
- `MAX_LIVE = 12` ist die Performance-Decke für die Fleisch-plus-Schale-Doppelmeshes. Ruckelt es auf dem Mac trotzdem: erst `setPixelRatio(1)`, dann Segmente der Kugel auf 24/16, zuletzt `WebGPURenderer`.
- Gleiche Regeln wie Plan 02: nur kalibrierte Slots pollen, kein Textfeld auf dem Handy.

## Nicht Teil dieses Plans
Mehrspieler und Zeit-Modus (Rangliste), GLTF-Modelle, Sound, Partikel-Explosion der Bombe, Bestenliste über Partien, E2E-Treffer (deckt der `node --test`-Check), Unity-Port.
