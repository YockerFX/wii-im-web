# 09 – Später: Stufe 2 und 3 (nur mit messbarem Trigger)
Nichts hiervon im MVP umsetzen. Jeder Punkt hat einen Trigger aus `/healthz`, den Hetzner-Graphen oder der Telemetrie (05, Schritt 8).

| Maßnahme | Trigger | Umsetzung in Kürze |
|---|---|---|
| **TURN/TLS (5349)** | Telemetrie-Pfad `none` bei Spielern in Firmen-/Hotel-/Schulnetzen; Meldungen „verbindet nicht im Büro“ | Firewall 5349/TCP; `turnserver.conf`: `no-tls` raus, `tls-listening-port=5349`, `cert=`/`pkey=` unter `/etc/coturn/certs/`; Zertifikat aus Caddys Storage (`caddy_data`: `certificates/acme-v02…/turn.<DOMAIN>/`) täglich per Cron kopieren (`root:65534`, `0640`) + `docker compose kill -s SIGUSR2 coturn`; Caddy braucht dafür einen Site-Block `turn.<DOMAIN> { respond 404 }`; Client-URL `turns:turn.<DOMAIN>:5349?transport=tcp` ergänzen (03, Schritt 7) |
| **Cloudflare Realtime TURN** (Variante B in 04) – *nur falls die Self-hosted-Vorgabe fällt* | TURN-Traffic > ~1 TB/Monat oder Spieler außerhalb Europas | Variante B in 04; Self-hosted-Alternative: zweiter coturn in einer anderen Region (Hetzner Helsinki/Ashburn), DNS nach Nähe |
| **Cloudflare CDN vor `<DOMAIN>`** – *nur falls die Self-hosted-Vorgabe fällt* | Spieler außerhalb Europas mit > 1 s bis zum ersten Byte des Builds; Traffic > 15 TB/Monat | Nur `<DOMAIN>` proxien, `turn.` grau; WebSocket auf eigene graue Subdomain `ws.<DOMAIN>` (100-s-Idle-Timeout); Cache Rule für `/Build/*` und `/_next/static/*` („Eligible for cache“, Edge-TTL aus Cache-Control); Rocket Loader / Email Obfuscation / Auto Minify aus; Test: zweiter Abruf `cf-cache-status: HIT` **und** `content-encoding: br`; Datenschutzerklärung ergänzen |
| **WebSocket-Fallback-Relay** | Telemetrie: > 1 % der Sessions enden in `failed` trotz Relay-Kandidaten | Controller: nach ICE `failed` + gescheitertem Restart (10 s) Sensor-Frames als Binärframe `[0x01, slot, 44 B]` über den Signaling-WS (`bufferedAmount < 8×46`, sonst verwerfen). Server: Binärframes ohne Parse an die Console des Raums; `bufferedAmount > 64 KB` → verwerfen, `> 1 MB` → `terminate()`; Token-Bucket auf 120 msg/s. Console: `binaryType = 'arraybuffer'`, gleicher Parser wie DataChannel |
| **Größerer VPS** (CX33/CX43) | CPU dauerhaft > 70 % oder RAM > 80 % in den Hetzner-Graphen | `hcloud server change-type wii-prod --type cx33 --keep-disk`; ≈ 2 min Downtime; Container kommen per `restart` zurück |
| **Mehrere Signaling-Instanzen** | `/healthz` connections dauerhaft > 5000 oder ein CPU-Core durch Node gesättigt | Caddy `reverse_proxy` mit `lb_policy client_ip_hash` + Räume je Instanz; erst danach Redis-Pub/Sub. Für Hobby-Betrieb realistisch nie |
| **coturn auf eigene Box** | coturn-CPU > 70 % oder Relay-Traffic > 10 TB/Monat | zweiter Server nur mit coturn; DNS `turn.` umziehen; Firewall-Regeln 3478 + Range dort |
| **Accounts / Highscores / Uploads** | Produktentscheidung | Plan 11: Postgres und Garage self-hosted auf demselben VPS, Backups aufs Heimgerät |
| **Node 26** | ab 2026-10-28 (Active LTS) | `FROM node:26-alpine`, `engines` anpassen, Healthcheck unverändert |

## Reihenfolge, falls es wächst
1. Zwei Wochen echte Telemetrie (Pfad-Verteilung, Fehlerrate) vor jeder Änderung.
2. TURN/TLS (billig, klarer Nutzen) → CDN → Cloudflare TURN → größerer VPS → Aufteilung.
3. Jede Maßnahme mit den Tests aus 08 abnehmen und die Messwert-Tabelle dort fortschreiben.
