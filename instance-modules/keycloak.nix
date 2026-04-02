# seed.services.keycloak — Keycloak OIDC IdP with SPIFFE mTLS database proxy
#
# Wraps the NixOS keycloak module with the mTLS proxy pattern for connecting
# to a shared seed PostgreSQL instance. Java/JDBC can't use TPM-bound keys
# (TSS2 PRIVATE KEY format), so a local socat + openssl s_client proxy handles
# the SPIFFE cert auth. Keycloak connects plaintext to localhost:5432.
#
# PostgreSQL uses STARTTLS (SSLRequest → 'S' → TLS handshake), so the proxy
# uses `openssl s_client -starttls postgres` which handles the negotiation.
#
# Usage:
#   seed.services.keycloak = {
#     enable = true;
#     hostname = "id.example.com";
#     database = {
#       host = "postgres.s-abc123.svc.cluster.local";
#       name = "keycloak";
#       username = "keycloak";
#     };
#   };
#
# The instance author is responsible for ingress (Caddy/nginx + ACME)
# and seed.expose/seed.dns/seed.size configuration.
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.services.keycloak;

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
    exec ${pkgs.socat}/bin/socat \
      TCP-LISTEN:${toString cfg.database.proxyPort},fork,reuseaddr \
      EXEC:'${pkgs.openssl}/bin/openssl s_client -starttls postgres -connect ${cfg.database.host}\:${toString cfg.database.port} -cert /seed/tls/cert.pem -key /seed/tls/key.pem -CAfile /seed/tls/ca.pem -quiet'
  '';

in {
  options.seed.services.keycloak = {
    enable = lib.mkEnableOption "Keycloak OIDC IdP with SPIFFE mTLS database proxy";

    hostname = lib.mkOption {
      type = lib.types.str;
      description = "Public hostname for Keycloak (used in token issuer URLs).";
    };

    database = {
      host = lib.mkOption {
        type = lib.types.str;
        description = ''
          PostgreSQL host address. Use cluster-internal DNS
          (e.g. postgres.<namespace>.svc.cluster.local) since MetalLB
          hairpin routing doesn't work for intra-cluster traffic.
        '';
      };

      port = lib.mkOption {
        type = lib.types.port;
        default = 5432;
        description = "PostgreSQL port on the remote host.";
      };

      proxyPort = lib.mkOption {
        type = lib.types.port;
        default = 5432;
        description = "Local port for the mTLS proxy listener.";
      };

      name = lib.mkOption {
        type = lib.types.str;
        default = "keycloak";
        description = "PostgreSQL database name.";
      };

      username = lib.mkOption {
        type = lib.types.str;
        default = "keycloak";
        description = "PostgreSQL role (mapped from SPIFFE cert DN by pg_ident).";
      };
    };

    httpPort = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "HTTP port Keycloak listens on (for reverse proxy).";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = {};
      description = "Additional Keycloak settings (merged with module defaults).";
    };
  };

  config = lib.mkIf cfg.enable {
    # mTLS proxy: socat + openssl s_client with -starttls postgres.
    # Handles PostgreSQL's STARTTLS negotiation and uses TPM-bound SPIFFE
    # cert for client auth. Keycloak connects plaintext to localhost.
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
        port = cfg.database.proxyPort;
        name = cfg.database.name;
        username = cfg.database.username;
        # Cert auth via proxy — PostgreSQL ignores the password, but the
        # NixOS module requires a passwordFile. Provide a dummy value.
        passwordFile = toString dbPasswordFile;
      };

      settings = {
        hostname = cfg.hostname;
        proxy-headers = "xforwarded";
        http-enabled = true;
        http-host = "127.0.0.1";
        http-port = cfg.httpPort;
        # Proxy is plaintext TCP — disable JDBC SSL negotiation
        db-url-properties = lib.mkForce "?sslmode=disable";
      } // cfg.settings;
    };

    # Keycloak must wait for the mTLS proxy
    systemd.services.keycloak.after = [ "seed-pg-proxy.service" ];
    systemd.services.keycloak.requires = [ "seed-pg-proxy.service" ];

    # Kata VMs (boot.isContainer=true) don't support systemd LoadCredential.
    # The NixOS keycloak module uses LoadCredential for the password file.
    # Work around by creating a fake CREDENTIALS_DIRECTORY with the file.
    systemd.services.keycloak.serviceConfig.LoadCredential = lib.mkForce [];
    systemd.services.keycloak.environment.CREDENTIALS_DIRECTORY = "/run/keycloak/credentials";
    systemd.services.keycloak.preStart = lib.mkBefore ''
      mkdir -p /run/keycloak/credentials
      cp ${dbPasswordFile} /run/keycloak/credentials/${builtins.baseNameOf (toString dbPasswordFile)}
    '';
  };
}
