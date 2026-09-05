# 01 – Spiel-Lebenszyklus und Motion-Modus
**Ziel:** Jedes Spiel hält denselben Ablauf ein. Vor und nach dem Spiel bedienen die Spieler die Console mit Zeiger und Tasten; während des Spiels ist auf dem Handy der Motion-Modus aktiv (schwarzes Overlay, Touch gesperrt), damit bei Bewegungssteuerung kein versehentlicher Tipp etwas auslöst.
**Voraussetzungen:** Brücke aus Server-Setup 05 im Unity-Projekt (`WiiInput`-GameObject, `Wii.jslib` unter `Assets/Plugins/WebGL/`). Controller und Console vom Stand 2026-09-03 oder neuer (`{t:"mode"}`-Nachricht, `__wii.motion()`).
**Definition of Done:**
- [ ] Spielstart ruft `SetMotionMode(true)`, Ergebnis-Screen ruft `SetMotionMode(false)` – genau einmal je Übergang
- [ ] Pre-Game-Screens (Start-Screen, Wii-Menü, Lobby, Countdown) und Post-Game-Screens (Ergebnis, Rangliste, „Nochmal“) laufen ohne Motion-Modus
- [ ] Im Spiel wird keine Taste benötigt, die nur per Touch erreichbar ist
- [ ] Handy-Reload mitten im Spiel: nach Beitreten und Kalibrieren ist das Overlay von selbst wieder da

## Phasen
| Phase | Screens | Eingabe | Motion-Modus |
|---|---|---|---|
| Pre-Game | Start-Screen (Spieler 1 drückt Start), Wii-Menü, Spiel-Lobby, Countdown | Zeiger + Tasten A/B/1/2 | aus |
| Game | das eigentliche Spiel | nur Sensoren (`WiiReadState`), Tasten nicht vorausgesetzt | **an** |
| Post-Game | Ergebnis, Rangliste, „Nochmal“ / „Zurück zum Menü“ | Zeiger + Tasten | aus |

## Schritte
1. **Phasen im Spiel benennen** – eine Zustandsmaschine oder drei Szenen (Lobby, Game, Result). Übergänge laufen an genau einer Stelle durch, nicht verstreut in Buttons.
2. **Beim Übergang Lobby → Game:** `GetComponent<WiiInput>().SetMotionMode(true)` (Editor: Stub, nichts passiert). Die Console schickt `{t:"mode", motion:true}` an alle verbundenen Handys, das Overlay erscheint.
3. **Beim Übergang Game → Result:** `SetMotionMode(false)`. Danach dürfen Zeiger-Klicks wieder Buttons treffen („Nochmal“, „Menü“).
4. **Pause im Spiel** (optional): Pause-Menü braucht den Zeiger → beim Öffnen `SetMotionMode(false)`, beim Fortsetzen `true`. Ohne Pause-Menü: weglassen.
5. **Spielsteuerung ohne Tasten auslegen:** Start, Wurf, Schlag usw. aus Bewegung ableiten (Beschleunigung `ax ay az`, Drehrate `rx ry rz`, Lage `alpha beta gamma`). Braucht das Spiel zwingend eine Taste, dann ist es kein Motion-only-Spiel: Motion-Modus weglassen und die Tasten-Flanken `OnPressed`/`OnReleased` bzw. `IsHeld` nutzen.
6. **Zurück zum Menü:** Der Wii-Knopf der Console setzt den Modus zusätzlich auf aus – ein Spiel, das ohne Result-Screen abbricht, lässt die Handys trotzdem nicht gesperrt.

## Was die Brücke von allein macht
- Console merkt sich den Modus und schickt ihn jedem Handy erneut, dessen Event-Kanal neu aufgeht (Reconnect mitten im Spiel).
- Handy speichert den gewünschten Modus in `sessionStorage` (`wii.lock`). Aktiv wird er erst, wenn der Spiel-View sichtbar ist – Beitreten und Kalibrieren brauchen den Touch.
- Resume ohne Reload (Signaling weg und wieder da, Seite nicht neu geladen) braucht keine Neukalibrierung – die Nulllage gilt weiter, das Overlay bleibt stehen. Beim Kalibrieren ist das Overlay immer aus, sonst deckt es den Knopf zu.
- Spieler entsperren jederzeit selbst: 2 s auf dem schwarzen Overlay halten. Der Button „Motion-Modus (Touch sperren)“ am Handy schaltet ihn wieder ein.

## Abnahmetest
1. Console + 1 Handy, Spiel starten → Handy-Display schwarz, Sensorwerte laufen in Unity weiter (`seq` steigt).
2. Ergebnis-Screen → Overlay weg, Zeiger trifft „Nochmal“.
3. Handy während des Spiels neu laden → Start tippen, kalibrieren → Overlay von selbst wieder da.
4. Wii-Knopf der Console während des Spiels → Overlay auf allen Handys weg.

## Stolperfallen
- `SetMotionMode(true)` vor dem Beitritt eines Spielers: die Console schickt den Modus beim Öffnen des Kanals nach, das Handy wartet bis nach der Kalibrierung. Kein eigener Code nötig.
- Overlay blockt auch „Neu kalibrieren“. Drift im Spiel: Spieler entsperrt (2 s), kalibriert neu, sperrt wieder – oder das Spiel bietet Recenter per Geste.
- Kein Spiel darf ein tippbares Textfeld auf dem Handy haben: getippter Text legt in iOS einen Undo-Verlauf an, und ein kräftiger Hieb gilt dort als Schütteln → mitten im Spiel erscheint der Dialog „Eingabe widerrufen“. Eingaben deshalb per Bildschirm-Tastatur setzen (programmatische Werte haben keinen Undo-Eintrag), so wie der Raum-Code im Controller.
- `WiiMotionMode` gibt es nur im WebGL-Build; im Editor läuft der Stub. Übergänge trotzdem im Editor testen (Log statt Overlay).
