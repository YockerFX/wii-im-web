# 01 – Domain, DNS, VPS, Firewall, Server-Basis
**Ziel:** Ein erreichbarer, gehärteter Ubuntu-24.04-VPS mit Docker, auf den die Domain-Namen zeigen.
**Voraussetzungen:** 00 gelesen; Hetzner-Cloud-Account; `hcloud` CLI (`brew install hcloud`, `hcloud context create wii`); Registrar-Zugang für die Domain; `files/cloud-init.yaml`; ein Git-Repo mit Compose/Configs (Vorlagen aus `files/`).
**Definition of Done:**
- [ ] `dig +short <DOMAIN> A` und `dig +short turn.<DOMAIN> AAAA` liefern die VPS-IPs
- [ ] `ssh root@<SERVER_IPV4> docker ps` läuft ohne Passwort; `ssh -o PubkeyAuthentication=no root@<SERVER_IPV4>` wird abgelehnt
- [ ] Von extern: Ports 22, 80, 443, 3478 antworten sofort (offen oder „refused“), 8080 und 5349 nicht
- [ ] `timedatectl` zeigt `System clock synchronized: yes`; `/etc/docker/daemon.json` enthält `max-size`; `swapon --show` zeigt 2 GB
- [ ] Repo liegt unter `/opt/wii`, `/opt/wii/static/releases` existiert

## Schritte
1. **Domain** registrieren (z. B. INWX, ≈ 5 €/Jahr für .de). DNS beim Registrar oder in der Hetzner DNS Console. Falls Cloudflare-DNS: alle Records „DNS only“ (graue Wolke).
2. **SSH-Key** anlegen und hinterlegen:
   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/wii -C wii
   hcloud ssh-key create --name wii --public-key-from-file ~/.ssh/wii.pub
   ```
3. **Firewall** (Default: alles Eingehende zu, Ausgehendes offen):
   ```sh
   hcloud firewall create --name wii
   R="hcloud firewall add-rule wii --direction in"
   $R --protocol tcp --port 22          --source-ips <ADMIN_IP>/32       # ohne feste IP: 0.0.0.0/0,::/0 (Key-Login bleibt Pflicht)
   $R --protocol tcp --port 80          --source-ips 0.0.0.0/0,::/0      # ACME HTTP-01 + Redirect
   $R --protocol tcp --port 443         --source-ips 0.0.0.0/0,::/0
   $R --protocol udp --port 443         --source-ips 0.0.0.0/0,::/0      # HTTP/3 (Caddy)
   $R --protocol tcp --port 3478        --source-ips 0.0.0.0/0,::/0      # TURN/TCP
   $R --protocol udp --port 3478        --source-ips 0.0.0.0/0,::/0      # STUN + TURN/UDP
   $R --protocol udp --port 49152-50175 --source-ips 0.0.0.0/0,::/0      # Relay-Range = turnserver.conf (04)
   $R --protocol icmp                   --source-ips 0.0.0.0/0,::/0
   ```
   Prüfen: `hcloud firewall describe wii` zeigt 8 Regeln. 5349 bleibt zu (kein TURN/TLS im MVP).
4. **Server** erstellen – cloud-init richtet SSH-Härtung, Auto-Updates (Reboot 04:30 UTC), Docker, Log-Rotation und 2 GB Swap ein:
   ```sh
   hcloud server create --type cx23 --image ubuntu-24.04 --location nbg1 \
     --ssh-key wii --firewall wii --name wii-prod --user-data-from-file files/cloud-init.yaml
   hcloud server ip wii-prod        # <SERVER_IPV4>
   hcloud server ip -6 wii-prod     # <SERVER_IPV6> (…::1)
   ```
   CX23 „not available“ → `--type cax11` (ARM, gleiche Images). Beide Werte in die Platzhalter-Tabelle (00) eintragen.
5. **DNS-Records** (TTL 300):
   ```
   <DOMAIN>        A     <SERVER_IPV4>
   <DOMAIN>        AAAA  <SERVER_IPV6>
   turn.<DOMAIN>   A     <SERVER_IPV4>
   turn.<DOMAIN>   AAAA  <SERVER_IPV6>
   ```
   Prüfen: `dig +short <DOMAIN> A` (bis 5 min warten).
6. **Cloud-init abwarten** (2–3 min):
   ```sh
   ssh -i ~/.ssh/wii root@<SERVER_IPV4> 'cloud-init status --wait && docker --version && swapon --show && timedatectl | grep synchronized'
   ```
7. **Repo auf den Server** (enthält compose.yaml, Caddyfile, caddy/, turnserver.conf, signaling/, scripts/):
   ```sh
   ssh root@<SERVER_IPV4> 'git clone <REPO_URL> /opt/wii && mkdir -p /opt/wii/static/releases && ls /opt/wii'
   ```
8. **SSH-Config** lokal, damit die Skripte `root@<DOMAIN>` nutzen können:
   ```
   Host <DOMAIN>
     User root
     IdentityFile ~/.ssh/wii
   ```

## Abnahmetest
```sh
dig +short <DOMAIN> A; dig +short <DOMAIN> AAAA; dig +short turn.<DOMAIN> A
nc -zv -w 3 <SERVER_IPV4> 22 80 443 3478      # sofortige Antwort; 80/443/3478 sind bis 02/04 "refused" – ok
nc -zv -w 3 <SERVER_IPV4> 8080 5349           # Timeout = Firewall filtert = richtig
ssh root@<DOMAIN> 'docker ps && cat /etc/docker/daemon.json && grep -rh Automatic-Reboot /etc/apt/apt.conf.d/'
```
Entscheidend: gefilterte Ports laufen in den Timeout, offene antworten sofort.

## Rollback
`hcloud server delete wii-prod` (stundenweise abgerechnet), `hcloud firewall delete wii`, DNS-Records löschen. Keine Folgekosten.

## Stolperfallen
- Der SSH-Key **muss bei der Erstellung** angegeben werden; nachträglich nur über das Rescue-System.
- Firewall-Regeln nur mit `0.0.0.0/0` sperren IPv6-Clients aus → immer `0.0.0.0/0,::/0`.
- Kein `ufw` auf dem Host: Docker umgeht es; die Hetzner-Firewall ist die einzige Firewall.
- Wechselnde Heim-IP: Port-22-Regel per `hcloud firewall` nachziehen, nicht dauerhaft global öffnen.
- unattended-upgrades rebootet um 04:30 UTC – deshalb `restart: unless-stopped` in 06 Pflicht.
- Hetzner stellt die Public-IPv4 direkt auf dem Interface bereit; prüfen mit `ip -4 addr` (sonst 04 `--external-ip`).

## Nicht Teil dieses Plans
TLS/Static → 02; Container starten → 06; Monitoring → 07.
