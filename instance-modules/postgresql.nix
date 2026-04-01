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

      services.postgresql = {
        enable = true;
        enableTCPIP = true;
        settings = {
          listen_addresses = cfg.listenAddresses;
          port = cfg.port;

          # TLS — use SPIFFE identity cert (copied to postgres-readable path)
          ssl = true;
          ssl_cert_file = "/run/postgresql/tls/cert.pem";
          ssl_key_file = "/run/postgresql/tls/key.pem";
          ssl_ca_file = "/run/postgresql/tls/ca.pem";
        };

        # pg_ident.conf — map client cert DN → database role
        identMap = identConf;

        # pg_hba.conf — require client certs for declared databases
        authentication = lib.mkAfter (lib.concatStringsSep "\n" hbaLines);
      };

      # PostgreSQL needs to read the TLS key. The key is 0600 root-owned
      # from the enrollment script. Copy to a postgres-readable location
      # before postgresql starts.
      systemd.services.postgresql.preStart = lib.mkBefore ''
        mkdir -p /run/postgresql/tls
        cp /seed/tls/cert.pem /run/postgresql/tls/cert.pem
        cp /seed/tls/key.pem /run/postgresql/tls/key.pem
        cp /seed/tls/ca.pem /run/postgresql/tls/ca.pem
        chown postgres:postgres /run/postgresql/tls/*
        chmod 600 /run/postgresql/tls/key.pem
        chmod 644 /run/postgresql/tls/cert.pem /run/postgresql/tls/ca.pem
      '';

      # Ensure postgresql starts after cert enrollment
      systemd.services.postgresql.after = [ "seed-cert-enroll.service" ];
      systemd.services.postgresql.requires = [ "seed-cert-enroll.service" ];

      # Create databases and roles declared in the config
      systemd.services.seed-pg-init = {
        description = "Initialize seed.services.postgresql databases and roles";
        after = [ "postgresql.service" ];
        requires = [ "postgresql.service" ];
        wantedBy = [ "multi-user.target" ];
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
