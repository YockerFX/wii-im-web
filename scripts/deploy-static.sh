#!/bin/sh
# Lokal ausführen nach `next build` (erzeugt out/ inkl. Unity-Build in out/Build/).
# Legt /opt/wii/static/releases/<git-sha>/ an, biegt den Symlink current um, behält die letzten 3 Releases.
set -eu
H='root@<DOMAIN>'   # <DOMAIN> eintragen (Quotes lassen)
SHA=$(git rev-parse --short HEAD)
rsync -az --delete out/ "$H:/opt/wii/static/releases/$SHA/"
ssh "$H" "cd /opt/wii/static && ln -sfn releases/$SHA current && ls -dt releases/*/ | tail -n +4 | xargs -r rm -rf"
echo "deployed $SHA → https://<DOMAIN>/  (Rollback: ssh $H 'cd /opt/wii/static && ln -sfn releases/<sha> current')"
