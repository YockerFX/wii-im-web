#!/bin/sh
# Prüft die Auslieferung nach jedem Static-Deploy. Aufruf: sh scripts/check-static.sh https://<DOMAIN> <BUILDNAME>
set -u
H=${1:?Aufruf: check-static.sh https://<DOMAIN> <BUILDNAME>}; B=${2:?BUILDNAME fehlt}; fail=0
chk() { curl -sI "$1" | grep -qiE "$2" || { echo "FEHLT: $1 → $2"; fail=1; }; }
chk "$H/Build/$B.wasm.br"          '^content-encoding: br'
chk "$H/Build/$B.wasm.br"          '^content-type: application/wasm'
chk "$H/Build/$B.wasm.br"          '^cache-control: .*immutable'
chk "$H/Build/$B.data.br"          '^content-encoding: br'
chk "$H/Build/$B.framework.js.br"  '^content-type: application/javascript'
chk "$H/controller"                '^HTTP/[0-9.]+ 200'
chk "$H/"                          '^cache-control: no-cache'
chk "$H/"                          '^strict-transport-security'
chk "$H/"                          '^content-security-policy: .*wasm-unsafe-eval'
curl -s "$H/healthz" | grep -q '"ok":true' || { echo "FEHLT: $H/healthz (ok, solange Signaling noch nicht läuft)"; fail=1; }
[ "$fail" -eq 0 ] && echo OK
exit "$fail"
