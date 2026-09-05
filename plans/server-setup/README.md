# Server-Setup „Wii im Web“ – Teilpläne

Handys als Controller (WebRTC DataChannel) → Browser-Console mit Unity-WebGL-Spiel. Ein Hetzner-VPS, Docker Compose mit fünf Containern: **Caddy** (TLS, Static, Proxy), **Signaling** (Node + ws), **coturn** (STUN/TURN), **Postgres**, **Garage** (S3-Bucket). Alles self-hosted, inklusive Postgres und Garage-S3-Bucket (Plan 11). Vorgabe aus 00: keine Drittanbieter außer Let's Encrypt, Hetzner und Paket-Registries.

## So benutzen
- **Immer nur einen Teilplan laden** (auch in KI-Sessions). Jeder ist eigenständig: Ziel, Voraussetzungen, Definition of Done, Schritte, Abnahmetest, Rollback, Stolperfallen.
- Begründungen, Zahlen und Entscheidungen stehen **nur** in `00-entscheidungen.md`; dort auch die Platzhalter-Tabelle (`<DOMAIN>`, `<SERVER_IPV4>`, …) zum Ausfüllen.
- Fertige Vorlagen liegen in `files/` (Compose, Caddyfile, turnserver.conf, cloud-init, Skripte). Die Pläne verweisen darauf, statt sie zu wiederholen. Beim Umsetzen ins Repo-Root kopieren.
- Reihenfolge einhalten, Status-Spalte abhaken.

## Reihenfolge, Abhängigkeiten, Aufwand
| # | Teilplan | hängt ab von | Aufwand | Status |
|---|---|---|---|---|
| 10 | `10-idee-pre-mortem.md` **zuerst**: Blocker-Liste und Ein-Tages-Spike (Sensor-Rate, Latenz, Relay-Anteil, Drift) | – | 1 Tag | [ ] |
| 00 | `00-entscheidungen.md` lesen, Platzhalter ausfüllen, Spike-Ergebnisse eintragen | 10 | 0,5 h | [ ] |
| 01 | `01-domain-dns-vps.md` Domain, DNS, VPS, Firewall, Server-Basis | 00 | 2 h | [ ] |
| 02 | `02-proxy-tls-static.md` Caddy: TLS, Unity/Next-Auslieferung, WS-Proxy | 01 | 2 h | [ ] |
| 03 | `03-signaling-server.md` Node + ws Room-Server | 00 | 6–10 h | [x] `signaling/`, 16 Tests, Docker ok (2026-09-03) |
| 04 | `04-turn.md` coturn | 01, 03 | 2 h | [ ] |
| 05 | `05-client-webrtc.md` Controller + Console (WebRTC, Unity-Brücke) | 03 | 4–8 h | [x] `out/`, `unity/`, Browser-E2E grün; Handy-Test (E5, R2–R4) offen |
| 06 | `06-compose-deploy.md` Compose, Erst-Inbetriebnahme, Deploy, Rollback | 02, 03, 04 | 2 h | [ ] |
| 07 | `07-betrieb.md` Monitoring, Updates, Datenschutz, Impressum | 06 | 2 h | [ ] |
| 08 | `08-tests-abnahme.md` E2E, Reconnect-Matrix, Lasttest, Go-Live | 05, 06, 07 | 4 h | [ ] |
| 11 | `11-daten-postgres-storage.md` Postgres + Garage-Bucket, Schema, Backups aufs Heimgerät, Uptime Kuma | 06 | 3 h | [ ] |
| 09 | `09-spaeter.md` Stufe 2/3 mit Triggern | – | – | – |

Kritischer Pfad: 10 → 01 → 02 → 06 → 11 → 08. 03 und 05 lassen sich lokal parallel dazu entwickeln (lokale HTTPS-Umgebung: 05, Schritt 1). Gesamt ≈ 25–30 h für eine Person mit Docker-Erfahrung.

## Vorlagen in `files/`
| Datei | Ziel im Repo | Genutzt von |
|---|---|---|
| `compose.yaml`, `compose.dev.yaml`, `.env.example` | Repo-Root | 02, 04, 05, 06 |
| `Caddyfile`, `Caddyfile.dev`, `caddy/site.caddy` | Repo-Root, `caddy/` | 02, 05 |
| `turnserver.conf` | Repo-Root | 04 |
| `cloud-init.yaml` | Repo-Root (nur für `hcloud server create`) | 01 |
| `signaling/Dockerfile` | `signaling/` | 03, 06 |
| `scripts/deploy-static.sh`, `scripts/check-static.sh`, `scripts/turn-cred.sh` | `scripts/` | 02, 04, 06, 08 |
| `load/signaling.js` | `load/` | 08 |
| `spike/` (Caddyfile, relay.js, controller.html, console.html) | beliebiger Ordner auf dem Laptop, Wegwerf-Code | 10 |
| `garage.toml` | Repo-Root | 11 |

## Herkunft
Diese Teilpläne ersetzen den Recherche-Plan vom 2026-09-03. Er wurde gegen Primärquellen geprüft (ws-Doku, coturn-README/-Beispielconfig, Caddy-Doku, Hetzner-Docs, MDN, RFC 6455/7065/7675, Chromium-Quellen); die Korrekturen sind eingearbeitet. Offene Annahmen stehen in `00-entscheidungen.md` unter „Ungeprüft“.
