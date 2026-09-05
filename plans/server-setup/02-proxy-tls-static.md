# 02 – Caddy: TLS, statische Dateien, WebSocket-Proxy
**Ziel:** `https://<DOMAIN>` liefert Next.js-Export und Unity-WebGL-Build mit korrekten Brotli-Headern; `/ws` und `/healthz` gehen an den Signaling-Container; Zertifikate kommen automatisch von Let's Encrypt.
**Voraussetzungen:** 01 fertig (DNS zeigt auf VPS, 80/443 offen). Vorlagen: `files/Caddyfile`, `files/caddy/site.caddy`, `files/compose.yaml`, `files/scripts/check-static.sh`, `files/scripts/deploy-static.sh`.
**Definition of Done:**
- [ ] `curl -sI https://<DOMAIN>/ | head -1` → `HTTP/2 200`; `curl -sI http://<DOMAIN>/ | head -1` → 308
- [ ] `sh scripts/check-static.sh https://<DOMAIN> <BUILDNAME>` → `OK` (Brotli, MIME, Cache, Routing, HSTS, CSP)
- [ ] Console-Seite lädt ohne Fehler in der DevTools-Konsole; Network-Tab zeigt `.wasm.br` mit `content-encoding: br`
- [ ] `curl -6 -sI https://<DOMAIN>/ | head -1` → 200

## Schritte
1. **Next.js** statisch exportieren (`next.config.js`):
   ```js
   module.exports = { output: 'export', images: { unoptimized: true }, trailingSlash: false };
   ```
   Routen: `/` (Console), `/controller` (PWA), `/impressum`, `/datenschutz`. `public/manifest.json` (display `standalone`, start_url `/controller`). Kein Service Worker.
2. **Unity WebGL** – Player Settings › Publishing: Compression Format **Brotli**, Decompression Fallback **aus**, Data Caching an, kein Multithreading. Build nach `public/Build/` → Dateien `<BUILDNAME>.loader.js`, `.framework.js.br`, `.wasm.br`, `.data.br`.
   Prüfen: `next build` erzeugt `out/index.html`, `out/controller.html`, `out/Build/<BUILDNAME>.wasm.br`.
3. **Caddyfile**: `files/Caddyfile` → Repo-Root (`<EMAIL>`, `<DOMAIN>` eintragen), `files/caddy/site.caddy` → `caddy/site.caddy`. Was `site.caddy` tut:
   - `header`: HSTS, `nosniff`, `X-Frame-Options DENY`, Referrer-Policy, CSP mit `'wasm-unsafe-eval'` und `blob:` (Unity braucht beides), Server-Header entfernt.
   - `handle /ws`, `handle /healthz` → `reverse_proxy signaling:8080` (WebSocket-Upgrade und `X-Forwarded-For` macht Caddy selbst).
   - `handle` (Rest): `root * /srv/current`; für `*.br` `Content-Encoding: br` plus MIME je Endung; `Cache-Control immutable` für `/Build/*` und `/_next/static/*`, sonst `no-cache`; `try_files {path} {path}.html {path}/`; `file_server`.
   - **Kein** `encode` – würde `.br`-Dateien doppelt komprimieren.
4. **Compose**: `files/compose.yaml` → Repo-Root. Nur Caddy starten (Zertifikat wird beim ersten Start geholt):
   ```sh
   cd /opt/wii && docker compose up -d caddy && docker compose logs -f caddy      # bis "certificate obtained", Ctrl-C
   ```
5. **Ersten Build deployen** (lokal, nach `next build`; `<DOMAIN>` im Skript eintragen):
   ```sh
   sh scripts/deploy-static.sh      # rsync → /opt/wii/static/releases/<git-sha>/, Symlink static/current
   ```
6. **Prüfen**: `sh scripts/check-static.sh https://<DOMAIN> <BUILDNAME>` → `OK` (der `/healthz`-Check schlägt bis 03/06 fehl – erwartbar).

## Abnahmetest
```sh
curl -sI https://<DOMAIN>/Build/<BUILDNAME>.wasm.br | grep -iE '^(content-encoding|content-type|cache-control)'
# content-encoding: br / content-type: application/wasm / cache-control: public, max-age=31536000, immutable
curl -s -o /dev/null -w '%{http_code}\n' https://<DOMAIN>/controller        # 200
curl -sI https://<DOMAIN>/ | grep -iE '^(strict-transport|content-security)'  # beide vorhanden
```
Browser: Console-Seite öffnen, DevTools › Console leer (keine „Unable to parse Build/…“, keine CSP-Meldung).

## Rollback
- Static: `ssh root@<DOMAIN> 'cd /opt/wii/static && ln -sfn releases/<alter-sha> current'`.
- Caddyfile: vor jedem Reload `docker compose exec caddy caddy validate --config /etc/caddy/Caddyfile`; zurück per `git checkout -- Caddyfile caddy && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile`.
- Volume `caddy_data` nie löschen (Let's-Encrypt-Rate-Limit: 5 Zertifikate/Woche pro Domain).

## Stolperfallen
- Der Unity-Loader fordert `*.wasm.br` **direkt** an – Caddys `precompressed`-Automatik greift nicht; die Header-Matcher in `site.caddy` sind Pflicht.
- Browser dekomprimieren Brotli nur über HTTPS – lokal daher Caddy mit `tls internal` (05).
- Unity-Multithreading braucht `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` und bricht Cross-Origin-Assets. Im MVP aus.
- `'unsafe-inline'` in der CSP bleibt, solange Unitys `index.html`-Template Inline-Script enthält. Keine `Permissions-Policy` mit `accelerometer=()`/`gyroscope=()`.
- Bind-Mount ist `./static` (nicht `./static/current`): Docker löst Symlinks beim Mounten auf; nur ein relativer Symlink **innerhalb** des Mounts wirkt bei jedem Deploy sofort.
- `manifest.json` statt `.webmanifest`: sicherer MIME-Type ohne Extra-Config.

## Nicht Teil dieses Plans
Signaling-Container → 03/06; TURN → 04; kompletter Deploy-Ablauf → 06; Impressum/Datenschutz-Inhalte → 07.
