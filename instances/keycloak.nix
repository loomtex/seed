# Seed keycloak instance — OIDC identity provider
#
# Multi-tenant Keycloak for user authentication across seed instances.
# Runs behind Caddy (platform ACME for TLS). Uses the shared postgres
# instance via an mTLS proxy (socat + TPM-bound SPIFFE cert), since
# Java/JDBC can't use TPM keys directly.
#
# Large tier (4 vCPU / 4GB) — JVM needs headroom.
{ config, lib, pkgs, ... }:

let
  dbPasswordFile = pkgs.writeText "kc-db-pw" "cert-auth-via-proxy";

  opensslTpm2Conf = pkgs.writeText "openssl-tpm2.cnf" ''
    openssl_conf = openssl_init

    [openssl_init]
    providers = provider_sect

    [provider_sect]
    default = default_sect
    tpm2 = tpm2_sect

    [default_sect]
    activate = 1

    [tpm2_sect]
    activate = 1
  '';
in {
  seed.size = "l";
  seed.expose.https.enable = true;
  seed.dns.names = [ "id.loom.farm" ];
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  # mTLS proxy: socat terminates TLS to the shared postgres instance using
  # this instance's SPIFFE cert (TPM-bound key via tpm2-openssl provider).
  # Keycloak connects to localhost:5432 plaintext → socat → postgres:5432 mTLS.
  # PostgreSQL authenticates the client cert DN via pg_ident, ignores password.
  systemd.services.seed-pg-proxy = {
    description = "mTLS proxy to shared PostgreSQL";
    after = [ "seed-cert-enroll.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    requires = [ "seed-cert-enroll.service" ];
    wantedBy = [ "multi-user.target" ];
    environment = {
      OPENSSL_CONF = toString opensslTpm2Conf;
      OPENSSL_MODULES = "${pkgs.tpm2-openssl}/lib/ossl-modules";
    };
    serviceConfig = {
      ExecStart = lib.concatStringsSep " " [
        "${pkgs.socat}/bin/socat"
        "TCP-LISTEN:5432,fork,reuseaddr"
        "OPENSSL:postgres.s-gaydazldmnsg.seed.loom.farm:5432,cert=/seed/tls/cert.pem,key=/seed/tls/key.pem,cafile=/seed/tls/ca.pem,verify=1"
      ];
      Restart = "always";
      RestartSec = "5s";
      SupplementaryGroups = [ "tpm" ];
      DeviceAllow = [ "/dev/tpmrm0 rw" ];
      BindPaths = [ "/dev/tpmrm0" ];
      ReadOnlyPaths = [ "/seed/tls" ];
    };
  };

  services.keycloak = {
    enable = true;

    database = {
      type = "postgresql";
      createLocally = false;
      host = "localhost";
      name = "keycloak";
      username = "keycloak";
      # Cert auth via proxy — PostgreSQL ignores the password, but the
      # NixOS module requires a passwordFile. Provide a dummy value.
      passwordFile = toString dbPasswordFile;
    };

    settings = {
      # Public hostname — Caddy terminates TLS, Keycloak serves HTTP only
      hostname = "id.loom.farm";
      proxy-headers = "xforwarded";
      http-enabled = true;
      http-host = "127.0.0.1";
      http-port = 8080;
      # socat proxy is plaintext TCP — disable JDBC SSL negotiation
      # (mTLS happens in the proxy, not in the JDBC driver)
      db-url-properties = lib.mkForce "?sslmode=disable";
    };
  };

  # Keycloak must wait for the mTLS proxy
  systemd.services.keycloak.after = [ "seed-pg-proxy.service" ];
  systemd.services.keycloak.requires = [ "seed-pg-proxy.service" ];

  # Kata VMs (boot.isContainer=true) don't support systemd LoadCredential.
  systemd.services.keycloak.serviceConfig.LoadCredential = lib.mkForce [];
  systemd.services.keycloak.environment.CREDENTIALS_DIRECTORY = "/run/keycloak/credentials";
  systemd.services.keycloak.preStart = lib.mkBefore ''
    mkdir -p /run/keycloak/credentials
    cp ${dbPasswordFile} /run/keycloak/credentials/${builtins.baseNameOf (toString dbPasswordFile)}
  '';

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
}
