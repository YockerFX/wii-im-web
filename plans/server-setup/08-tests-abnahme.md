# 08 – Tests, Lasttest, Go-Live-Checkliste
**Ziel:** Vor dem ersten öffentlichen Spielabend ist bewiesen: Verbindung in fremden Netzen, Reconnect in allen Alltagsfällen, Kapazität für 100 Räume.
**Voraussetzungen:** 05, 06, 07 fertig. Zweites Gerät im Mobilfunknetz. Lasttest: k6 (`brew install k6`) auf einem Rechner außerhalb des VPS; `files/load/signaling.js`. Optional coturn-Tools (`brew install coturn`).
**Definition of Done:**
- [ ] E1–E5 grün, R1–R6 grün (< 5 s weiter, gleicher Slot/Farbe, kein Neuladen)
- [ ] Lasttest: 200 Räume / 400 Verbindungen, 5 min, 0 Fehler, signaling < 100 MB RSS, CPU < 30 %
- [ ] Go-Live-Checkliste vollständig; Messwerte unten eingetragen

## Schritte
1. **End-to-End**
   | # | Test | Erwartung |
   |---|---|---|
   | E1 | Laptop-Console + 2 Handys im Heim-WLAN, 10 min spielen | `selectedPath()` `host/…`, keine Aussetzer |
   | E2 | Handy im Mobilfunk (WLAN aus), normaler Join | verbindet; Pfad `srflx` oder `relay` |
   | E3 | Handy im Mobilfunk mit `?forceRelay=1` | Pfad `relay/udp`; Spiel spielbar |
   | E4 | 4 Handys + 5. Join | 5. bekommt `ROOM_FULL`; nach `leave` eines Spielers ist Join möglich |
   | E5 | iOS Safari, Android Chrome; Console in Chrome und Firefox | jeweils komplett durch |
2. **Reconnect-Matrix**
   | # | Fall | Erwartetes Verhalten |
   |---|---|---|
   | R1 | `docker compose restart signaling` während des Spiels | Räume sind In-Memory → `resume` scheitert mit `RESUME_INVALID`; DataChannel läuft ununterbrochen weiter, Clients zeigen „Raum auf dem Server weg“; kein ICE-Restart mehr, neue Spieler brauchen einen neuen Raum. Deploys nur außerhalb der Spielzeiten (10, A8) |
   | R2 | Handy Flugmodus 5 s | `disconnected` → Karenz → ggf. ICE-Restart |
   | R3 | Handy WLAN → LTE | `failed` → `{t:"restart"}` → neues Offer; Pfad wechselt |
   | R4 | Handy 60 s sperren, entsperren | `visibilitychange` → resume + Restart; Slot war `reserved` |
   | R5 | Console-Tab neu laden (< 60 s) | `resume` mit hostToken → `peer-joined` je Slot → neue PCs |
   | R6 | Handy 3 min weg | Slot nach 120 s frei (`peer-left timeout`); neuer Join bekommt nächsten freien Slot |
   Beobachten: DevTools › Network › WS › Messages und `chrome://webrtc-internals`.
3. **Lasttest Signaling** – vom Laptop oder einem stundenweisen Hetzner-Server. Vorher auf dem Server in `.env` `MAX_CONN_PER_IP=1000` und `CREATE_PER_IP_PER_MIN=1000` setzen, `docker compose up -d signaling`; danach zurücksetzen.
   ```sh
   DOMAIN=<DOMAIN> k6 run load/signaling.js               # 200 VUs: je 1 Console + 1 Controller, 4 min halten
   ssh root@<DOMAIN> 'docker stats --no-stream'            # währenddessen: signaling RSS/CPU
   ```
   Ziel: 0 Fehler, `ws_connecting p(95) < 500 ms`, RSS < 100 MB, CPU < 30 %. Das Skript sendet den `Origin`-Header (sonst 403).
4. **Lasttest TURN** (optional): auf dem Server `docker compose exec -d coturn turnutils_peer -p 3480`, dann vom Testrechner
   ```sh
   turnutils_uclient -y -p 3478 -W <TURN_SECRET> -e <SERVER_IPV4> -m 80 -n 3600 -l 100 -z 16 <SERVER_IPV4>   # 80 Sessions ≈ 60 Hz × 100 B
   ```
   Ziel: `total lost packets` ≈ 0, coturn-CPU < 30 %, `docker compose logs coturn | grep -ci quota` = 0.
5. **Messwerte eintragen** (Basis für die Trigger in 00/09):
   | Datum | Verbindungen | Räume | signaling RSS / CPU | coturn CPU | Fehler |
   |---|---|---|---|---|---|
   | | | | | | |

## Go-Live-Checkliste
- [ ] 01: SSH nur per Key; 8 Firewall-Regeln; NTP synchron
- [ ] 02: `check-static.sh` → OK; HSTS/CSP vorhanden; IPv6 → 200
- [ ] 03/06: `/healthz` OK; kaputte Nachricht killt nur die Verbindung; Reboot-Test bestanden
- [ ] 04: Trickle-ICE relay (UDP + TCP) aus dem Mobilfunk; abgelaufene Credentials abgelehnt; 169.254.169.254 → 403
- [ ] 05: E1–E5, R1–R6 grün
- [ ] 07: Monitore alarmieren; Impressum/Datenschutz verlinkt; AVV abgeschlossen
- [ ] 11: Postgres/Garage nur im Docker-Netz; Backup-Restore geübt; Heimgerät zieht Backups
- [ ] Lasttest-Zahlen eingetragen; `MAX_CONN_PER_IP`/`CREATE_PER_IP_PER_MIN` zurückgesetzt
- [ ] `.env` im Passwortmanager gesichert; Repo gepusht

## Rollback
Tests sind nicht destruktiv. Nach dem Lasttest `.env` zurücksetzen und `docker compose up -d signaling`; temporären Hetzner-Server löschen.

## Stolperfallen
- Lasttest vom VPS gegen sich selbst misst nur Loopback – immer von extern.
- Ohne `Origin`-Header lehnt der Server jede Verbindung ab (03).
- Heim-WLAN verbindet fast immer direkt – nur E2/E3 testen TURN wirklich.
- iOS-Sperre friert die Seite ein; R4 nur mit echtem Gerät, nicht im Simulator.

## Nicht Teil dieses Plans
Lokale Dev-Umgebung → 05; Monitoring-Setup → 07.
