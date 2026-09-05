# 06 – Compose, Erst-Inbetriebnahme, Deploy, Rollback
**Ziel:** Alle drei Container laufen aus einer `compose.yaml`, überleben Reboots, und jede Änderung (Config, Signaling-Code, Static-Build) lässt sich in unter einer Minute ausrollen und zurücknehmen.
**Voraussetzungen:** 01 (Server, Repo unter `/opt/wii`), 02 (Caddyfile, Build), 03 (`signaling/`), 04 (`turnserver.conf`). Vorlagen: `files/compose.yaml`, `files/.env.example`, `files/scripts/deploy-static.sh`.
**Definition of Done:**
- [ ] `docker compose ps`: `caddy` Up, `signaling` Up (healthy), `coturn` Up, `postgres` Up (healthy), `garage` Up
- [ ] `reboot` → nach 60 s alle drei wieder Up ohne Zutun
- [ ] `curl -s https://<DOMAIN>/healthz` → `{"ok":true,…}`; `check-static.sh` → `OK`; Trickle-ICE → `relay`
- [ ] `.env` hat Rechte 600 und steht in `.gitignore`

## Repo-Layout (Repo-Root = `/opt/wii` auf dem Server)
```
compose.yaml  compose.dev.yaml  Caddyfile  Caddyfile.dev  caddy/site.caddy  turnserver.conf  garage.toml  db/*.sql  .env.example
signaling/{Dockerfile,package.json,server.js}   scripts/{deploy-static.sh,check-static.sh,turn-cred.sh}   load/signaling.js
.gitignore: .env  garage.toml  garage/  backups/  static/  caddy-root.crt  out/
static/releases/<sha>/  static/current -> releases/<sha>      (nur auf dem Server, nicht im Git)
```

## compose.yaml – Überblick (Datei: `files/compose.yaml`)
| Service | Wesentliches |
|---|---|
| `caddy` | `caddy:2.11.4-alpine`; Ports 80, 443/tcp, 443/udp; Volumes `Caddyfile`, `caddy/site.caddy`, `static/`→`/srv` (ro), `caddy_data` (Zertifikate – nie löschen), `caddy_config` |
| `signaling` | `build: ./signaling`; `env_file: .env`; `expose: 8080` (nie `ports`); `init: true`, `stop_grace_period: 15s`; `read_only`, `cap_drop: ALL`, `no-new-privileges`, `pids_limit`; Healthcheck per `node -e fetch(/healthz)` |
| `coturn` | `coturn/coturn:4.17.2-r0`; `network_mode: host`; `command` = `-c turnserver.conf` + `--realm/--listening-ip/--relay-ip/--static-auth-secret` aus `.env`; `cap_drop: ALL` |
| `postgres` | `postgres:18-alpine`; Volume `pg_data`; kein Port nach außen; Healthcheck `pg_isready`; Schema/Backups → 11 |
| `garage` | `dxflrs/garage:v2.3.0`; `garage.toml` + `./garage/` (meta, data); kein Port nach außen; Einrichtung/Backups → 11 |
Alle `restart: unless-stopped`. Log-Rotation kommt aus `/etc/docker/daemon.json` (01). `garage` braucht vor dem ersten Start eine befüllte `garage.toml` (11, Schritt 1) – bis dahin `docker compose up -d caddy signaling coturn postgres`.

## Schritte – Erst-Inbetriebnahme
1. `.env` anlegen (nur auf dem Server, nie ins Git):
   ```sh
   cd /opt/wii && umask 077 && cp .env.example .env
   sed -i "s/^TURN_SECRET=.*/TURN_SECRET=$(openssl rand -hex 32)/" .env
   sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 24)/" .env
   nano .env      # DOMAIN, SERVER_IPV4, SERVER_IPV6 eintragen; Garage-Werte → 11; Rechte prüfen: ls -l .env → -rw-------
   ```
2. Validieren: `docker compose config >/dev/null && docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile`.
3. Starten: `docker compose up -d --build`, dann `docker compose ps` und `docker compose logs --tail 50`.
4. Static-Build deployen (lokal): `sh scripts/deploy-static.sh` (rsync nach `static/releases/<sha>`, Symlink `current`, alte Releases bis auf 3 aufräumen).
5. Reboot-Test: `reboot`, 60 s warten, `docker compose ps`, `curl -s https://<DOMAIN>/healthz`.

## Schritte – laufende Deploys (auf dem Server in `/opt/wii`, außer Static)
| Was | Befehl | Prüfen |
|---|---|---|
| Static (Next/Unity) | lokal `sh scripts/deploy-static.sh` | `sh scripts/check-static.sh https://<DOMAIN> <BUILDNAME>` |
| Signaling-Code | `git pull && docker compose up -d --build signaling` | `curl -s https://<DOMAIN>/healthz`; Testraum create/join |
| Caddyfile / site.caddy | `git pull && docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile` | `check-static.sh` |
| turnserver.conf / `.env` | `git pull && docker compose up -d coturn` | Trickle-ICE `relay` (04) |
| Image-Updates (monatlich) | Tags in `compose.yaml`/`Dockerfile` anheben, `git pull && docker compose pull && docker compose up -d --build && docker image prune -f` | alle drei Prüfungen oben |
Ein Signaling-Deploy trennt kurz alle WebSockets (Close 1001); Clients kommen per `resume` zurück, laufende DataChannels bleiben bestehen.

## Rollback
| Was | Befehl |
|---|---|
| Static | `cd /opt/wii/static && ls releases && ln -sfn releases/<vorheriger-sha> current` (sofort wirksam, kein Reload) |
| Signaling / Configs | `git log --oneline -5`, dann die betroffenen Dateien (`signaling/`, `turnserver.conf`, `Caddyfile`, `caddy/`) auf den vorherigen Commit zurücksetzen und `docker compose up -d --build` |
| Host (Kernel/Docker-Upgrade) | vorher `hcloud server create-image --type snapshot wii-prod`; zurück per `hcloud server rebuild wii-prod --image <id>` |

## Stolperfallen
- `docker compose up` würde eine Datei `compose.override.yaml` automatisch mergen – die Dev-Datei heißt deshalb `compose.dev.yaml` und wird nur lokal explizit angegeben.
- Compose nutzt `.env` auch für `${VAR}` in `command:`; fehlt `SERVER_IPV6`, startet coturn mit leerem Argument und bindet nicht → `docker compose config` vorher.
- Bind-Mount ist `./static` (nicht `./static/current`), sonst wirkt ein Symlink-Wechsel erst nach Container-Neustart.
- `caddy reload` statt `restart` – ein Restart trennt alle WebSockets.
- `docker image prune` nie mit `-a`: das vorherige Signaling-Image ist der Rollback.

## Nicht Teil dieses Plans
Inhalt der Configs → 02/03/04; Monitoring und Update-Routine → 07; Tests → 08.
