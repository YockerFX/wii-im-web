#!/bin/sh
# Test-Credentials im coturn-REST-Format für Trickle-ICE / turnutils.
# Aufruf: TURN_SECRET=<secret> sh scripts/turn-cred.sh [userid]   – abgelaufene Credentials: TTL=-3600 ...
set -eu
: "${TURN_SECRET:?TURN_SECRET setzen}"
U="$(( $(date +%s) + ${TTL:-3600} )):${1:-test}"
P=$(printf '%s' "$U" | openssl dgst -sha1 -hmac "$TURN_SECRET" -binary | base64)
echo "username:   $U"
echo "credential: $P"
