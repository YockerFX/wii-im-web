# 07 – Betrieb: Monitoring, Updates, Datenschutz, Impressum
**Ziel:** Ausfälle werden gemeldet, bevor Spieler sie melden; Updates laufen ohne Nachdenken; die Seite ist rechtlich sauber.
**Voraussetzungen:** 06 läuft. Ein Heimgerät, das dauerhaft läuft (Pi, NAS, alter Laptop) mit Docker für Uptime Kuma (Einrichtung: Plan 11, Schritt 5). Hetzner-Account-Zugang.
**Definition of Done:**
- [ ] Uptime Kuma (zu Hause): HTTP-Keyword-Monitor `https://<DOMAIN>/healthz` → `"ok":true` + TCP-Monitor `turn.<DOMAIN>:3478`; Alarm getestet (`docker compose stop signaling` → Mail/Push in < 5 min)
- [ ] `/impressum` und `/datenschutz` erreichbar, aus Console- und Controller-Seite verlinkt
- [ ] Hetzner-AV-Vertrag abgeschlossen (accounts.hetzner.com › Datenschutz/DPA)
- [ ] Monatliche Wartung im Kalender

## Schritte
1. **Monitoring** (Uptime Kuma auf dem Heimgerät, 1-min-Intervall; Start-Befehl in Plan 11, Schritt 5): die zwei Monitore oben, Benachrichtigung per SMTP des eigenen Mail-Anbieters oder ntfy. `/healthz` läuft durch Caddy zum Node-Prozess – schlägt an, wenn Caddy **oder** Signaling ausfällt. Nicht auf dem VPS betreiben (blind für dessen Ausfall). Hetzner Cloud Console › Server › Graphs zeigt CPU/Netz/Disk rückwirkend.
2. **Logs** (json-file, 3 × 10 MB je Container aus 01 → wenige Tage Aufbewahrung):
   ```sh
   docker compose logs -f --tail 100 signaling            # Ereignisse + Raum-Codes, keine IPs
   docker compose logs --since 24h coturn | grep -iE 'quota|error|403'
   docker compose logs caddy | grep -i certificate        # Renewal-Fehler
   ```
   Caddy loggt keine Zugriffe (kein `log`-Directive) – bei Bedarf temporär einschalten, danach entfernen.
3. **Datenschutz im Code**: Signaling loggt keine IPs; coturn ohne `verbose`; `sessionStorage`-Tokens sind technisch erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG, keine Einwilligung). Keine Cookies, kein Tracking, keine Fremd-STUN-Server.
4. **Impressum** (`/impressum`): Name, ladungsfähige Anschrift (kein Postfach), E-Mail – § 18 Abs. 1 MStV. Bei Werbung, Spenden oder Verkauf zusätzlich § 5 DDG (ggf. USt-ID).
5. **Datenschutzerklärung** (`/datenschutz`), Mindestinhalt:
   - Verantwortlicher (= Impressum); Betroffenenrechte Art. 15–21 DSGVO; Beschwerderecht Art. 77
   - Hosting: Hetzner Online GmbH (Rechenzentrum Nürnberg/Falkenstein), AV-Vertrag; IP-Adressen zum Verbindungsaufbau (Art. 6 Abs. 1 lit. f)
   - Signaling: Raum-Code, Slot, IP während der Session; keine Speicherung darüber hinaus (Art. 6 Abs. 1 lit. b/f)
   - TURN-Relay: IP + transienter Spielverkehr, keine Inhalte gespeichert
   - Container-Logs: Ereignisse ohne IP, automatische Rotation (wenige Tage)
   - Keine Cookies/Tracking; Browser-Speicher nur für Reconnect-Token
   Kein Rechtsrat – bei Monetarisierung Generator oder Anwalt.
6. **Updates**: OS automatisch (unattended-upgrades, Reboot 04:30 UTC; Container kommen per `restart: unless-stopped` zurück). Images monatlich manuell (06 › „Image-Updates“). coturn-Security-Fixes zeitnah: https://github.com/coturn/coturn/releases.
7. **Monatliche Wartung** (15 min):
   ```sh
   ssh root@<DOMAIN> 'cd /opt/wii && df -h / && docker system df && docker compose ps && docker compose logs --since 720h coturn | grep -ci quota'
   ```
   Dann: Image-Tags prüfen (06), `docker image prune -f`, Hetzner-Graphen auf CPU-/Traffic-Trend, Trigger-Werte aus 00 (CPU > 70 %, Traffic > 15 TB, `/healthz` connections dauerhaft > 5000).
8. **Secret rotieren** (bei Verdacht): `TURN_SECRET` in `.env` neu setzen, `docker compose up -d signaling coturn`. Laufende Allocations bleiben, neue Joins nutzen das neue Secret.

## Abnahmetest
`docker compose stop signaling` → Uptime-Kuma-Alarm; `docker compose start signaling` → „up“. `curl -s https://<DOMAIN>/impressum | grep -ci anschrift` ≥ 1 (bzw. Sichtprüfung). Hetzner-DPA-Seite zeigt „abgeschlossen“.

## Rollback
Keine destruktiven Schritte. Monitore bei Wartungsfenstern pausieren.

## Stolperfallen
- Ein Uptime-Check auf `/` ist wertlos: Caddy liefert HTML auch bei totem Node → immer `/healthz` mit Keyword.
- Disk voll = alles tot: Log-Rotation (01) und `docker image prune` nicht vergessen; `caddy_data` nie prunen (Let's-Encrypt-Rate-Limit).
- 04:30 ist Serverzeit (UTC) = 06:30 MESZ. Bei Bedarf in `cloud-init.yaml` anpassen.
- Datenschutzerklärung erweitern, sobald Cloudflare (09) dazukommt (Drittland, DPA).

## Nicht Teil dieses Plans
Deploy-Befehle → 06; Tests/Lasttest → 08; Skalierung → 09.
