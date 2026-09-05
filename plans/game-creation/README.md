# Game-Creation „Wii im Web“ – Teilpläne

Spiele laufen als Unity-WebGL-Build in der Console (`out/index.html`) (bisher Plain-JS/three.js, Unity später), die Handys sind Controller. Die Brücke (`unity/Wii.jslib`, `unity/WiiInput.cs`) liefert Sensoren, Tasten und den Motion-Modus – siehe Server-Setup, Plan 05.

## So benutzen
- Immer nur einen Teilplan laden. Jeder ist eigenständig: Ziel, Voraussetzungen, Definition of Done, Schritte, Abnahmetest, Stolperfallen.
- Ablauf-Regeln, die für **jedes** Spiel gelten, stehen in 01. Ein neues Spiel fängt dort an.

| # | Teilplan | hängt ab von | Status |
|---|---|---|---|
| 01 | `01-lebenszyklus-motion-modus.md` Phasen Pre-Game / Game / Post-Game, Motion-Modus an und aus | Server-Setup 05 | [x] Brücke fertig (2026-09-03) |
| 02 | `02-schnittfest.md` erstes Spiel: Objekt hängt, Linie zeigt Richtung, erster richtiger Schwung gewinnt (Plain-JS in der Console, kein Unity) | 01 | [x] fertig 2026-09-03, Schwelle am echten Handy nachziehen |
| 03 | `03-fruit-ninja.md` Fruit Ninja in 3D (three.js, prozedurale Früchte): Single-Player, Klinge am Zeiger, Objekte von unten bis 75–95 % Höhe, Halbieren per Clipping, 3 Leben, Bombe = Aus | 01, 02 (Spielpfad, `__fakeSwing`) | [x] fertig 2026-09-04 |
