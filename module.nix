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

      autoNodeIp = lib.mkOption {
        type = lib.types.enum [ "disabled" "vultr" ];
        default = "disabled";
        description = ''
          Cloud metadata provider for deriving --node-ip at boot.
          "vultr" — queries http://169.254.169.254/v1.json for IPv4/IPv6.
          Also reads /persist/seed/server-addr (if present) for cluster join.
          Writes /run/k3s/node-config.yaml consumed by k3s --config.
        '';
      };
    };

    dns = {
      nameserver = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = ''
          VPC DNS resolver IP (e.g. tang's VPC address). When set with autoNodeIp,
          the derive-node-ip script configures this as the system nameserver via resolvectl
          after the VPC interface is up.
        '';
      };

      searchDomains = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "DNS search domains (e.g. [\"atl.combine.loom.farm\" \"combine.loom.farm\"]).";
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
  };

  config = lib.mkIf cfg.enable {
    # k3s cluster communication ports
    networking.firewall.allowedTCPPorts = lib.mkIf (cfg.role == "server") [
      2379  # etcd client
      2380  # etcd peer
    ];
    networking.firewall.allowedUDPPorts = [
      8472  # flannel VXLAN (cross-node pod traffic)
    ];

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

    # Kernel modules for Kata VM isolation
    boot.kernelModules = [ "vhost_net" "vhost_vsock" ];

    # nix-snapshotter: resolve nix store paths in container images
    services.nix-snapshotter.enable = lib.mkIf cfg.nixSnapshotter.enable true;

    services.k3s = {
      enable = true;
      role = cfg.role;
      snapshotter = lib.mkIf cfg.nixSnapshotter.enable "nix";

      extraFlags = lib.concatLists [
        (lib.optionals (cfg.k3s.autoNodeIp != "disabled") [
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

      serverAddr = lib.mkIf (cfg.serverAddr != "" && !(cfg.k3s.autoNodeIp != "disabled")) cfg.serverAddr;
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

        ExecStartPre =
          # Derive node-ip (and optionally server-addr) from cloud metadata
          (lib.optionals (cfg.k3s.autoNodeIp != "disabled") [
            "+${pkgs.writeShellScript "seed-derive-node-ip" ''
              set -euo pipefail
              mkdir -p /run/k3s

              ${lib.optionalString (cfg.k3s.autoNodeIp == "vultr") ''
                # Query Vultr metadata API (retry up to 30s for slow network)
                META=""
                for i in $(seq 1 15); do
                  META=$(${pkgs.curl}/bin/curl -sf http://169.254.169.254/v1.json) && break
                  sleep 2
                done

                if [ -z "$META" ]; then
                  echo "WARNING: metadata API unreachable, writing empty config" >&2
                  echo "# metadata unavailable" > /run/k3s/node-config.yaml
                  exit 0
                fi

                IPV4=$(echo "$META" | ${pkgs.jq}/bin/jq -r 'first(.interfaces[] | select(.["network-type"] == "public") | .ipv4.address) // empty')
                IPV6=$(echo "$META" | ${pkgs.jq}/bin/jq -r 'first(.interfaces[] | select(.["network-type"] == "public") | .ipv6.address) // empty')

                # VPC interface: find private network, configure IP by MAC address
                VPC_MAC=$(echo "$META" | ${pkgs.jq}/bin/jq -r 'first(.interfaces[] | select(.["network-type"] == "private") | .["mac-address"]) // empty')
                VPC_IP=$(echo "$META" | ${pkgs.jq}/bin/jq -r 'first(.interfaces[] | select(.["network-type"] == "private") | .ipv4.address) // empty')
                VPC_MASK=$(echo "$META" | ${pkgs.jq}/bin/jq -r 'first(.interfaces[] | select(.["network-type"] == "private") | .ipv4.netmask) // empty')

                if [ -n "$VPC_MAC" ] && [ -n "$VPC_IP" ]; then
                  # Find interface name by MAC address
                  VPC_IFACE=""
                  for iface in /sys/class/net/*/address; do
                    if [ "$(cat "$iface")" = "$VPC_MAC" ]; then
                      VPC_IFACE=$(basename "$(dirname "$iface")")
                      break
                    fi
                  done

                  if [ -n "$VPC_IFACE" ]; then
                    # Convert netmask to CIDR prefix length
                    CIDR=$(echo "$VPC_MASK" | ${pkgs.gawk}/bin/awk -F. '{
                      split($0, a, ".");
                      bits=0;
                      for(i=1;i<=4;i++) {
                        n=a[i];
                        while(n>0) { bits+=n%2; n=int(n/2) }
                      }
                      print bits
                    }')

                    ${pkgs.iproute2}/bin/ip addr add "$VPC_IP/$CIDR" dev "$VPC_IFACE" 2>/dev/null || true
                    ${pkgs.iproute2}/bin/ip link set "$VPC_IFACE" up

                    # Use VPC IP as node-ip, public IPs as external
                    echo "node-ip: \"$VPC_IP\"" > /run/k3s/node-config.yaml
                    if [ -n "$IPV6" ]; then
                      echo "node-external-ip: \"$IPV4,$IPV6\"" >> /run/k3s/node-config.yaml
                    else
                      echo "node-external-ip: \"$IPV4\"" >> /run/k3s/node-config.yaml
                    fi

                    ${lib.optionalString (cfg.dns.nameserver != null) ''
                      # Configure DNS resolver on the VPC interface
                      ${pkgs.systemd}/bin/resolvectl dns "$VPC_IFACE" ${cfg.dns.nameserver}
                      ${lib.optionalString (cfg.dns.searchDomains != []) ''
                        ${pkgs.systemd}/bin/resolvectl domain "$VPC_IFACE" ${lib.concatStringsSep " " cfg.dns.searchDomains}
                      ''}
                    ''}
                  else
                    echo "WARNING: VPC MAC $VPC_MAC not found, using public IPs" >&2
                    if [ -n "$IPV6" ]; then
                      echo "node-ip: \"$IPV4,$IPV6\"" > /run/k3s/node-config.yaml
                    else
                      echo "node-ip: \"$IPV4\"" > /run/k3s/node-config.yaml
                    fi
                  fi
                else
                  if [ -n "$IPV6" ]; then
                    echo "node-ip: \"$IPV4,$IPV6\"" > /run/k3s/node-config.yaml
                  else
                    echo "node-ip: \"$IPV4\"" > /run/k3s/node-config.yaml
                  fi
                fi
              ''}

              # If a server-addr file exists (written by provisioner for joining nodes),
              # add it to the k3s config so we don't hardcode the init node's IP.
              if [ -f /persist/seed/server-addr ]; then
                echo "server: \"$(cat /persist/seed/server-addr)\"" >> /run/k3s/node-config.yaml
              fi
            ''}"
          ]) ++
          # Deploy RuntimeClass + MetalLB manifests (server only)
          (lib.optionals (cfg.role == "server") [
            "+${pkgs.writeShellScript "seed-manifests" ''
              mkdir -p /var/lib/rancher/k3s/server/manifests
              ln -sf ${runtimeClassManifest} /var/lib/rancher/k3s/server/manifests/seed-kata-runtime-class.yaml
              ln -sf ${metallbManifest} /var/lib/rancher/k3s/server/manifests/seed-metallb.yaml
            ''}"
          ]);
      };
    };
  };
}
