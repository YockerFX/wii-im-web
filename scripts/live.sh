#!/bin/sh
# Oeffentlicher Live-Test-Server: cloudflared Quick Tunnel -> lokaler signaling-Server (Static aus ./out).
# Ohne VPS, ohne Account, echtes HTTPS-Zertifikat -> Handys brauchen keine Root-CA.
# ponytail: Quick Tunnel = neue Zufalls-URL bei jedem Start; feste Domain erst mit Plan 01/02 auf dem VPS.
#
# Ein Quick Tunnel ueberlebt keinen Netzwechsel und kein Standby: nach dem Aufwachen im Buero
# hing cloudflared 35 min in "Retrying connection in up to 1m4s" (Tunnel-Log 2026-09-04), die
# URL war tot, stand aber noch im Terminal. Deshalb: Transport http2 (TCP 443 statt QUIC/UDP,
# kommt auch durch Firmen-Firewalls; CF_PROTOCOL=quic schaltet zurueck) und ein Neustart mit
# neuer URL, sobald der Tunnel ~2 min nicht mehr registriert ist.
set -u
cd "$(dirname "$0")/.."
PORT=${PORT:-8090}
CF=${CF:-$HOME/.local/bin/cloudflared}
[ -x "$CF" ] || CF=$(command -v cloudflared)
LOG=$(mktemp)
TUN=''; SRV=''

stop() { for p in $TUN $SRV; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; TUN=''; SRV=''; }
trap 'stop; exit 0' INT TERM
trap 'stop' EXIT

while :; do
  : >"$LOG"
  "$CF" tunnel --url "http://localhost:$PORT" --protocol "${CF_PROTOCOL:-http2}" --grace-period 2s \
    --no-autoupdate >"$LOG" 2>&1 &
  TUN=$!
  URL=''; i=0
  while [ $i -lt 60 ]; do
    URL=$(grep -om1 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG" || true)
    [ -n "$URL" ] && break
    kill -0 "$TUN" 2>/dev/null || break
    sleep 1; i=$((i + 1))
  done
  if [ -z "$URL" ]; then
    echo "Tunnel-URL nicht gefunden (kein Netz?) – neuer Versuch in 10 s. Letzte Zeilen:"; tail -3 "$LOG"
    stop; sleep 10; continue
  fi

  echo
  echo "  Console (Laptop):  $URL/"
  echo "  Controller (Handy): $URL/controller"
  echo "  Tunnel-Log:         $LOG"
  echo

  # localhost bleibt erlaubt: der Laptop kommt so auch dann an die Console, wenn der
  # lokale Resolver die Tunnel-Domain nicht aufloest.
  # Im Test haelt das Handy die Verbindung nicht immer: Slot und Raum bleiben 10 min
  # statt 2 min bzw. 1 min reserviert, damit ein Netz-Aussetzer die Sitzung nicht beendet.
  (cd signaling && exec env PORT="$PORT" STATIC_DIR=../out ALLOWED_ORIGINS="$URL,http://localhost:$PORT" \
    SLOT_RESERVED_MS=600000 HOST_AWAY_MS=600000 TURN_SECRET="${TURN_SECRET:-dev}" node server.js) &
  SRV=$!

  # Tunnel-Wache: steht als letztes Ereignis ein Retry mit 1m4s Backoff (= 6 Fehlversuche am
  # Stueck, ~2 min ohne Registrierung), ist der Tunnel tot -> Neustart mit neuer URL.
  while kill -0 "$TUN" 2>/dev/null && kill -0 "$SRV" 2>/dev/null; do
    if grep -E 'Registered tunnel connection|Retrying connection in up to 1m4s' "$LOG" | tail -1 | grep -q Retrying; then
      echo "Tunnel seit ~2 min weg (Netzwechsel/Standby?) – Neustart mit neuer URL"; break
    fi
    sleep 5
  done
  stop
done
