# Seed DNS instance — PowerDNS authoritative nameserver for loom.farm
#
# Provides authoritative DNS (port 53 TCP+UDP) and an internal HTTP API
# (port 8081) for record management. SQLite-backed, data persisted to PVC.
{ config, pkgs, lib, ... }:

{
  seed.size = "xs";
  seed.expose.dns = { port = 53; protocol = "dns"; };
  seed.expose.api = { port = 8081; protocol = "tcp"; };
  seed.storage.data = "1Gi";

  services.powerdns = {
    enable = true;
    extraConfig = ''
      launch=gsqlite3
      gsqlite3-database=/seed/storage/data/pdns.db
      primary=yes
      local-address=0.0.0.0
      local-port=53
      api=yes
      api-key=seed-internal
      webserver=yes
      webserver-address=0.0.0.0
      webserver-port=8081
      webserver-allow-from=0.0.0.0/0
      loglevel=4
      log-dns-queries=no
      cache-ttl=60
      zone-cache-refresh-interval=0
    '';
  };

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
}
