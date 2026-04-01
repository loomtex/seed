# seed.services.postgresql — wrapped PostgreSQL with SPIFFE mTLS
#
# Configures PostgreSQL to use the instance's SPIFFE identity certificate
# for server TLS and client certificate authentication. Clients present
# their own SPIFFE certs; pg_ident.conf maps certificate DNs to DB roles.
#
# Certificate subject DN format: /O=seeds.loom.farm/OU=<namespace>/CN=<instance>
# PostgreSQL sees (via clientname=DN): CN=<instance>,OU=<namespace>,O=seeds.loom.farm
#
# Usage:
#   seed.services.postgresql = {
#     enable = true;
#     databases.myapp = {
#       # Intra-namespace: namespace derived from seed.namespace
#       clients.api = { role = "myapp_rw"; };
#       # Cross-namespace: explicit namespace
#       clients.worker = { role = "myapp_ro"; namespace = "s-xyz123"; };
#     };
#   };
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.services.postgresql;
  ns = config.seed.namespace;

  # Build pg_ident.conf lines from database/client declarations.
  # Uses regex to match the full DN from clientname=DN.
  # Format: map_name  /regex/  pg_username
  identLines = lib.concatLists (lib.mapAttrsToList (_: dbCfg:
    lib.mapAttrsToList (clientName: clientCfg: let
      clientNs = if clientCfg.namespace != null then clientCfg.namespace else ns;
    in
      # pg_ident regex matches the Distinguished Name from the client cert.
      # DN format from PostgreSQL: CN=<instance>,OU=<namespace>,O=seeds.loom.farm
      ''seed  "/^CN=${clientName},OU=${clientNs},O=seeds\\.loom\\.farm$/"  ${clientCfg.role}''
    ) dbCfg.clients
  ) cfg.databases);

  identConf = lib.concatStringsSep "\n" identLines;

  # Build pg_hba.conf lines — one per database requiring cert auth.
  # clientname=DN makes PostgreSQL pass the full DN to pg_ident (not just CN).
  hbaLines = lib.concatLists (lib.mapAttrsToList (dbName: dbCfg:
    lib.optionals (dbCfg.clients != {}) [
      "hostssl ${dbName} all ::/0 cert clientname=DN map=seed"
      "hostssl ${dbName} all 0.0.0.0/0 cert clientname=DN map=seed"
    ]
  ) cfg.databases);

  # Client submodule
  clientSubmodule = lib.types.submodule {
    options = {
      role = lib.mkOption {
        type = lib.types.str;
        description = "PostgreSQL role to map this client's certificate to.";
      };
      namespace = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          Namespace of the client instance. Defaults to the same namespace
          (intra-namespace). Set explicitly for cross-namespace clients.
        '';
      };
    };
  };

  # Database submodule
  databaseSubmodule = lib.types.submodule {
    options.clients = lib.mkOption {
      type = lib.types.attrsOf clientSubmodule;
      default = {};
      description = ''
        Client instances allowed to connect. Keys are instance names
        (matching the CN in the client's SPIFFE certificate). Values
        specify the PostgreSQL role and optionally the client's namespace.
      '';
    };
  };

in {
  options.seed.services.postgresql = {
    enable = lib.mkEnableOption "SPIFFE-authenticated PostgreSQL";

    databases = lib.mkOption {
      type = lib.types.attrsOf databaseSubmodule;
      default = {};
      description = "Databases with client certificate authentication.";
    };

    listenAddresses = lib.mkOption {
      type = lib.types.str;
      default = "*";
      description = "PostgreSQL listen addresses.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 5432;
      description = "PostgreSQL listen port.";
    };
  };

  config = lib.mkIf cfg.enable {
      # Expose postgresql port
      seed.expose.postgresql = {
        port = cfg.port;
        protocol = "tcp";
      };

      # Storage for data directory
      seed.storage.pgdata = {
        size = lib.mkDefault "10Gi";
        mountPoint = "/var/lib/postgresql";
        user = "postgres";
        group = "postgres";
        mode = "0750";
      };

      # postgres user needs TPM access for TLS operations (key is TPM-bound)
      users.users.postgres.extraGroups = [ "tpm" ];

      services.postgresql = {
        enable = true;
        enableTCPIP = true;
        settings = {
          listen_addresses = cfg.listenAddresses;
          port = cfg.port;

          # TLS — TPM-bound key via tpm2-openssl provider.
          # key.pem is a TSS2 PRIVATE KEY (TPM handle, not raw material).
          # PostgreSQL uses the tpm2 provider for all private key ops.
          ssl = true;
          ssl_cert_file = "/seed/tls/cert.pem";
          ssl_key_file = "/seed/tls/key.pem";
          ssl_ca_file = "/seed/tls/ca.pem";
        };

        # pg_ident.conf — map client cert DN → database role
        identMap = identConf;

        # pg_hba.conf — require client certs for declared databases
        authentication = lib.mkAfter (lib.concatStringsSep "\n" hbaLines);
      };

      # Load tpm2-openssl provider so PostgreSQL can use the TPM-bound key.
      # OpenSSL needs both OPENSSL_MODULES (where to find tpm2.so) and
      # OPENSSL_CONF (config that activates the provider on key load).
      systemd.services.postgresql.environment = {
        OPENSSL_MODULES = "${pkgs.tpm2-openssl}/lib/ossl-modules";
        OPENSSL_CONF = pkgs.writeText "openssl-tpm2.cnf" ''
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
      };
      systemd.services.postgresql.after = [ "seed-cert-enroll.service" ];
      systemd.services.postgresql.requires = [ "seed-cert-enroll.service" ];
      systemd.services.postgresql.serviceConfig = {
        ReadOnlyPaths = [ "/seed/tls" ];
        DeviceAllow = [ "/dev/tpmrm0 rw" ];
      };

      # Create databases and roles declared in the config
      systemd.services.seed-pg-init = {
        description = "Initialize seed.services.postgresql databases and roles";
        after = [ "postgresql.service" ];
        requires = [ "postgresql.service" ];
        wantedBy = [ "multi-user.target" ];
        path = [ config.services.postgresql.package ];
        serviceConfig = {
          Type = "oneshot";
          User = "postgres";
          RemainAfterExit = true;
        };
        script = let
          initLines = lib.concatLists (lib.mapAttrsToList (dbName: dbCfg:
            let
              roles = lib.unique (lib.mapAttrsToList (_: c: c.role) dbCfg.clients);
            in
              (map (role: ''
                psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='${role}'" | grep -q 1 || \
                  psql -tAc "CREATE ROLE \"${role}\" WITH LOGIN"
              '') roles)
              ++ [''
                psql -tAc "SELECT 1 FROM pg_database WHERE datname='${dbName}'" | grep -q 1 || \
                  psql -tAc 'CREATE DATABASE "${dbName}"'
              '']
              ++ (map (role: ''
                psql -tAc 'GRANT ALL PRIVILEGES ON DATABASE "${dbName}" TO "${role}"'
              '') roles)
          ) cfg.databases);
        in ''
          set -euo pipefail
          ${lib.concatStringsSep "\n" initLines}
        '';
      };
  };
}
