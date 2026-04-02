# Seed keycloak instance — OIDC identity provider
#
# Multi-tenant Keycloak for user authentication across seed instances.
# Runs behind Caddy (platform ACME for TLS). Uses the shared postgres
# instance via socat + openssl s_client mTLS proxy (TPM-bound SPIFFE
# cert), since Java/JDBC can't use TPM keys directly.
#
# PostgreSQL uses STARTTLS (SSLRequest then TLS handshake), so we use
# `openssl s_client -starttls postgres` which handles the negotiation.
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

  pgProxy = pkgs.writeShellScript "pg-mtls-proxy" ''
    export OPENSSL_CONF=${opensslTpm2Conf}
    export OPENSSL_MODULES=${pkgs.tpm2-openssl}/lib/ossl-modules
    exec ${pkgs.socat}/bin/socat -d -d \
      TCP-LISTEN:5432,fork,reuseaddr \
      EXEC:'${pkgs.openssl}/bin/openssl s_client -starttls postgres -connect postgres.s-gaydazldmnsg.svc.cluster.local\:5432 -cert /seed/tls/cert.pem -key /seed/tls/key.pem -CAfile /seed/tls/ca.pem -quiet'
  '';
in {
  seed.size = "l";
  seed.expose.https.enable = true;
  seed.dns.names = [ "id.loom.farm" ];
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  # mTLS proxy: socat + openssl s_client with -starttls postgres.
  # Handles PostgreSQL's STARTTLS negotiation and uses TPM-bound SPIFFE
  # cert for client auth. Keycloak connects plaintext to localhost:5432.
  systemd.services.seed-pg-proxy = {
    description = "mTLS proxy to shared PostgreSQL";
    after = [ "seed-cert-enroll.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    requires = [ "seed-cert-enroll.service" ];
    wantedBy = [ "multi-user.target" ];
    serviceConfig = {
      ExecStart = pgProxy;
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
      # Proxy is plaintext TCP — disable JDBC SSL negotiation
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
