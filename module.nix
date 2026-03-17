{ config, lib, pkgs, ... }:

let
  cfg = config.seed;

  hypervisorRuntime = {
    clh = "io.containerd.kata-clh.v2";
    qemu = "io.containerd.kata-qemu.v2";
  }.${cfg.hypervisor};

  hypervisorPackage = {
    clh = pkgs.cloud-hypervisor;
    qemu = pkgs.qemu_kvm;
  }.${cfg.hypervisor};

  hypervisorConfigFile = {
    clh = "configuration-clh.toml";
    qemu = "configuration-qemu.toml";
  }.${cfg.hypervisor};

  # Upstream kata config with enable_annotations expanded to allow
  # per-pod VM sizing via annotations (vCPUs, memory)
  kataConfig = builtins.replaceStrings
    [ ''enable_annotations = ["enable_iommu", "virtio_fs_extra_args", "kernel_params"]'' ]
    [ ''enable_annotations = ["enable_iommu", "virtio_fs_extra_args", "kernel_params", "default_vcpus", "default_memory", "default_maxvcpus", "default_maxmemory", "tpm_socket"]'' ]
    (builtins.readFile "${pkgs.kata-runtime}/share/defaults/kata-containers/${hypervisorConfigFile}");

  # MetalLB: bare-metal LoadBalancer implementation (L2/BGP)
  # Using FRR mode for IPv6 BGP support (native mode only supports IPv4 BGP)
  metallbManifests = pkgs.runCommand "seed-metallb-manifests" {} ''
    mkdir -p $out
    cp ${pkgs.fetchurl {
      url = "https://raw.githubusercontent.com/metallb/metallb/v0.15.3/config/manifests/metallb-frr.yaml";
      hash = "sha256-WgxErUBZ6ZEtivCxL7A11Hp1YZ6RNzf1onWWIOerV2k=";
    }} $out/metallb-frr.yaml
  '';

  seedBaseManifests = pkgs.linkFarm "seed-base-manifests" [{
    name = "kata-runtime-class.json";
    path = pkgs.writeText "kata-runtime-class.json" (builtins.toJSON {
      apiVersion = "node.k8s.io/v1";
      kind = "RuntimeClass";
      metadata.name = "kata";
      handler = "kata";
    });
  }];

  disableFlags = map (c: "--disable ${c}") cfg.k3s.disableDefaults;
in {
  options.seed = {
    enable = lib.mkEnableOption "Seed compute node (k3s + Kata VM isolation)";

    hypervisor = lib.mkOption {
      type = lib.types.enum [ "clh" "qemu" ];
      default = "clh";
      description = "Kata Containers hypervisor backend. CLH (Cloud Hypervisor) is lightweight and fast; QEMU supports more device types.";
    };

    role = lib.mkOption {
      type = lib.types.enum [ "server" "agent" ];
      default = "server";
      description = "k3s role. Server runs the control plane + workloads. Agent joins an existing cluster and runs workloads only.";
    };

    serverAddr = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "k3s server URL to join (e.g. https://server:6443). Required when role = agent, or when a server joins an existing HA cluster.";
    };

    token = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "k3s cluster join token. Required for agents and servers joining an existing HA cluster.";
    };

    tokenFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = "File containing k3s cluster join token. Alternative to inline token.";
    };

    k3s = {
      port = lib.mkOption {
        type = lib.types.port;
        default = 6443;
        description = "k3s API server HTTPS port.";
      };

      extraFlags = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "Additional flags passed to k3s.";
      };

      disableDefaults = lib.mkOption {
        type = lib.types.listOf (lib.types.enum [
          "traefik" "servicelb" "metrics-server" "coredns" "local-storage"
        ]);
        default = [ "traefik" "servicelb" "metrics-server" ];
        description = "k3s components to disable (server role only). Keeps the cluster minimal — add back what you need.";
      };

      kubeconfigMode = lib.mkOption {
        type = lib.types.str;
        default = "644";
        description = "File permissions for /etc/rancher/k3s/k3s.yaml.";
      };

      clusterInit = lib.mkOption {
        type = lib.types.bool;
        default = false;
        description = "Bootstrap embedded etcd on first server. Only enable on one node for initial cluster creation, then disable.";
      };

      dualStack = lib.mkEnableOption "IPv4/IPv6 dual-stack networking for pods and services";

      nodeIp = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          k3s --node-ip value. For dual-stack, comma-separate IPv4 and IPv6
          (e.g. "10.0.0.10,2001:db8::1"). When set, also writes
          /run/k3s/node-config.yaml and reads /persist/seed/server-addr
          for cluster join.
        '';
      };

      nodeExternalIp = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          k3s --node-external-ip value. For dual-stack, comma-separate
          IPv4 and IPv6 (e.g. "96.30.205.16,2001:db8::1").
        '';
      };
    };

    nixSnapshotter = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Enable nix-snapshotter for native nix store path resolution in container images.";
      };
    };

    persistence = {
      enable = lib.mkEnableOption "Persist /var/lib/rancher across reboots (for impermanence systems)";

      path = lib.mkOption {
        type = lib.types.str;
        default = "/persist";
        description = "Impermanence mount point where /var/lib/rancher will be persisted.";
      };
    };

    k8s.services = lib.mkOption {
      type = lib.types.attrsOf (lib.types.submodule {
        options = {
          manifests = lib.mkOption {
            type = lib.types.path;
            description = "Directory of JSON/YAML manifests to apply via kubectl.";
          };
          extraManifestPaths = lib.mkOption {
            type = lib.types.listOf lib.types.str;
            default = [];
            description = "Additional file paths (e.g. sops templates) to apply alongside the manifests directory.";
          };
        };
      });
      default = {};
      description = "k8s services to apply on activation. Each entry is a directory of manifests applied via kubectl apply --server-side.";
    };
  };

  config = lib.mkIf cfg.enable {
    # k3s cluster communication ports
    networking.firewall.allowedTCPPorts = lib.mkIf (cfg.role == "server") [
      179   # BGP (MetalLB speaker ↔ upstream router)
      2379  # etcd client
      2380  # etcd peer
      7946  # MetalLB memberlist (speaker gossip)
    ];
    networking.firewall.allowedUDPPorts = [
      7946  # MetalLB memberlist (speaker gossip)
      8472  # flannel VXLAN (cross-node pod traffic)
    ];

    # Deploy MetalLB + RuntimeClass via kubectl apply (server only)
    seed.k8s.services.metallb = lib.mkIf (cfg.role == "server") {
      manifests = metallbManifests;
    };
    seed.k8s.services.seed-base = lib.mkIf (cfg.role == "server") {
      manifests = seedBaseManifests;
    };

    # Kata config with VM sizing annotations enabled
    environment.etc."kata-containers/configuration.toml".text = kataConfig;

    # ip forwarding for pod networking
    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;
    boot.kernel.sysctl."net.ipv6.conf.all.forwarding" = 1;

    # Accept IPv6 router advertisements even with forwarding enabled.
    # forwarding=1 disables RA acceptance by default (accept_ra=1 means
    # "accept unless forwarding"). accept_ra=2 overrides this so nodes
    # get their IPv6 address + gateway via SLAAC while still forwarding
    # pod traffic.
    boot.kernel.sysctl."net.ipv6.conf.all.accept_ra" = lib.mkIf cfg.k3s.dualStack (lib.mkDefault 2);
    boot.kernel.sysctl."net.ipv6.conf.default.accept_ra" = lib.mkIf cfg.k3s.dualStack (lib.mkDefault 2);

    # Disable IPv6 privacy/temporary addresses — infrastructure servers need
    # stable SLAAC addresses for BGP source binding (MD5 auth is keyed to
    # the EUI-64 address, not ephemeral privacy addresses).
    boot.kernel.sysctl."net.ipv6.conf.all.use_tempaddr" = lib.mkIf cfg.k3s.dualStack (lib.mkDefault 0);
    boot.kernel.sysctl."net.ipv6.conf.default.use_tempaddr" = lib.mkIf cfg.k3s.dualStack (lib.mkDefault 0);

    # Kernel modules for Kata VM isolation
    boot.kernelModules = [ "vhost_net" "vhost_vsock" ];

    # nix-snapshotter: resolve nix store paths in container images
    services.nix-snapshotter.enable = lib.mkIf cfg.nixSnapshotter.enable true;

    services.k3s = {
      enable = true;
      role = cfg.role;
      snapshotter = lib.mkIf cfg.nixSnapshotter.enable "nix";

      extraFlags = lib.concatLists [
        (lib.optionals (cfg.k3s.nodeIp != "") [
          "--config" "/run/k3s/node-config.yaml"
        ])
        (lib.optionals (cfg.role == "server") (disableFlags ++ [
          "--https-listen-port ${toString cfg.k3s.port}"
          "--write-kubeconfig-mode ${cfg.k3s.kubeconfigMode}"
        ]))
        (lib.optionals (cfg.role == "server" && cfg.k3s.clusterInit) [
          "--cluster-init"
        ])
        (lib.optionals (cfg.role == "server" && cfg.k3s.dualStack) [
          "--cluster-cidr=10.42.0.0/16,fd00::/56"
          "--service-cidr=10.43.0.0/16,fd01::/108"
        ])
        cfg.k3s.extraFlags
      ];

      serverAddr = lib.mkIf (cfg.serverAddr != "" && cfg.k3s.nodeIp == "") cfg.serverAddr;
      token = lib.mkIf (cfg.token != "") cfg.token;
      tokenFile = lib.mkIf (cfg.tokenFile != null) (toString cfg.tokenFile);

      # Kata runtime registration in containerd
      containerdConfigTemplate = ''
        {{ template "base" . }}

        [plugins."io.containerd.grpc.v1.cri".containerd.runtimes."kata"]
          runtime_type = "${hypervisorRuntime}"
          privileged_without_host_devices = true
          pod_annotations = ["io.katacontainers.*"]
          container_annotations = ["io.katacontainers.*"]
      '';
    };

    # --- seed.k8s.services: hot-apply k8s manifests on NixOS activation ---
    systemd.services.seed-k8s-apply = lib.mkIf (cfg.k8s.services != {}) {
      description = "Apply seed k8s service manifests";
      wantedBy = [ "multi-user.target" ];
      after = [ "k3s.service" ];
      wants = [ "k3s.service" ];

      # Re-run on NixOS switch when any manifest derivation changes
      restartTriggers = lib.mapAttrsToList (_: svc: svc.manifests) cfg.k8s.services;

      path = [ pkgs.kubectl pkgs.coreutils ];

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        Environment = "KUBECONFIG=/etc/rancher/k3s/k3s.yaml";
      };

      script = let
        applyCommands = lib.concatStringsSep "\n" (lib.mapAttrsToList (name: svc: ''
          echo "Applying k8s service: ${name}"
          kubectl apply --server-side -f ${svc.manifests}/
          ${lib.concatMapStringsSep "\n" (p: ''
            if [ -f "${p}" ]; then
              echo "Applying extra manifest: ${p}"
              kubectl apply --server-side -f "${p}"
            fi
          '') svc.extraManifestPaths}
        '') cfg.k8s.services);
      in ''
        set -euo pipefail

        # Wait for k8s API
        echo "Waiting for k8s API..."
        for i in $(seq 1 120); do
          if kubectl get --raw /readyz &>/dev/null; then
            break
          fi
          if [ "$i" -eq 120 ]; then
            echo "Timed out waiting for k8s API" >&2
            exit 1
          fi
          sleep 1
        done

        ${applyCommands}

        echo "All k8s services applied successfully"
      '';
    };

    # k3s service: kata + hypervisor in PATH, device access, service ordering
    systemd.services.k3s = {
      path = [ pkgs.kata-runtime hypervisorPackage ];
      after = lib.mkIf cfg.nixSnapshotter.enable [ "nix-snapshotter.service" ];
      wants = lib.mkIf cfg.nixSnapshotter.enable [ "nix-snapshotter.service" ];

      serviceConfig = {
        # Device access for KVM and vhost (Kata VM isolation)
        DeviceAllow = [
          "/dev/kvm rwm"
          "/dev/vhost-vsock rwm"
          "/dev/vhost-net rwm"
          "/dev/net/tun rwm"
          "/dev/kmsg r"
        ];

        ExecStartPre =
          # Write node-config.yaml from static nix values
          (lib.optionals (cfg.k3s.nodeIp != "") [
            "+${pkgs.writeShellScript "seed-node-config" ''
              set -euo pipefail
              mkdir -p /run/k3s
              echo "node-ip: \"${cfg.k3s.nodeIp}\"" > /run/k3s/node-config.yaml
              ${lib.optionalString (cfg.k3s.nodeExternalIp != "") ''
                echo "node-external-ip: \"${cfg.k3s.nodeExternalIp}\"" >> /run/k3s/node-config.yaml
              ''}

              # If a server-addr file exists (written by provisioner for joining nodes),
              # add it to the k3s config so we don't hardcode the init node's IP.
              if [ -f /persist/seed/server-addr ]; then
                echo "server: \"$(cat /persist/seed/server-addr)\"" >> /run/k3s/node-config.yaml
              fi
            ''}"
          ]);
      };
    };
  };
}
