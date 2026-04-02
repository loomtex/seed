# seed.services.zitadel — Zitadel OIDC IdP with SPIFFE mTLS database proxy
#
# Wraps the NixOS zitadel module with the mTLS proxy pattern for connecting
# to a shared seed PostgreSQL instance. Go's crypto/tls can't use TPM-bound
# keys (TSS2 PRIVATE KEY format) without patching Zitadel's vendor deps,
# so a local socat + openssl s_client proxy handles SPIFFE cert auth.
# Zitadel connects plaintext to localhost.
#
# PostgreSQL uses STARTTLS (SSLRequest then TLS handshake), so the proxy
# uses `openssl s_client -starttls postgres` which handles the negotiation.
#
# The master encryption key is generated on first boot and persisted on a
# PVC at /seed/storage/zitadel/masterkey. This key encrypts sensitive data
# in the database (OIDC secrets, SMTP credentials, etc).
#
# Usage:
#   seed.services.zitadel = {
#     enable = true;
#     hostname = "id.example.com";
#     database.host = "postgres.s-abc123.svc.cluster.local";
#   };
#
# The instance author is responsible for ingress (Caddy/nginx + ACME)
# and seed.expose/seed.dns/seed.size configuration.
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.services.zitadel;

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

  masterkeyPath = "/seed/storage/zitadel/masterkey";

in {
  options.seed.services.zitadel = {
    enable = lib.mkEnableOption "Zitadel OIDC IdP with SPIFFE mTLS database proxy";

    hostname = lib.mkOption {
      type = lib.types.str;
      description = "Public hostname for Zitadel (used in OIDC issuer URLs).";
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
        default = "zitadel";
        description = "PostgreSQL database name.";
      };

      username = lib.mkOption {
        type = lib.types.str;
        default = "zitadel";
        description = "PostgreSQL role (mapped from SPIFFE cert DN by pg_ident).";
      };
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = "HTTP port Zitadel listens on (for reverse proxy).";
    };

    settings = lib.mkOption {
      type = lib.types.attrs;
      default = {};
      description = "Additional Zitadel settings (merged into Database section is handled automatically).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Persistent storage for master key
    seed.storage.zitadel = { size = "10Mi"; mountPoint = "/seed/storage/zitadel"; };

    # Ensure zitadel user owns its storage directory (PVCs are root-owned by default)
    systemd.tmpfiles.rules = [ "d /seed/storage/zitadel 0750 zitadel zitadel -" ];

    # Generate master encryption key on first boot. Persisted on PVC so it
    # survives pod restarts. Zitadel uses this to encrypt OIDC secrets,
    # SMTP credentials, and other sensitive data in the database.
    systemd.services.seed-zitadel-masterkey = {
      description = "Generate Zitadel master encryption key";
      wantedBy = [ "multi-user.target" ];
      before = [ "zitadel.service" ];
      requiredBy = [ "zitadel.service" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      script = ''
        if [ ! -f ${masterkeyPath} ]; then
          ${pkgs.openssl}/bin/openssl rand -hex 16 > ${masterkeyPath}
        fi
        chown zitadel:zitadel ${masterkeyPath}
        chmod 400 ${masterkeyPath}
      '';
    };

    # mTLS proxy: socat + openssl s_client with -starttls postgres.
    # Handles PostgreSQL's STARTTLS negotiation and uses TPM-bound SPIFFE
    # cert for client auth. Zitadel connects plaintext to localhost.
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

    services.zitadel = {
      enable = true;
      masterKeyFile = masterkeyPath;
      tlsMode = "external";

      settings = {
        Port = cfg.port;
        ExternalDomain = cfg.hostname;
        ExternalPort = 443;
        ExternalSecure = true;

        Database.postgres = {
          Host = "localhost";
          Port = cfg.database.proxyPort;
          Database = cfg.database.name;
          MaxOpenConns = 20;
          MaxIdleConns = 10;
          User = {
            Username = cfg.database.username;
            SSL.Mode = "disable";
          };
          Admin = {
            Username = cfg.database.username;
            SSL.Mode = "disable";
          };
        };
      } // cfg.settings;

      steps = {
        FirstInstance = {
          InstanceName = "Loom";
          Org.Name = "Loom";
        };
      };
    };

    # Zitadel must wait for the mTLS proxy
    systemd.services.zitadel.after = [ "seed-pg-proxy.service" "seed-zitadel-masterkey.service" ];
    systemd.services.zitadel.requires = [ "seed-pg-proxy.service" ];
  };
}
