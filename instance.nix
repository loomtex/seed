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

  # Submodule for seed.expose entries
  exposeSubmodule = lib.types.submodule {
    options = {
      port = lib.mkOption {
        type = lib.types.port;
        description = "Port number to expose.";
      };
      protocol = lib.mkOption {
        type = lib.types.enum [ "tcp" "udp" "dns" "http" "grpc" ];
        default = "http";
        description = ''
          Protocol hint for the ingress controller.
          "dns" exposes on both TCP and UDP (standard for DNS).
        '';
      };
    };
  };

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
    size = lib.mkOption {
      type = lib.types.enum [ "xs" "s" "m" "l" "xl" ];
      default = "s";
      description = ''
        Instance size tier. Maps to vCPU/memory:
        xs: 1 vCPU, 512MB — s: 1 vCPU, 1GB — m: 2 vCPU, 2GB — l: 4 vCPU, 4GB — xl: 8 vCPU, 8GB
      '';
    };

    expose = lib.mkOption {
      type = lib.types.attrsOf (lib.types.coercedTo
        lib.types.port
        (port: { inherit port; protocol = "http"; })
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

    meta = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      internal = true;
      description = "Controller-consumable metadata computed from seed options.";
    };
  };

  config = {
    # Denormalized metadata for the controller
    seed.meta = {
      size = cfg.size;
      resources = tier;
      expose = lib.mapAttrs (_: e: {
        inherit (e) port protocol;
      }) cfg.expose;
      storage = lib.mapAttrs (name: s: {
        inherit (s) size mountPoint;
      }) cfg.storage;
      connect = lib.mapAttrs (_: c: {
        inherit (c) service;
        port = c.port;
      }) cfg.connect;
      rollout = cfg.rollout;
    };

    # Create mount point directories for storage volumes
    systemd.tmpfiles.rules = lib.mapAttrsToList
      (name: s: "d ${s.mountPoint} 0755 root root -")
      cfg.storage;

    # Open firewall for exposed ports
    networking.firewall.allowedTCPPorts =
      lib.pipe cfg.expose [
        (lib.filterAttrs (_: e: e.protocol != "udp"))
        (lib.mapAttrsToList (_: e: e.port))
      ];

    networking.firewall.allowedUDPPorts =
      lib.pipe cfg.expose [
        (lib.filterAttrs (_: e: e.protocol == "udp" || e.protocol == "dns"))
        (lib.mapAttrsToList (_: e: e.port))
      ];

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
