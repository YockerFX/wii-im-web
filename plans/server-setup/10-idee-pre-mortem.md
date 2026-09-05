# 10 – Pre-Mortem: offene Blocker und Ein-Tages-Test der Idee
**Ziel:** Bevor 30 h in Infrastruktur fließen, die Annahmen prüfen, an denen die Idee hängt – mit Wegwerf-Code an einem Tag – und die Blocker benennen, die kein Server-Plan löst.
**Voraussetzungen:** Laptop, ein iPhone und ein Android-Handy im selben WLAN, `brew install caddy node`. Vorlagen: `files/spike/` (Caddyfile, relay.js, controller.html, console.html). Kein VPS nötig.
**Definition of Done:**
- [ ] Messtabelle (Abschnitt C) für mindestens iOS + Android im WLAN und ein Gerät im Mobilfunk ausgefüllt
- [ ] Go/No-Go-Kriterien bewertet; Konsequenzen in `00-entscheidungen.md` eingetragen (TURN-Anteil, Sensor-Rate, Pointer ja/nein)
- [ ] Blocker-Liste (Abschnitt A) je Zeile mit „erledigt / akzeptiert / offen“ markiert

## A. Blocker, die die Pläne 00–09 nicht lösen
| # | Blocker | Warum kritisch | Was tun |
|---|---|---|---|
| A1 | **Name „Wii“** ist eine eingetragene Marke (Nintendo). Öffentliche Seite + Domain mit „Wii“ = Abmahnrisiko | kann das ganze Projekt stoppen, nachdem Domain/Impressum öffentlich sind | Vor Domainkauf umbenennen. Kein Rechtsrat, aber „X im Web“ ohne Fremdmarke ist die sichere Variante |
| A2 | **Kein absolutes Zeigen.** Die Wii-Remote nutzt eine IR-Sensorbar; das Handy hat nur Gyro/Beschleunigung/Kompass. Yaw driftet, der Kompass ist in Innenräumen ±20° daneben | Wii-typisches Cursor-Zeigen auf den Bildschirm funktioniert nicht zuverlässig | Spieldesign auf Neigung, Schwung, Gesten + „Recenter“-Taste auslegen. Pointer nur relativ (Gyro-Integration) mit Recenter, oder Touch-Fläche auf dem Handy. Im Spike messen (C5) |
| A3 | **Sensor-Rate ist gedeckelt:** Chrome und Safari liefern `devicemotion` mit max. 60 Hz, manche Android-Browser 30 Hz | Schwungerkennung und Latenz hängen daran; Rhythmus-Genauigkeit < 16 ms ist unmöglich | Im Spike messen (C1). Spiel auf 60 Hz mit Peak-Erkennung auslegen, Fallback 30 Hz einplanen |
| A4 | **„Gleiches WLAN = direkte Verbindung“ wackelt.** Browser verschleiern Host-Kandidaten per mDNS; Router ohne NAT-Hairpinning, Gäste-/Hotel-WLAN mit Client-Isolation → Relay über coturn in Deutschland trotz gleichem Wohnzimmer (+20–40 ms) | TURN-Anteil kann 30–50 % statt 20 % sein; Latenz steigt | Server verkraftet es (00 Worst Case). Im Spike Pfad messen (C4); Annahme in 00 anpassen |
| A5 | **Unity-WebGL in Next.js** ist nicht spezifiziert: `createUnityInstance` in einer React-Komponente, Canvas-Größe/Fullscreen, Audio erst nach Klick, 1–2 GB RAM im Tab (kein Mobile-Browser als Console) | ohne das gibt es keine Console-Seite | Eigene Komponente statt Unity-Template-HTML; Loader-Script aus `/Build/`; Build-Artefakte (15 MB) nicht ins Git |
| A6 | **Signaling-Server und Client sind bisher Spezifikationen** (03, 05), kein Code | größter Arbeitsblock (10–20 h) und Hauptquelle von Bugs (Reconnect-Zustände) | Reihenfolge: Spike (hier) → 03 mit Abnahmetest → 05 → erst dann VPS |
| A7 | **Idle-Regel in 03 war falsch:** „30 min ohne Nachricht → Raum zu“ – während des Spiels läuft aber kein Signaling-Verkehr | jede Partie > 30 min wäre abgebrochen worden | Korrigiert: Räume haben eine Maximallebensdauer von 12 h, kein Idle-Timeout; Aufräumen über Host-Weg (60 s) und Heartbeat |
| A8 | **Ein VPS = ein Ausfallpunkt** (Reboot 04:30 UTC, Hetzner-Wartung) | laufende Partien überleben (DataChannel ist direkt), aber Joins/Reconnects gehen nicht | Für Hobby akzeptabel. Wartungsfenster außerhalb der Spielzeiten, Reboot-Zeit in `cloud-init.yaml` prüfen |
| A9 | **Externe Abhängigkeiten, die auch bei „alles self-hosted“ bleiben:** Let's Encrypt (öffentliche Zertifikate lassen sich nicht selbst ausstellen), Hetzner (Hosting, DNS), Docker Hub/npm (Images, Pakete), ein E-Mail-/Push-Kanal für Alarme | Erwartung „keine Drittanbieter“ ist sonst nicht erfüllbar | Bewusst akzeptieren; Images per Digest pinnen; Alarme über den eigenen Mail-Anbieter oder ntfy zu Hause (11) |
| A10 | **Join-Flow und Controller-UX** fehlen: QR-Code mit Raum-Code auf der Console, Code-Eingabe mit Autokorrektur, Spielerfarbe, Tasten-Layout, keine Vibration auf iOS Safari | erste Nutzer scheitern am Beitreten, nicht an WebRTC | Beim Client (05) als eigene Aufgabe einplanen; QR = `https://<DOMAIN>/controller?room=CODE` |
| A11 | **Browser-Matrix:** Console = Desktop Chrome/Edge/Firefox (Safari läuft, Unity-Performance schwächer); Controller = iOS Safari ≥ 16.4, Android Chrome; Smart-TV-Browser nein | falsche Erwartung bei Nutzern | Auf der Startseite nennen; im Spike mit den Zielgeräten messen |
| A12 | **Latenzbudget:** 16 ms Sampling + 10–40 ms Netz + 16 ms Unity-Frame + Display ≈ 50–90 ms | für Party-Spiele ok, für Rhythmus-/Reaktionsspiele zu viel | Spielauswahl danach richten; Spike misst RTT (C2) |

## B. Ein-Tages-Spike (Wegwerf-Code aus `files/spike/`)
1. `files/spike/` an einen Ort kopieren, in `Caddyfile` `<LAN_IP>` eintragen. Starten (zwei Terminals):
   ```sh
   cd spike && npm init -y >/dev/null && npm i ws && node relay.js       # Broadcast-Signaling ohne Räume – nur für den Spike
   caddy run                                                              # HTTPS mit lokaler CA auf https://<LAN_IP>
   ```
   Root-CA aufs Handy: `~/Library/Application Support/Caddy/pki/authorities/local/root.crt` (macOS) per AirDrop, installieren und volle Vertrauensstellung aktivieren (wie 05, Schritt 1).
2. Laptop: `https://<LAN_IP>/console.html`; Handy: `https://<LAN_IP>/controller.html` → „Start“ tippen (Permission + Wake Lock). Die Console zeigt Frames/s, Jitter p95, RTT-Median, Verlust, Pfad und zeichnet Neigung und einen Gyro-integrierten Cursor.
3. Jede Zeile der Messtabelle 2 min laufen lassen; Handy für die Drift-Messung (C5) 60 s ruhig ablegen, dann Cursor-Abweichung ablesen.
4. Varianten: Handy im Mobilfunk (WLAN aus) mit `?ice=stun:turn.<DOMAIN>:3478` (nach 04) bzw. gegen einen Trickle-ICE-verifizierten TURN mit `?turn=turn:turn.<DOMAIN>:3478&user=…&cred=…`.
5. Unity-Check separat: leere Szene mit einem Würfel, Brotli-Build, über Caddy laden – Ladezeit und fps auf dem Ziel-Laptop notieren.

## C. Messtabelle und Go/No-Go
| # | Messgröße | Go | No-Go → Konsequenz |
|---|---|---|---|
| C1 | Frames/s vom Handy | ≥ 55 (iOS und Android) | < 45 → Spiel auf 30 Hz auslegen, Peak-Erkennung entsprechend |
| C2 | RTT-Median (Ping über `events`) | ≤ 40 ms WLAN, ≤ 120 ms Relay/Mobilfunk | darüber → keine reaktionskritischen Spiele, Interpolation auf der Console |
| C3 | Jitter p95 (Abstand zwischen Frames) | ≤ 30 ms | > 50 ms → Puffer von 2 Frames auf der Console, Sensorwerte glätten |
| C4 | Pfad im Heim-WLAN (`selectedPath`) | `host` oder `srflx` | `relay` → Router-Hairpinning-Problem dokumentieren, TURN-Anteil in 00 auf 50 % setzen |
| C5 | Yaw-Drift nach 60 s Ruhe | < 10° | > 30° → kein Pointer-Gameplay, nur Neigung/Gesten |
| C6 | Unity-Testszene | ≥ 60 fps, Ladezeit < 10 s im LAN | sonst Build-Größe/Qualität reduzieren, Laptop-Mindestanforderung nennen |

| Gerät | Browser | Netz | C1 fps | C3 Jitter p95 | C2 RTT | C4 Pfad | C5 Drift | Verlust % |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |

## Rollback
Spike-Ordner löschen; `caddy untrust` entfernt die lokale CA vom Laptop; Profil auf dem Handy entfernen.

## Stolperfallen
- `relay.js` hat keinen Origin-Check und keine Räume – nie auf den VPS kopieren.
- Ohne HTTPS liefert das Handy keine Sensordaten; ohne Klick vor `requestPermission()` lehnt iOS ab.
- Chrome auf dem Laptop darf nicht hinter einem VPN hängen (ICE-Kandidaten nur im VPN-Netz).
- Drift-Messung nur mit ruhig liegendem Handy; in der Hand sind 5°/min normal.

## Nicht Teil dieses Plans
Produktiver Signaling-Server → 03; Client-Code → 05; Daten/Storage → 11.
