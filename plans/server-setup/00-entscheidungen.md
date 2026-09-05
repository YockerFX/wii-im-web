# 00 – Entscheidungen, Kernzahlen, Platzhalter

## Architektur (MVP)
Ein Hetzner-VPS (Ubuntu 24.04, Docker Compose), fünf Container:
1. **caddy** – TLS automatisch (Let's Encrypt), statische Dateien (Next.js-Export + Unity-WebGL-Build), Reverse Proxy für `/ws`, `/healthz`, `/api`, `/files`.
2. **signaling** – Node 24 + `ws`, In-Memory-Räume (5-stelliger Code, 4 Slots, Reconnect-Tokens), reicht SDP/ICE durch, erzeugt TURN-Credentials.
3. **coturn** – STUN + TURN über UDP und TCP auf 3478, `network_mode: host`, HMAC-Credentials mit Ablauf.
4. **postgres** – Scores, Accounts, Telemetrie, Upload-Metadaten; nur im Docker-Netz.
5. **garage** – S3-kompatibler Bucket für Uploads; nur im Docker-Netz, öffentliche Dateien über Caddy `/files/*`.

Spielverkehr läuft Handy ↔ Console direkt per WebRTC DataChannel (Stern: Console hält eine PeerConnection pro Controller). Nach dem Verbindungsaufbau sieht der Server keine Sensordaten mehr; nur bei TURN-Nutzung fließt der Verkehr durch coturn.

## Getroffene Entscheidungen
| Entscheidung | Warum | Ändern wenn |
|---|---|---|
| Hetzner CX23 (2 vCPU/4 GB/40 GB, 20 TB), Fallback CAX11 (ARM) | reicht für weit über 100 Räume; alle Images sind Multi-Arch | CPU dauerhaft > 70 % oder > 5000 Verbindungen → 09 |
| Caddy statt nginx + certbot | TLS, Renewal, HTTP→HTTPS, WebSocket-Proxy und `X-Forwarded-For` ohne Konfiguration; keine `add_header`-Vererbungsfalle | nur, wenn Rate-Limits zwingend im Proxy sitzen müssen |
| Eigener coturn, nur `turn:` über UDP + TCP 3478, **kein TURN/TLS (5349)** | < 0,5 % der Clients brauchen TURN/TLS; ohne TLS braucht coturn kein Zertifikat und keinen Renewal-Hook | Spieler in Firmen-/Hotel-Netzen verbinden nicht → 09 |
| STUN nur über eigenen coturn (kein Google/Cloudflare) | coturn beantwortet STUN anonym; kein Drittland-Transfer in der Datenschutzerklärung | nie |
| Dual-Stack IPv4 + IPv6 | IPv6 ist kostenlos; halbe Lösungen (AAAA ohne Firewall/coturn-v6) sperren Clients aus | – |
| Relay-Port-Range 49152–50175 (1024 Ports), `total-quota=800` | 100 Räume × 4 Spieler × 20 % Relay ≈ 80 Allocations; kleine Range = kleine Angriffsfläche | coturn-Log `quota reached` → Range und Quota verdoppeln (01 + 04) |
| Kein Cloudflare-Proxy/CDN | 20 TB inklusive; Cloudflare cacht `.wasm.br` ohne Cache Rule gar nicht; 100-s-WebSocket-Timeout | Spieler außerhalb Europas mit > 1 s TTFB oder > 15 TB/Monat → 09 |
| Kein WebSocket-Fallback-Relay | TURN deckt den Fall ab; Fallback braucht eigenes Binärprotokoll + Backpressure | Telemetrie (05) zeigt > 1 % `failed` trotz Relay → 09 |
| Next.js `output: 'export'`, kein Service Worker | Console + Controller-PWA sind rein statisch; Unity-Dateien im SW-Cache sind eine Fehlerquelle | Server-Rendering nötig → vierter Container |
| Deploy: Repo per `git pull` auf dem VPS, Static per `rsync` in Release-Ordner + Symlink | eine Person, kein CI nötig; Rollback = Symlink umbiegen | mehrere Entwickler → GitHub Actions + Registry |
| SSH als root mit Key, Port 22 nur von `<ADMIN_IP>` | ein `deploy`-User in der docker-Gruppe wäre ohnehin root-äquivalent | keine feste Admin-IP → Port 22 offen + fail2ban, oder Tailscale |
| Kein Redis, keine Hetzner-Backups | Räume bleiben In-Memory; Postgres/Garage werden per Dump + rsync aufs Heimgerät gesichert (11) | zweites Backup-Ziel gewünscht → Hetzner Storage Box |
| Rate-Limits im Signaling-Server, nicht im Proxy | Caddy hat kein Rate-Limit eingebaut; Firewall + coturn-Quotas decken den Rest ab | Angriffe auf den Upgrade-Endpunkt → nginx-Variante oder Caddy-Plugin |
| Impressum + Datenschutzerklärung von Anfang an | Pflicht für öffentlich erreichbare Seite in DE (§ 18 MStV, Art. 13 DSGVO) | – |
| **Alles self-hosted.** Ausnahmen, die bleiben: Let's Encrypt, Hetzner (Hosting/DNS), Docker Hub/npm (Build-Zeit), ein Mail-/Push-Kanal für Alarme | Vorgabe des Projekts; öffentliche Zertifikate und Hosting sind nicht selbst machbar | – |
| Monitoring per Uptime Kuma auf einem Heimgerät, nicht auf dem VPS und nicht UptimeRobot | ein Monitor auf dem VPS sieht dessen Ausfall nicht; Drittanbieter sind ausgeschlossen | kein Heimgerät → Cron mit `curl` auf irgendeinem anderen Rechner |
| Postgres + Garage (S3-Bucket) von Anfang an im Stack, self-hosted auf demselben VPS, Backups aufs Heimgerät | Neues Projekt, Daten (Scores, Accounts, Uploads, Telemetrie) gehören von Beginn an in eigene Dienste; MinIO-Community-Edition ist seit 10/2025 ohne Images und seit 02/2026 archiviert | > 25 GB Daten → Hetzner Volume; Swap dauerhaft belegt → CX33 |
| Vor 01: Ein-Tages-Spike (Plan 10) und Umbenennung weg von „Wii“ | Sensor-Rate, Latenz, Relay-Anteil und Yaw-Drift entscheiden über das Spieldesign; „Wii“ ist eine Nintendo-Marke | – |

## Kernzahlen (konservativ gerechnet)
| Größe | Wert |
|---|---|
| Sensordaten pro Controller | 60 Hz × 44 Byte Nutzlast ≈ 21 kbit/s; mit SCTP/DTLS/UDP-Overhead ≈ 55 kbit/s |
| 400 Spieler, 20 % über TURN | ≈ 80 Relay-Sessions ≈ 4,5 Mbit/s |
| Worst Case: 400 Spieler alle über TURN | ≈ 22 Mbit/s, coturn-CPU einstellig |
| Signaling-RAM | ≈ 5 KB pro Idle-Verbindung → 400 Verbindungen ≈ 2 MB; Prozess gesamt < 100 MB |
| Unity-WebGL-Build | 10–15 MB pro Console-Load; 1000 Loads ≈ 15 GB/Monat |
| Room-Codes | 5 Zeichen Crockford-Base32 (`0-9 A-Z` ohne I, L, O, U) = 32⁵ = 33.554.432 |
| Brute-Force | 100 aktive Räume → Treffer pro Rateversuch 3·10⁻⁶; globales Limit 300 Fehlversuche/min → ≈ 19 h bis zum erwarteten ersten Treffer, Codes leben nur Stunden |
| Chromium | max. 500 RTCPeerConnections pro Renderer-Prozess; wir nutzen ≤ 8 |
| Skalierungs-Trigger | dauerhaft > 5000 Verbindungen ODER coturn/caddy-CPU > 70 % ODER Traffic > 15 TB/Monat |

## Kosten (Stand 2026-09-03, EU-Standort; vor Buchung im Hetzner-Preisdialog prüfen)
| Position | netto/Monat | brutto (19 %) |
|---|---|---|
| Hetzner CX23 (Alternative CAX11: 5,99 €) | 5,49 € | 6,53 € |
| Primary IPv4 | 0,50 € | 0,60 € |
| IPv6 /64, Let's Encrypt, Hetzner DNS, Uptime Kuma zu Hause | 0 € | 0 € |
| Domain .de (jährlich ≈ 5 €) | ≈ 0,40 € | ≈ 0,48 € |
| **Summe** | **≈ 6,40 €** | **≈ 7,60 €** |

Traffic-Overage (≈ 1 €/TB) erst ab 20 TB. Temporärer Staging-/Lasttest-Server wird stundenweise abgerechnet (Cents pro Nachmittag).

## Platzhalter (überall gleich schreiben)
| Platzhalter | Bedeutung | Wert |
|---|---|---|
| `<DOMAIN>` | Hauptdomain für Console + Controller, z. B. `wii.example.de` | |
| `<TURN_HOST>` | immer `turn.<DOMAIN>` | |
| `<SERVER_IPV4>` | Public IPv4 des VPS | |
| `<SERVER_IPV6>` | Public IPv6 des VPS (endet auf `::1`) | |
| `<TURN_SECRET>` | `openssl rand -hex 32` | |
| `<ADMIN_IP>` | eigene öffentliche IP für SSH (optional) | |
| `<EMAIL>` | Kontakt für Let's Encrypt | |
| `<REPO_URL>` | Git-Repo mit Compose/Configs/signaling (SSH- oder HTTPS-URL) | |
| `<BUILDNAME>` | Name der Unity-Build-Dateien (`Build/<BUILDNAME>.wasm.br`) | |
| `<LAN_IP>` | IP des Dev-Laptops im Heimnetz (nur lokal) | |

## Bewusst weggelassen (YAGNI) – Trigger steht in 09
TURN/TLS 5349, WebSocket-Fallback-Relay, mehrere Signaling-Instanzen, Redis, CI/CD, Cloudflare (verstößt gegen die Self-hosted-Vorgabe), Zugriffs-Logs in Caddy (Default aus → keine IP-Speicherung), fail2ban (überflüssig bei Port 22 auf `<ADMIN_IP>`), Service Worker.

## Ungeprüft / Annahmen
- Hetzner-Preise nach der Anpassung vom 15.06.2026 aus Sekundärquellen (CX23 5,49 €, CAX11 5,99 €, IPv4 0,50 €). Maßgeblich ist der Preisdialog der Cloud Console.
- Hetzner Cloud konfiguriert die Public-IPv4 direkt auf dem Interface (kein 1:1-NAT). Zeigt `ip -4 addr` die Public-IP nicht, in 04 `--external-ip=<SERVER_IPV4>` ergänzen.
- Aufwandsschätzungen sind Erfahrungswerte für eine Person mit Docker-Kenntnissen, nicht quellenbelegt.
- Versionen zum Stichtag: Caddy 2.11.4, coturn 4.17.2-r0, Node 24 (Active LTS; Node 26 wird am 2026-10-28 LTS), ws 8.21.x. Vor dem Umsetzen Tags prüfen.
- Der TURN-Anteil von 15–20 % stammt aus Videokonferenz-Statistiken. Im Heimnetz kann er durch mDNS-Kandidaten und fehlendes NAT-Hairpinning **höher** liegen (30–50 %); der Spike in Plan 10 misst das.
- Die Spike-Messwerte (Plan 10, Abschnitt C) liegen noch nicht vor; Pointer-Gameplay, Sensor-Rate und Latenzbudget sind bis dahin Annahmen.
