# seed.services.zitadel — Zitadel OIDC IdP with SPIFFE mTLS database proxy
#
# Runs Zitadel directly (not via the NixOS module) to control the startup
# sequence for managed PostgreSQL: init schema → start-from-setup. The NixOS
# module hardcodes start-from-init which tries to connect to the 'postgres'
# admin database — our shared postgres only allows cert auth on declared DBs.
#
# Database and role are pre-created by seed.services.postgresql's init script.
# Zitadel just needs to bootstrap its schema and start.
#
# Uses socat + openssl s_client mTLS proxy for the SPIFFE cert (TPM-bound).
#
# Usage:
#   seed.services.zitadel = {
#     enable = true;
#     hostname = "id.example.com";
#     database.host = "postgres.s-abc123.svc.cluster.local";
#   };
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

  # Zitadel configuration YAML
  settingsFile = pkgs.writeText "zitadel-config.yaml" (builtins.toJSON ({
    Port = cfg.port;
    ExternalDomain = cfg.hostname;
    ExternalPort = 443;
    ExternalSecure = true;

    Database.postgres = {
      # Use 127.0.0.1 not localhost — proxy listens IPv4 only,
      # pgx resolves localhost to [::1] first which fails.
      Host = "127.0.0.1";
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
  } // cfg.settings));

  # First instance setup (org name, etc)
  stepsFile = pkgs.writeText "zitadel-steps.yaml" (builtins.toJSON {
    FirstInstance = {
      InstanceName = "Loom";
      Org.Name = "Loom";
    };
  });

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
      description = "Additional Zitadel settings (merged with defaults).";
    };
  };

  config = lib.mkIf cfg.enable {
    # Persistent storage for master key
    seed.storage.zitadel = { size = "10Mi"; mountPoint = "/seed/storage/zitadel"; };

    # Ensure zitadel user owns its storage directory (PVCs are root-owned by default)
    systemd.tmpfiles.rules = [ "d /seed/storage/zitadel 0750 zitadel zitadel -" ];

    # Create the zitadel system user
    users.users.zitadel = {
      isSystemUser = true;
      group = "zitadel";
    };
    users.groups.zitadel = {};

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

    # Zitadel service — init schema then start-from-setup.
    # We don't use the NixOS module because it hardcodes start-from-init
    # which connects to the 'postgres' admin database. Our shared postgres
    # only allows cert auth on declared databases, so we use the managed
    # PostgreSQL workflow: pre-create DB, init schema, start-from-setup.
    systemd.services.zitadel = {
      description = "Zitadel OIDC identity provider";
      after = [ "seed-pg-proxy.service" "seed-zitadel-masterkey.service" "network-online.target" ];
      requires = [ "seed-pg-proxy.service" ];
      wants = [ "network-online.target" ];
      wantedBy = [ "multi-user.target" ];

      path = [ pkgs.zitadel ];

      serviceConfig = {
        User = "zitadel";
        Group = "zitadel";
        Type = "simple";
        Restart = "on-failure";
        RestartSec = "5s";
      };

      # Bootstrap schema on first start (idempotent — skips if already done).
      # This replaces the provisioning step that start-from-init does via
      # the 'postgres' admin database.
      preStart = ''
        zitadel init schema \
          --config ${settingsFile} \
          --masterkey "$(head -1 ${masterkeyPath})" \
          --tlsMode external
      '';

      # start-from-setup runs migrations + first instance setup + server.
      # Unlike start-from-init, it doesn't try to connect to the 'postgres'
      # database — it works directly with the target database.
      script = ''
        exec zitadel start-from-setup \
          --config ${settingsFile} \
          --steps ${stepsFile} \
          --masterkey "$(head -1 ${masterkeyPath})" \
          --tlsMode external
      '';
    };
  };
}
