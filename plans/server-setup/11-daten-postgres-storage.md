# 11 – Daten: Postgres und S3-Bucket (Garage), self-hosted
**Ziel:** Postgres und ein S3-kompatibler Bucket laufen auf demselben VPS im Docker-Netz, sind von außen unerreichbar, werden nachts gesichert und aufs Heimgerät kopiert. Monitoring läuft ebenfalls selbst (Uptime Kuma zu Hause).
**Voraussetzungen:** 06 läuft (Services `postgres` und `garage` sind in `files/compose.yaml` enthalten). `files/garage.toml`. Ein Heimgerät, das nachts läuft (Pi, NAS, alter Laptop), mit Docker und SSH-Key für den VPS.
**Definition of Done:**
- [ ] `docker compose ps`: `postgres` healthy, `garage` Up; `nc -zv <SERVER_IPV4> 5432 3900` → Timeout
- [ ] `db/001_init.sql` eingespielt; `select count(*) from scores` läuft aus dem Signaling-Container
- [ ] Bucket `uploads` mit App-Key angelegt; Put/Get aus dem Signaling-Container getestet
- [ ] Nächtliche Dumps unter `/opt/wii/backups/`, Restore in Scratch-DB geübt; Heimgerät zieht Backups per `rsync`
- [ ] Uptime Kuma auf dem Heimgerät alarmiert bei `docker compose stop signaling`

## Was wohin
| Daten | Ort |
|---|---|
| Räume, Slots, Reconnect-Tokens | In-Memory im Signaling (Lebensdauer Stunden, Verlust bei Neustart gewollt) |
| Bestenlisten, Accounts, Telemetrie (Pfad je Session), Metadaten zu Uploads | Postgres, Schema als SQL-Dateien in `db/` |
| Uploads (Avatare, Levels, Replays, Screenshots) | Garage-Bucket `uploads`; öffentliche Auslieferung über Caddy `/files/*` |
| Unity-Build, Next-Export | weiterhin Release-Ordner + Caddy (02/06), nicht im Bucket |
| Backups | `/opt/wii/backups/` auf dem VPS **und** Kopie auf dem Heimgerät |

Bucket-Software ist **Garage** (v2.3.0, AGPL, ein Rust-Binary, S3-API): MinIO liefert seit 10/2025 keine Community-Images mehr, das Repo ist seit 02/2026 archiviert.

## Schritte
1. `.env` ergänzen und `garage.toml` befüllen:
   ```sh
   cd /opt/wii && umask 077 && printf 'POSTGRES_PASSWORD=%s\nGARAGE_RPC_SECRET=%s\nGARAGE_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 24)" "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" >> .env
   sed -i "s|<GARAGE_RPC_SECRET>|$(grep GARAGE_RPC_SECRET .env | cut -d= -f2)|; s|<GARAGE_ADMIN_TOKEN>|$(grep GARAGE_ADMIN_TOKEN .env | cut -d= -f2)|" garage.toml && chmod 600 garage.toml
   docker compose up -d postgres garage && docker compose ps
   ```
2. **Postgres-Schema** (`db/001_init.sql` im Repo, weitere Dateien fortlaufend nummeriert; anwenden bei jedem Deploy, Dateien sind idempotent mit `if not exists`):
   ```sh
   docker compose exec -T postgres psql -U wii -d wii -v ON_ERROR_STOP=1 -f - < db/001_init.sql
   ```
   Start-Schema: `create table if not exists scores (id bigserial primary key, game text not null, name text not null check (length(name) <= 24), score int not null, created_at timestamptz not null default now()); create index if not exists scores_game_score on scores (game, score desc); create table if not exists sessions (id bigserial primary key, room text not null, slot smallint, path text, started_at timestamptz not null default now(), ended_at timestamptz);`
   Signaling: Paket `pg`, `new Pool({ connectionString: process.env.DATABASE_URL, max: 5 })`; Routen `GET/POST /api/scores` im selben Node-Prozess; in `caddy/site.caddy` `handle /api/* { reverse_proxy signaling:8080 }`; Rate-Limit wie `join` (03). DB-Fehler → `503`, `/healthz` bleibt 200 (Räume brauchen keine DB).
3. **Garage einrichten** (einmalig):
   ```sh
   G="docker compose exec garage /garage"
   $G status                                                     # Node-ID ablesen
   $G layout assign -z dc1 -c 20G <node-id> && $G layout apply --version 1
   $G bucket create uploads && $G key create app-key             # Key-ID + Secret → .env als S3_KEY_ID / S3_SECRET
   $G bucket allow --read --write uploads --key app-key
   $G bucket website --allow uploads                             # nur wenn Dateien öffentlich abrufbar sein sollen
   ```
   Zugriff aus dem Signaling: Endpoint `http://garage:3900`, Region `garage`, Path-Style, `@aws-sdk/client-s3`. Öffentliche Auslieferung in `site.caddy`: `handle /files/* { uri strip_prefix /files; reverse_proxy garage:3902 { header_up Host uploads.web.garage.localhost } }`. Uploads nur über den Signaling-Prozess (Größenlimit 5 MB, Typprüfung), nie direkt in den Bucket.
4. **Backups** (`crontab -e` als root auf dem VPS):
   ```
   15 3 * * * cd /opt/wii && docker compose exec -T postgres pg_dump -U wii -Fc wii > backups/pg-$(date +\%F).dump && find backups -name 'pg-*.dump' -mtime +14 -delete
   30 3 * * * cd /opt/wii && docker compose exec -T garage /garage meta snapshot >/dev/null 2>&1
   ```
   Heimgerät (Cron 04:30): `rsync -az root@<DOMAIN>:/opt/wii/backups/ ~/wii-backups/pg/ && rsync -az root@<DOMAIN>:/opt/wii/garage/ ~/wii-backups/garage/` (Garage-Datenblöcke sind inhaltsadressiert und unveränderlich; der Meta-Snapshot liegt im selben Ordner).
   Restore-Übung: `docker compose exec -T postgres pg_restore -U wii -d postgres --create < backups/pg-<datum>.dump` erzeugt `wii` neu – vorher in eine Scratch-DB (`-d wii_test` nach `createdb wii_test`).
5. **Uptime Kuma** auf dem Heimgerät:
   ```sh
   docker run -d --name kuma --restart unless-stopped -p 3001:3001 -v kuma:/app/data louislam/uptime-kuma:2
   ```
   Monitore: HTTP-Keyword `https://<DOMAIN>/healthz` → `"ok":true`; TCP `turn.<DOMAIN>:3478`. Benachrichtigung: SMTP des eigenen Mail-Anbieters oder ntfy auf demselben Heimgerät.
6. **Ressourcen** nach einer Woche prüfen: `free -m`, `docker stats --no-stream`, `df -h`. Postgres ≈ 50–150 MB, Garage ≈ 100–300 MB. Dauerhaft Swap in Benutzung → CX33 (09); > 25 GB Nutzdaten → Hetzner Volume für `garage/`.

## Abnahmetest
```sh
nc -zv -w 3 <SERVER_IPV4> 5432 3900 3903                                          # alle Timeout
docker compose exec -T postgres psql -U wii -d wii -c 'select count(*) from scores;'
docker compose exec signaling node -e "fetch('http://garage:3900/').then(r=>console.log(r.status))"   # 403/400 = erreichbar
ls -l /opt/wii/backups | tail -2; ssh <heimgerät> 'ls ~/wii-backups/pg | tail -1'
```

## Rollback
`docker compose stop postgres garage` – Spielbetrieb läuft weiter (Räume brauchen keine DB), `/api` antwortet 503. Volumes `pg_data` und `garage/` bleiben; Backups liegen zusätzlich zu Hause.

## Stolperfallen
- Postgres-Major-Upgrade (18 → 19) ist Dump + Restore, kein Image-Tausch; Tag auf Major pinnen.
- `pg_dump` in den Bucket auf demselben Server ist kein Backup – Off-site ist das Heimgerät.
- `garage.toml` enthält Secrets → `.gitignore`. Garage-Upgrades: Release Notes lesen (v1 → v2 hatte eine Migration).
- Ein DB-Ausfall darf den Signaling-Prozess nie beenden: Pool-Fehler fangen.
- Uploads brauchen Löschkonzept und Absatz in der Datenschutzerklärung (07).

## Nicht Teil dieses Plans
Compose-Grundgerüst → 06; Monitoring-Details → 07; Skalierung → 09.
