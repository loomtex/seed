# Seed DNS instance — PowerDNS authoritative nameserver for loom.farm
#
# Provides authoritative DNS (port 53 TCP+UDP) and an internal HTTP API
# (port 8081) for record management. SQLite-backed, data persisted to PVC.
#
# Static records (SOA, NS, glue) are defined below and applied on each boot
# via pdns-sync-zones. Ephemeral records (ACME DNS-01, etc.) added via the
# API are untouched by the sync — it only manages records in its manifest.
{ config, pkgs, lib, ... }:

let
  zone = "loom.farm.";

  # Bootstrap records — SOA, NS, glue, and infrastructure hosts.
  # Application records are managed by SeedDNSRecord CRDs and synced to pdns
  # by the controller's DNS reconciler.
  #
  # silo.loom.farm is included here because the controller needs to resolve it
  # to fetch flakes — it must exist before the CRD reconciler can run.
  # The CRD reconciler uses REPLACE (idempotent), so both sources coexist safely.
  rrsets = [
    { name = zone; type = "SOA"; ttl = 300;
      records = [{ content = "ns1.loom.farm. hostmaster.loom.farm. 2026031301 10800 3600 604800 300"; }]; }
    { name = zone; type = "NS"; ttl = 300;
      records = [{ content = "ns1.loom.farm."; } { content = "ns2.loom.farm."; }]; }
    { name = "ns1.${zone}"; type = "A"; ttl = 300;
      records = [{ content = "96.30.193.227"; }]; }
    { name = "ns1.${zone}"; type = "AAAA"; ttl = 300;
      records = [{ content = "2001:19f0:5400:20a7::1"; }]; }
    { name = "ns2.${zone}"; type = "A"; ttl = 300;
      records = [{ content = "96.30.193.227"; }]; }
    { name = "ns2.${zone}"; type = "AAAA"; ttl = 300;
      records = [{ content = "2001:19f0:5400:20a7::2"; }]; }
    # Bootstrap: silo is the git server the controller fetches flakes from.
    # Address is the IPv6 route block address (deterministic, from flake.nix).
    { name = "silo.${zone}"; type = "AAAA"; ttl = 300;
      records = [{ content = "2001:19f0:5400:20a7::8"; }]; }
  ];

  zoneData = pkgs.writeText "loom-farm-zone.json" (builtins.toJSON {
    inherit rrsets;
  });

  syncScript = pkgs.writeShellScript "pdns-sync-zones" ''
    set -euo pipefail

    # Skip if identity not yet available (fresh TPM, no secrets decrypted)
    if [ ! -f "${config.sops.secrets.pdns-api-key.path}" ]; then
      echo "API key not available (no identity yet?), skipping zone sync"
      exit 0
    fi

    API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})
    API="http://127.0.0.1:8081/api/v1/servers/localhost"
    DESIRED=${zoneData}
    TAG="seed:bootstrap"
    NOW=$(date +%s)

    # Wait for pdns API (up to 30s)
    for i in $(seq 1 30); do
      curl -sf -H "X-API-Key: $API_KEY" "$API" > /dev/null && break
      sleep 1
    done

    # Create zone if it doesn't exist
    if ! curl -sf -H "X-API-Key: $API_KEY" "$API/zones/${zone}" > /dev/null 2>&1; then
      curl -sf -X POST -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
        -d '{"name":"${zone}","kind":"Native","nameservers":[]}' \
        "$API/zones"
    fi

    # Mark: build REPLACE patch with comment tag on each rrset
    REPLACE=$(jq --arg tag "$TAG" --argjson now "$NOW" \
      '{rrsets: [.rrsets[] | . + {changetype: "REPLACE", records: [.records[] | . + {disabled: false}], comments: [{content: $tag, account: "pdns-sync", modified_at: $now}]}]}' \
      "$DESIRED")

    curl -sf -X PATCH -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
      -d "$REPLACE" "$API/zones/${zone}"

    # Sweep: delete any rrsets tagged seed:bootstrap that aren't in desired
    DESIRED_KEYS=$(jq -r '.rrsets[] | "\(.name)|\(.type)"' "$DESIRED")
    ZONE_DATA=$(curl -sf -H "X-API-Key: $API_KEY" "$API/zones/${zone}?rrsets=true")
    ORPHANS=$(echo "$ZONE_DATA" | jq --arg tag "$TAG" --arg desired "$DESIRED_KEYS" '
      ($desired | split("\n") | map(select(. != ""))) as $keys |
      {rrsets: [.rrsets[] | select(.comments // [] | any(.content == $tag)) |
        {key: "\(.name)|\(.type)", name, type} |
        select(.key as $k | $keys | index($k) | not) |
        {name, type, changetype: "DELETE", records: []}]}')

    ORPHAN_COUNT=$(echo "$ORPHANS" | jq '.rrsets | length')
    if [ "$ORPHAN_COUNT" -gt 0 ]; then
      echo "Sweeping $ORPHAN_COUNT orphaned bootstrap record(s)"
      curl -sf -X PATCH -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
        -d "$ORPHANS" "$API/zones/${zone}"
    fi
  '';
in
{
  seed.expose.dns.enable = true;
  seed.expose.api = { port = 8081; };
  seed.storage.data = "1Gi";

  # Persist pdns state across pod restarts via PVC bind mounts.
  # pdns writes to its default paths; the persist module bind-mounts
  # them from the PVC so the data survives pod restarts.
  seed.persist."/seed/storage/data" = {
    directories = [
      { directory = "/var/lib/pdns"; user = "pdns"; group = "pdns"; mode = "0755"; }
    ];
  };

  # sops-nix: decrypt API key using the instance's TPM-backed age identity
  sops.defaultSopsFile = ../secrets/dns.yaml;
  sops.secrets.pdns-api-key = {};

  services.powerdns = {
    enable = true;
    extraConfig = ''
      launch=gsqlite3
      gsqlite3-database=/var/lib/pdns/pdns.db
      primary=yes
      local-address=0.0.0.0, ::
      local-port=53
      api=yes
      include-dir=/run/pdns/conf.d
      webserver=yes
      webserver-address=0.0.0.0
      webserver-port=8081
      webserver-allow-from=0.0.0.0/0
      loglevel=4
      log-dns-queries=no
      cache-ttl=60
      zone-cache-refresh-interval=0
      socket-dir=/run/pdns
    '';
  };

  # pdns needs /run/pdns for its control socket
  systemd.services.pdns.serviceConfig.RuntimeDirectory = "pdns";

  # Pre-start: fix stale zone metadata + inject secrets
  systemd.services.pdns.serviceConfig.ExecStartPre = lib.mkAfter [
    "+${pkgs.writeShellScript "pdns-pre-start" ''
      # Clear INCEPTION-INCREMENT SOA-EDIT-API metadata — removed in pdns 4.9,
      # causes 500 on all record updates (including ACME DNS-01 challenges).
      if [ -f /var/lib/pdns/pdns.db ]; then
        ${pkgs.sqlite}/bin/sqlite3 /var/lib/pdns/pdns.db \
          "DELETE FROM domainmetadata WHERE kind IN ('SOA-EDIT-API','SOA-EDIT') AND content='INCEPTION-INCREMENT';"
      fi

      # Ensure pdns user owns the database and WAL files
      chown pdns:pdns /var/lib/pdns/pdns.db*

      # Inject sops-decrypted API key into pdns config (if available).
      # On a fresh node with no identity, pdns starts without an API key.
      mkdir -p /run/pdns/conf.d
      if [ -f "${config.sops.secrets.pdns-api-key.path}" ]; then
        echo "api-key=$(cat ${config.sops.secrets.pdns-api-key.path})" > /run/pdns/conf.d/secrets.conf
        chown pdns:pdns /run/pdns/conf.d/secrets.conf
        chmod 0400 /run/pdns/conf.d/secrets.conf
      fi
    ''}"
  ];

  # Initialize SQLite schema if missing (handles empty db files too)
  systemd.services.pdns-init-db = {
    description = "Initialize PowerDNS SQLite database";
    wantedBy = [ "pdns.service" ];
    before = [ "pdns.service" ];
    serviceConfig = {
      Type = "oneshot";
      User = "pdns";
      Group = "pdns";
      ExecStart = pkgs.writeShellScript "pdns-init-db" ''
        DB=/var/lib/pdns/pdns.db
        if ${pkgs.sqlite}/bin/sqlite3 "$DB" "SELECT 1 FROM records LIMIT 1" 2>/dev/null; then
          echo "Schema exists, preserving records"
          exit 0
        fi
        echo "Initializing schema..."
        ${pkgs.sqlite}/bin/sqlite3 "$DB" < ${pkgs.pdns}/share/doc/pdns/schema.sqlite3.sql
      '';
    };
  };

  # Apply static DNS records on each boot via pdns API
  systemd.services.pdns-sync-zones = {
    description = "Apply static DNS records to PowerDNS";
    wantedBy = [ "multi-user.target" ];
    after = [ "pdns.service" ];
    requires = [ "pdns.service" ];
    path = [ pkgs.curl pkgs.jq ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = syncScript;
    };
  };
}
