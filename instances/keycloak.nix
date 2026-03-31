# Seed keycloak instance — OIDC identity provider
#
# Multi-tenant Keycloak for user authentication across seed instances.
# Runs behind Caddy (platform ACME for TLS). PostgreSQL local DB.
# Each tenant gets a realm with self-serve metadata export.
#
# Large tier (4 vCPU / 4GB) — JVM needs headroom.
{ config, lib, pkgs, ... }:

let
  dbPasswordFile = config.sops.secrets.keycloak-db-password.path;
in {
  seed.size = "l";
  seed.expose.https.enable = true;
  seed.dns.names = [ "id.loom.farm" ];
  seed.storage.data = { size = "5Gi"; mountPoint = "/var/lib/postgresql"; user = "postgres"; group = "postgres"; mode = "0750"; };
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  # One-time migration: PVC was at /seed/storage/data with data in postgresql/
  # subdir. Now PVC is mounted at /var/lib/postgresql, so rename postgresql/ to
  # 17/ (NixOS default dataDir includes version suffix).
  system.activationScripts.migratePostgresql = {
    deps = [ "specialfs" ];
    text = ''
      dir="/var/lib/postgresql"
      if [ -d "$dir/postgresql" ] && [ ! -d "$dir/17" ]; then
        echo "migrating postgresql/ to 17/"
        mv "$dir/postgresql" "$dir/17"
        chown -R postgres:postgres "$dir/17"
      fi
    '';
  };

  # sops secrets via vTPM
  sops.defaultSopsFile = ../secrets/keycloak.yaml;
  sops.secrets.keycloak-db-password.mode = "0444";

  # PostgreSQL — local, same VM. Default dataDir is /var/lib/postgresql/<version>,
  # backed by the postgresql PVC.
  services.postgresql.enable = true;

  services.keycloak = {
    enable = true;

    database = {
      type = "postgresql";
      createLocally = true;
      passwordFile = dbPasswordFile;
    };

    settings = {
      # Public hostname — Caddy terminates TLS, Keycloak serves HTTP only
      hostname = "id.loom.farm";
      proxy-headers = "xforwarded";
      http-enabled = true;
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

  # Kata VMs (boot.isContainer=true) don't support systemd LoadCredential.
  # Override the init and main services to read password files directly.
  systemd.services.keycloakPostgreSQLInit.serviceConfig.LoadCredential = lib.mkForce [];
  systemd.services.keycloakPostgreSQLInit.script = lib.mkForce ''
    set -o errexit -o pipefail -o nounset -o errtrace
    shopt -s inherit_errexit

    create_role="$(mktemp)"
    trap 'rm -f "$create_role"' EXIT

    db_password="$(<"${dbPasswordFile}")"
    db_password="''${db_password//\'/\'\'}"

    echo "CREATE ROLE keycloak WITH LOGIN PASSWORD '$db_password' CREATEDB" > "$create_role"
    psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='keycloak'" | grep -q 1 || psql -tA --file="$create_role"
    psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'keycloak'" | grep -q 1 || psql -tAc 'CREATE DATABASE "keycloak" OWNER "keycloak"'

    # Clear stale JDBC_PING members — single-replica, no valid entries at boot.
    # Table is lowercase "jgroups_ping" in Keycloak 26.x (not "JGROUPSPING").
    psql -d keycloak -c 'DELETE FROM jgroups_ping;' 2>/dev/null || true
  '';

  # Keycloak main service: replace LoadCredential with a fake credentials
  # dir. The module's ExecStartPre runs replace-secret against
  # $CREDENTIALS_DIRECTORY — we populate it via tmpfiles + env override.
  systemd.services.keycloak.serviceConfig.LoadCredential = lib.mkForce [];
  systemd.services.keycloak.environment.CREDENTIALS_DIRECTORY = "/run/keycloak/credentials";
  systemd.services.keycloak.preStart = lib.mkBefore ''
    mkdir -p /run/keycloak/credentials
    cp ${dbPasswordFile} /run/keycloak/credentials/${builtins.baseNameOf dbPasswordFile}
  '';

}
