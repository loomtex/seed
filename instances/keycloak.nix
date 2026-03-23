# Seed keycloak instance — OIDC identity provider
#
# Multi-tenant Keycloak for user authentication across seed instances.
# Runs behind Caddy (platform ACME for TLS). PostgreSQL local DB.
# Each tenant gets a realm with self-serve metadata export.
#
# Large tier (4 vCPU / 4GB) — JVM needs headroom.
{ config, pkgs, ... }:

let
  dbPasswordFile = config.sops.secrets.keycloak-db-password.path;
in {
  seed.size = "l";
  seed.expose.https.enable = true;
  seed.storage.data = "5Gi";
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  # sops secrets via vTPM
  sops.defaultSopsFile = ../secrets/keycloak.yaml;
  sops.secrets.keycloak-db-password = {};

  # PostgreSQL — local, same VM
  services.postgresql = {
    enable = true;
    dataDir = "/seed/storage/data/postgresql";
    # Keycloak module creates the DB when createLocally = true
  };

  services.keycloak = {
    enable = true;

    database = {
      type = "postgresql";
      createLocally = true;
      passwordFile = dbPasswordFile;
    };

    settings = {
      # Public hostname — Caddy terminates TLS
      hostname = "id.loom.farm";
      proxy-headers = "forwarded";
      http-host = "127.0.0.1";
      http-port = 8080;
    };
  };

  # Caddy reverse proxy — TLS via platform ACME
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, id.loom.farm {
        reverse_proxy localhost:8080
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";

  # PVC ownership — PostgreSQL runs as postgres user
  systemd.tmpfiles.rules = [
    "d /seed/storage/data 0755 root root -"
    "d /seed/storage/data/postgresql 0750 postgres postgres -"
  ];
}
