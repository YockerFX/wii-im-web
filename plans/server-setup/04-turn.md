# 04 – TURN/STUN mit coturn
**Ziel:** coturn liefert STUN und TURN (UDP + TCP auf 3478) mit zeitlich begrenzten HMAC-Credentials, kann nicht ins interne Netz relayen und ist in Bandbreite und Allocations begrenzt.
**Voraussetzungen:** 01 (Firewall, IPs), 03 (Credential-Format), `.env` mit `DOMAIN`, `SERVER_IPV4`, `SERVER_IPV6`, `TURN_SECRET` (06). Vorlagen: `files/turnserver.conf`, `files/compose.yaml` (Service `coturn`), `files/scripts/turn-cred.sh`. Für Negativtests: coturn-Tools lokal (`brew install coturn` / `apt install coturn`).
**Definition of Done:**
- [ ] Trickle-ICE-Test zeigt je einen `relay`-Kandidaten mit `<SERVER_IPV4>` für `?transport=udp` und `?transport=tcp` – auch aus dem Mobilfunknetz
- [ ] Derselbe Test mit abgelaufenen Credentials (`TTL=-3600`) liefert **keinen** relay-Kandidaten
- [ ] `turnutils_uclient … -e 169.254.169.254` wird abgewiesen (403)
- [ ] `docker compose logs coturn` ohne `ERROR`/`cannot bind`

## Schritte
1. `files/turnserver.conf` → Repo-Root. Enthält nur statische Härtung, identisch für dev und prod:
   - `listening-port=3478`, `min-port=49152`, `max-port=50175` (= Firewall-Range aus 01)
   - `use-auth-secret`, `fingerprint`, `stale-nonce=600`, `max-allocate-lifetime=3600`
   - Quotas: `user-quota=12` (pro Spieler-Username), `total-quota=800`, `max-bps=250000` (pro Session), `bps-capacity=12500000` (≈ 100 Mbit/s gesamt)
   - `no-tls` (kein Zertifikat nötig; DTLS/CLI sind seit 4.17 standardmäßig aus), `no-tcp-relay` (RFC 6062 braucht WebRTC nicht), `no-multicast-peers`, `no-software-attribute`, `pidfile=/tmp/turnserver.pid`
   - `no-rfc5780`, `response-origin-only-with-rfc5780` (gegen STUN-Amplification)
   - `denied-peer-ip=…` für 0/8, 10/8, 100.64/10, 127/8, **169.254/16 (Hetzner-Metadaten)**, **172.16/12 (Docker-Bridge)**, 192.168/16, Test-/Multicast-Netze, `::1`, IPv4-mapped IPv6, `64:ff9b::/96`, `fc00::/7`, `fe80::/10`
2. Server-spezifisches kommt **per CLI aus `.env`** (Service `coturn` in `compose.yaml`): `--realm=turn.<DOMAIN>`, `--listening-ip=<SERVER_IPV4>`, `--listening-ip=<SERVER_IPV6>`, `--relay-ip=<SERVER_IPV4>`, `--relay-ip=<SERVER_IPV6>`, `--static-auth-secret=<TURN_SECRET>`, `--log-file=stdout`. Image `coturn/coturn:4.17.2-r0`, `network_mode: host`, `cap_drop: [ALL]`, Prozess läuft als `nobody`.
   Ohne explizite `listening-ip`/`relay-ip` würde coturn auch Docker-Bridge-Adressen (172.17.0.1) als Relay-Kandidaten verteilen.
3. Starten und Bind prüfen:
   ```sh
   cd /opt/wii && docker compose up -d coturn && docker compose logs coturn | grep -iE 'listener|error'
   ss -ulnp | grep 3478        # <SERVER_IPV4>:3478 und [<SERVER_IPV6>]:3478
   ```
4. Test-Credentials (lokal, Secret aus `.env`): `TURN_SECRET=… sh scripts/turn-cred.sh` → `username`, `credential`. Abgelaufene: `TTL=-3600 TURN_SECRET=… sh scripts/turn-cred.sh`.
5. **Trickle-ICE-Test**: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/ – URI `turn:turn.<DOMAIN>:3478?transport=udp`, Username/Password aus Schritt 4, „IceTransports value“ = `relay`, „Gather candidates“ → Zeile Type `relay`, Address `<SERVER_IPV4>`. Wiederholen mit `?transport=tcp`, mit abgelaufenen Credentials (kein relay) und vom Handy im Mobilfunknetz.
6. **Negativtest Relay ins interne Netz** (vom Laptop):
   ```sh
   turnutils_uclient -u <username> -w <credential> -e 169.254.169.254 turn.<DOMAIN>    # muss mit 403 (Forbidden IP) scheitern
   turnutils_stunclient turn.<DOMAIN>                                                   # zeigt eigene Public-IP: STUN läuft anonym
   ```

## Abnahmetest
Die vier DoD-Punkte. Zusätzlich `docker compose logs coturn | grep -ci quota` = 0 nach einem Spielabend.

## Rollback
`docker compose stop coturn` – Spiele im selben Netz laufen weiter (direkte Kandidaten), nur Relay-Nutzer verlieren. Config: vorherige `turnserver.conf` aus Git holen und `docker compose up -d coturn`.

## Stolperfallen
- Fehlende UDP-Range in der Hetzner-Firewall: TURN/UDP „verbindet nicht“ ohne Fehlermeldung. Range in 01 und `turnserver.conf` müssen identisch sein.
- Credentials sind Unix-Timestamps; Clock-Drift = sofort „abgelaufen“ (NTP-Check in 01).
- `network_mode: host` ignoriert `ports:`; die Hetzner-Firewall ist die einzige Schranke – `denied-peer-ip` und Quotas nie kürzen.
- Im Heimnetz verbinden Handy und Laptop direkt; kaputtes TURN fällt erst in fremden Netzen auf → Mobilfunk-Test ist Pflicht, plus `?forceRelay=1` (05).
- `verbose` nur zum Debuggen (loggt IPs jeder Allocation).
- Zwei Startwarnungen `Certificate file not found` / `Private key file not found` sind mit `no-tls` normal (Vorlage wurde gegen coturn 4.17.2 getestet: sonst keine WARNING/ERROR).
- Zeigt `ip -4 addr` auf dem Host die Public-IP nicht (NAT), zusätzlich `--external-ip=<SERVER_IPV4>` ins `command`.

## Variante B: Cloudflare Realtime TURN statt coturn (verstößt gegen die Self-hosted-Vorgabe aus 00 – nur dokumentiert)
Wann: TURN-Traffic > ~1 TB/Monat, globale Spieler, oder Firewall-Range/coturn sollen ganz weg. Kosten: 1000 GB/Monat frei (SFU + TURN gemeinsam), danach 0,05 USD/GB. Umschalten:
1. Cloudflare-Dashboard › Realtime › TURN-Key anlegen → `TURN_KEY_ID`, `TURN_KEY_API_TOKEN` in `.env`.
2. Signaling: `iceServers()` ersetzen durch `POST https://rtc.live.cloudflare.com/v1/turn/keys/<TURN_KEY_ID>/credentials/generate-ice-servers` (Bearer-Token, Body `{"ttl":14400}`); die Antwort ist ein fertiges `iceServers`-Array (`stun/turn.cloudflare.com`, Ports 3478/53/80/443 inkl. TLS).
3. `coturn` aus `compose.yaml` entfernen; Firewall-Regeln 3478 und 49152–50175 löschen.
4. Datenschutzerklärung: Cloudflare als Auftragsverarbeiter (USA, DPA/SCC) ergänzen (07).

## Nicht Teil dieses Plans
Credential-Erzeugung im Server → 03; Client-`iceServers`/ICE-Restart → 05; TURN/TLS 5349 → 09; TURN-Lasttest → 08.
