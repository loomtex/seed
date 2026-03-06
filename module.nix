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
  metallbManifest = pkgs.fetchurl {
    url = "https://raw.githubusercontent.com/metallb/metallb/v0.15.3/config/manifests/metallb-native.yaml";
    hash = "sha256-hLThAvK2X11pCF9YFsKTYrdGQYc9isPemW5fhqghkXY=";
  };

  runtimeClassManifest = pkgs.writeText "seed-kata-runtime-class.yaml" ''
    apiVersion: node.k8s.io/v1
    kind: RuntimeClass
    metadata:
      name: kata
    handler: kata
  '';

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
      description = "k3s server URL to join (e.g. https://server:6443). Required when role = agent.";
    };

    token = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "k3s cluster join token. Required when role = agent (unless tokenFile is set).";
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

      dualStack = lib.mkEnableOption "IPv4/IPv6 dual-stack networking for pods and services";
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
  };

  config = lib.mkIf cfg.enable {
    # Kata config with VM sizing annotations enabled
    environment.etc."kata-containers/configuration.toml".text = kataConfig;

    # ip forwarding for pod networking
    boot.kernel.sysctl."net.ipv4.ip_forward" = 1;
    boot.kernel.sysctl."net.ipv6.conf.all.forwarding" = 1;

    # Kernel modules for Kata VM isolation
    boot.kernelModules = [ "vhost_net" "vhost_vsock" ];

    # nix-snapshotter: resolve nix store paths in container images
    services.nix-snapshotter.enable = lib.mkIf cfg.nixSnapshotter.enable true;

    services.k3s = {
      enable = true;
      role = cfg.role;
      snapshotter = lib.mkIf cfg.nixSnapshotter.enable "nix";

      extraFlags = lib.concatLists [
        (lib.optionals (cfg.role == "server") disableFlags)
        [ "--https-listen-port ${toString cfg.k3s.port}" ]
        [ "--write-kubeconfig-mode ${cfg.k3s.kubeconfigMode}" ]
        (lib.optionals cfg.k3s.dualStack [
          "--cluster-cidr=10.42.0.0/16,fd00::/56"
          "--service-cidr=10.43.0.0/16,fd01::/108"
        ])
        cfg.k3s.extraFlags
      ];

      serverAddr = lib.mkIf (cfg.serverAddr != "") cfg.serverAddr;
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

        # Deploy RuntimeClass manifest before k3s starts (server only)
        ExecStartPre = lib.mkIf (cfg.role == "server") [
          "+${pkgs.writeShellScript "seed-manifests" ''
            mkdir -p /var/lib/rancher/k3s/server/manifests
            ln -sf ${runtimeClassManifest} /var/lib/rancher/k3s/server/manifests/seed-kata-runtime-class.yaml
            ln -sf ${metallbManifest} /var/lib/rancher/k3s/server/manifests/seed-metallb.yaml
          ''}"
        ];
      };
    };
  };
}
