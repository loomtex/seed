# Seed instance module — tenant-facing options for Kata VM workloads
#
# This module lives in a separate NixOS evaluation from module.nix (the node module).
# Node-level: seed.enable, seed.hypervisor, seed.k3s.*
# Instance-level (this file): seed.size, seed.expose, seed.storage, seed.connect
{ config, lib, pkgs, ... }:

let
  cfg = config.seed;

  sizeTiers = {
    xs = { vcpus = 1; memory = 512; };
    s  = { vcpus = 1; memory = 1024; };
    m  = { vcpus = 2; memory = 2048; };
    l  = { vcpus = 4; memory = 4096; };
    xl = { vcpus = 8; memory = 8192; };
  };

  tier = sizeTiers.${cfg.size};

  # Well-known services: port and seed protocol defaults derived from
  # /etc/services conventions. Embedded as a literal table so flake
  # evaluation stays pure.
  knownServices = {
    http       = { port = 80;   protocol = "tcp"; };
    https      = { port = 443;  protocol = "http"; };  # ACME-enabled
    ssh        = { port = 22;   protocol = "tcp"; };
    dns        = { port = 53;   protocol = "dns"; };   # TCP+UDP
    domain     = { port = 53;   protocol = "dns"; };
    smtp       = { port = 25;   protocol = "tcp"; };
    smtps      = { port = 465;  protocol = "tcp"; };
    imaps      = { port = 993;  protocol = "tcp"; };
    postgresql = { port = 5432; protocol = "tcp"; };
    mysql      = { port = 3306; protocol = "tcp"; };
    redis      = { port = 6379; protocol = "tcp"; };
    grpc       = { port = 443;  protocol = "grpc"; };  # ACME-enabled
  };

  # Submodule for seed.expose entries — defaults from well-known service table
  exposeSubmodule = lib.types.submodule ({ name, ... }: let
    svc = knownServices.${name} or null;
  in {
    options = {
      enable = lib.mkEnableOption "Expose this port" // { default = true; };
      port = lib.mkOption {
        type = lib.types.port;
        default = if svc != null then svc.port
                  else throw "seed.expose.${name}: port required — '${name}' is not a well-known service. Set port explicitly.";
        description = "Port number. Defaults to well-known port for the entry name.";
      };
      protocol = lib.mkOption {
        type = lib.types.enum [ "tcp" "udp" "dns" "http" "grpc" ];
        default = if svc != null then svc.protocol else "tcp";
        description = ''
          Protocol hint for the controller. Defaults to well-known protocol.
          "dns" exposes on both TCP and UDP. "http"/"grpc" enable ACME.
        '';
      };
    };
  });

  # Submodule for seed.storage entries
  storageSubmodule = lib.types.submodule ({ name, ... }: {
    options = {
      size = lib.mkOption {
        type = lib.types.str;
        description = "Storage size (e.g. \"1Gi\", \"500Mi\").";
      };
      mountPoint = lib.mkOption {
        type = lib.types.str;
        default = "/seed/storage/${name}";
        description = "Mount point inside the instance.";
      };
      user = lib.mkOption {
        type = lib.types.str;
        default = "root";
        description = "Owner user for the mount point directory.";
      };
      group = lib.mkOption {
        type = lib.types.str;
        default = "root";
        description = "Owner group for the mount point directory.";
      };
      mode = lib.mkOption {
        type = lib.types.str;
        default = "0755";
        description = "Permissions for the mount point directory.";
      };
    };
  });

  # Submodule for seed.connect entries
  connectSubmodule = lib.types.submodule {
    options = {
      service = lib.mkOption {
        type = lib.types.str;
        description = "Service name to connect to.";
      };
      port = lib.mkOption {
        type = lib.types.nullOr lib.types.port;
        default = null;
        description = "Port override (defaults to service's default port).";
      };
    };
  };

in {
  options.seed = {
    namespace = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      internal = true;
      description = ''
        The k8s namespace this instance runs in. Platform-assigned, derived
        from the flake's .seed-identity (IPNS CID). Set by mkInstance only —
        instances cannot override this (prevents namespace spoofing).
      '';
    };

    size = lib.mkOption {
      type = lib.types.enum [ "xs" "s" "m" "l" "xl" ];
      default = "xs";
      description = ''
        Instance size tier. Maps to vCPU/memory:
        xs: 1 vCPU, 512MB — s: 1 vCPU, 1GB — m: 2 vCPU, 2GB — l: 4 vCPU, 4GB — xl: 8 vCPU, 8GB
      '';
    };

    expose = lib.mkOption {
      type = lib.types.attrsOf (lib.types.coercedTo
        lib.types.port
        (port: { inherit port; })
        exposeSubmodule
      );
      default = {};
      example = { http = 8080; grpc = { port = 9090; protocol = "grpc"; }; };
      description = "Ports to expose via ingress.";
    };

    storage = lib.mkOption {
      type = lib.types.attrsOf (lib.types.coercedTo
        lib.types.str
        (size: { inherit size; })
        storageSubmodule
      );
      default = {};
      example = { data = "1Gi"; cache = { size = "500Mi"; mountPoint = "/tmp/cache"; }; };
      description = "Persistent volumes for the instance.";
    };

    connect = lib.mkOption {
      type = lib.types.attrsOf (lib.types.coercedTo
        lib.types.str
        (service: { inherit service; })
        connectSubmodule
      );
      default = {};
      example = { redis = "my-redis"; db = { service = "postgres"; port = 5432; }; };
      description = "Service connections available inside the instance.";
    };

    rollout = lib.mkOption {
      type = lib.types.enum [ "recreate" "rolling" ];
      default = "recreate";
      description = ''
        Deployment rollout strategy.
        "recreate" stops the old pod before starting the new one (safe for stateful).
        "rolling" starts the new pod before stopping the old (zero-downtime for stateless).
      '';
    };

    acme = lib.mkOption {
      type = lib.types.bool;
      default = builtins.any (e: e.enable && (e.protocol == "http" || e.protocol == "grpc"))
        (builtins.attrValues cfg.expose);
      defaultText = lib.literalExpression "true when any expose entry has protocol \"http\" or \"grpc\"";
      description = ''
        Enable platform ACME for TLS certificates. When true, the controller
        injects SEED_ACME_URL pointing to its embedded ACME endpoint. Instances
        use their web server's built-in ACME client (e.g. Caddy's ca directive)
        to obtain Let's Encrypt-signed certificates automatically.

        Defaults to true when any expose entry uses "http" or "grpc" protocol.
        Set explicitly for services not on the whitelist, or false to opt out.
      '';
    };

    dns = {
      names = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        example = [ "id.loom.farm" "loom.farm" ];
        description = ''
          Custom DNS names for this instance. Each name gets an AAAA record
          pointing at the instance's ingress IPv6 address (from MetalLB).
          Zone apex names (e.g. "loom.farm") automatically generate a wildcard
          record (*.loom.farm) too.
        '';
      };
    };

    shoot = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = ''
          Enable fork-style ephemeral VM execution via the pool manager.
          When enabled, the instance gets a seed-shoot command and SEED_SHOOT_URL
          env var pointing to the node-local pool manager.
        '';
      };
    };

    meta = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      description = "Controller-consumable metadata computed from seed options.";
    };
  };

  config = let
    enabledExpose = lib.filterAttrs (_: e: e.enable) cfg.expose;
  in {
    # Denormalized metadata for the controller
    seed.meta = {
      size = cfg.size;
      resources = tier;
      expose = lib.mapAttrs (_: e: {
        inherit (e) port protocol;
      }) enabledExpose;
      storage = lib.mapAttrs (name: s: {
        inherit (s) size mountPoint;
      }) cfg.storage;
      connect = lib.mapAttrs (_: c: {
        inherit (c) service;
        port = c.port;
      }) cfg.connect;
      rollout = cfg.rollout;
      acme = cfg.acme;
      shoot = lib.optionalAttrs cfg.shoot.enable { enable = true; };
      dns = lib.optionalAttrs (cfg.dns.names != []) { names = cfg.dns.names; };
    };

    # seed-shoot wrapper script
    environment.systemPackages = lib.optionals cfg.shoot.enable [
      (pkgs.writeShellScriptBin "seed-shoot" ''
        # seed-shoot — fork an ephemeral VM via the pool manager
        # Usage: seed-shoot [--timeout MS] command [args...]

        # Source SEED_* env vars (systemd strips them in Kata VMs)
        [ -f /run/seed/env ] && . /run/seed/env

        timeout=""
        while [ $# -gt 0 ]; do
          case "$1" in
            --timeout) timeout="$2"; shift 2 ;;
            *) break ;;
          esac
        done

        if [ $# -eq 0 ]; then
          echo "Usage: seed-shoot [--timeout MS] command [args...]" >&2
          exit 1
        fi

        url="''${SEED_SHOOT_URL:-}"
        if [ -z "$url" ]; then
          echo "error: SEED_SHOOT_URL not set" >&2
          exit 1
        fi

        # Build JSON command array
        cmd_json=$(printf '%s\n' "$@" | ${pkgs.jq}/bin/jq -R . | ${pkgs.jq}/bin/jq -s .)

        # Build request
        request=$(${pkgs.jq}/bin/jq -nc \
          --argjson command "$cmd_json" \
          --argjson timeout "''${timeout:-120000}" \
          '{command: $command, timeout: $timeout}')

        # POST to pool manager
        response=$(${pkgs.curl}/bin/curl -s -X POST \
          -H "Content-Type: application/json" \
          -d "$request" \
          "$url/shoot" 2>/dev/null)

        # Parse response
        exit_code=$(echo "$response" | ${pkgs.jq}/bin/jq -r '.exitCode // 1')
        stdout=$(echo "$response" | ${pkgs.jq}/bin/jq -r '.stdout // ""')
        stderr=$(echo "$response" | ${pkgs.jq}/bin/jq -r '.stderr // ""')
        error=$(echo "$response" | ${pkgs.jq}/bin/jq -r '.error // ""')

        if [ -n "$error" ]; then
          echo "shoot error: $error" >&2
          exit 1
        fi

        [ -n "$stdout" ] && printf '%s\n' "$stdout"
        [ -n "$stderr" ] && printf '%s\n' "$stderr" >&2
        exit "$exit_code"
      '')
    ];

    # Create mount point directories for storage volumes
    systemd.tmpfiles.rules = lib.mapAttrsToList
      (name: s: "d ${s.mountPoint} ${s.mode} ${s.user} ${s.group} -")
      cfg.storage;

    # Open firewall for exposed ports
    networking.firewall.allowedTCPPorts =
      lib.pipe enabledExpose [
        (lib.filterAttrs (_: e: e.protocol != "udp"))
        (lib.mapAttrsToList (_: e: e.port))
      ];

    networking.firewall.allowedUDPPorts =
      lib.pipe enabledExpose [
        (lib.filterAttrs (_: e: e.protocol == "udp" || e.protocol == "dns"))
        (lib.mapAttrsToList (_: e: e.port))
      ];

    # When ACME is enabled, configure security.acme to use the platform's
    # embedded ACME endpoint. NixOS requires acceptTerms + email even though
    # our internal server doesn't use them (it proxies to LE server-side).
    security.acme = lib.mkIf cfg.acme {
      acceptTerms = true;
      defaults.server = "https://seed-controller.seed-system.svc.cluster.local:9876/acme/directory";
      defaults.email = lib.mkDefault "acme@seed.loom.farm";
    };

    # Service discovery: environment variables
    environment.sessionVariables = lib.mapAttrs'
      (name: c: lib.nameValuePair
        "SEED_${lib.toUpper (builtins.replaceStrings ["-"] ["_"] name)}_HOST"
        c.service
      )
      cfg.connect;

    # Service discovery: files at /seed/connect/<name>
    environment.etc = lib.mapAttrs'
      (name: c: lib.nameValuePair
        "seed/connect/${name}"
        { text = c.service + (lib.optionalString (c.port != null) ":${toString c.port}") + "\n"; }
      )
      cfg.connect;
  };
}
