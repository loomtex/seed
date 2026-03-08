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

  rrsets = [
    { name = zone; type = "SOA"; ttl = 3600;
      records = [{ content = "ns1.loom.farm. hostmaster.loom.farm. 2026030704 10800 3600 604800 3600"; }]; }
    { name = zone; type = "NS"; ttl = 3600;
      records = [{ content = "ns1.loom.farm."; } { content = "ns2.loom.farm."; }]; }
    { name = "ns1.${zone}"; type = "A"; ttl = 3600;
      records = [{ content = "216.128.141.222"; }]; }
    { name = "ns1.${zone}"; type = "AAAA"; ttl = 3600;
      records = [{ content = "2001:19f0:6402:7eb::1"; }]; }
    { name = "ns2.${zone}"; type = "A"; ttl = 3600;
      records = [{ content = "216.128.141.222"; }]; }
    { name = "ns2.${zone}"; type = "AAAA"; ttl = 3600;
      records = [{ content = "2001:19f0:6402:7eb::2"; }]; }

    # Namespace wildcard — all instances in our namespace
    { name = "*.s-gaydazldmnsg.${zone}"; type = "A"; ttl = 3600;
      records = [{ content = "216.128.141.222"; }]; }
    { name = "*.s-gaydazldmnsg.${zone}"; type = "AAAA"; ttl = 3600;
      records = [{ content = "2001:19f0:6402:7eb::3"; }]; }

    # Silo — routed through web pod (Caddy for HTTPS, socat for SSH), IPv6 only
    { name = "silo.${zone}"; type = "AAAA"; ttl = 3600;
      records = [{ content = "2001:19f0:6402:7eb::3"; }]; }

    # Zone apex — can't CNAME at apex, use A/AAAA
    { name = zone; type = "A"; ttl = 3600;
      records = [{ content = "216.128.141.222"; }]; }
    { name = zone; type = "AAAA"; ttl = 3600;
      records = [{ content = "2001:19f0:6402:7eb::3"; }]; }
  ];

  zoneData = pkgs.writeText "loom-farm-zone.json" (builtins.toJSON {
    inherit rrsets;
  });

  syncScript = pkgs.writeShellScript "pdns-sync-zones" ''
    set -euo pipefail
    API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})
    API="http://127.0.0.1:8081/api/v1/servers/localhost"
    DESIRED=${zoneData}
    LAST_APPLIED="/seed/storage/data/pdns-last-applied.json"

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

    # Build REPLACE patch for all desired rrsets
    REPLACE=$(jq '{rrsets: [.rrsets[] | . + {changetype: "REPLACE", records: [.records[] | . + {disabled: false}]}]}' "$DESIRED")

    # Compute DELETE patch for rrsets removed since last apply
    DELETE='{"rrsets":[]}'
    if [ -f "$LAST_APPLIED" ]; then
      DELETE=$(jq -n \
        --slurpfile old "$LAST_APPLIED" \
        --slurpfile new "$DESIRED" \
        '{rrsets: [($old[0].rrsets // [] | map({name, type})) - ($new[0].rrsets // [] | map({name, type})) | .[] | . + {changetype: "DELETE"}]}')
    fi

    # Merge REPLACE + DELETE into a single PATCH
    PATCH=$(jq -n --argjson r "$REPLACE" --argjson d "$DELETE" \
      '{rrsets: ($r.rrsets + $d.rrsets)}')

    curl -sf -X PATCH -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
      -d "$PATCH" "$API/zones/${zone}"

    # Save desired as last-applied for next boot's diff
    cp "$DESIRED" "$LAST_APPLIED"
  '';
in
{
  seed.size = "xs";
  seed.expose.dns = { port = 53; protocol = "dns"; };
  seed.expose.api = { port = 8081; protocol = "tcp"; };
  seed.storage.data = "1Gi";

  # sops-nix: decrypt API key using the instance's TPM-backed age identity
  sops.defaultSopsFile = ../secrets/dns.yaml;
  sops.secrets.pdns-api-key = {};

  services.powerdns = {
    enable = true;
    extraConfig = ''
      launch=gsqlite3
      gsqlite3-database=/seed/storage/data/pdns.db
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
      if [ -f /seed/storage/data/pdns.db ]; then
        ${pkgs.sqlite}/bin/sqlite3 /seed/storage/data/pdns.db \
          "DELETE FROM domainmetadata WHERE kind IN ('SOA-EDIT-API','SOA-EDIT') AND content='INCEPTION-INCREMENT';"
      fi

      # Ensure pdns user owns the database and WAL files
      chown pdns:pdns /seed/storage/data/pdns.db*

      # Inject sops-decrypted API key into pdns config
      mkdir -p /run/pdns/conf.d
      echo "api-key=$(cat ${config.sops.secrets.pdns-api-key.path})" > /run/pdns/conf.d/secrets.conf
      chown pdns:pdns /run/pdns/conf.d/secrets.conf
      chmod 0400 /run/pdns/conf.d/secrets.conf
    ''}"
  ];

  # Ensure pdns user owns the storage directory
  systemd.tmpfiles.rules = [ "d /seed/storage/data 0755 pdns pdns -" ];

  # Initialize SQLite schema on first boot
  systemd.services.pdns-init-db = {
    description = "Initialize PowerDNS SQLite database";
    wantedBy = [ "pdns.service" ];
    before = [ "pdns.service" ];
    after = [ "systemd-tmpfiles-setup.service" ];
    unitConfig.ConditionPathExists = "!/seed/storage/data/pdns.db";
    serviceConfig = {
      Type = "oneshot";
      User = "pdns";
      Group = "pdns";
      ExecStart = "${pkgs.bash}/bin/bash -c '${pkgs.sqlite}/bin/sqlite3 /seed/storage/data/pdns.db < ${pkgs.pdns}/share/doc/pdns/schema.sqlite3.sql'";
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
