# Vultr VPC v1 static network configuration
#
# Vultr VPC v1 has no DHCP — interfaces must be statically configured.
# IP allocation is centralized in data/vpc.nix — machines are looked up
# by hostname automatically. Just import this profile.
#
# Also configures the VPC NIC in the initrd for nodes that use LUKS
# auto-unlock via Clevis/Tang over the VPC network.
{ config, lib, pkgs, ... }:

let
  vpcData = import ../data/vpc.nix;
  myEntry = vpcData.hosts.${config.networking.hostName} or null;
  cfg = config.seed;
in {
  options.seed.vpcAddress = lib.mkOption {
    type = lib.types.nullOr lib.types.str;
    default = if myEntry != null then myEntry.ip else null;
    description = "Static IPv4 address for the Vultr VPC interface. Auto-resolved from data/vpc.nix by hostname.";
  };

  options.seed.vpcPublicNic = lib.mkOption {
    type = lib.types.str;
    default = if myEntry != null then myEntry.publicNic or "enp1s0f0" else "enp1s0f0";
    description = "Name of the primary (public) NIC — excluded from VPC auto-detection. Auto-resolved from data/vpc.nix.";
  };

  config = lib.mkIf (cfg.vpcAddress != null) {
    # --- Runtime: auto-detect VPC NIC and assign static IP ---
    systemd.services.seed-vpc = {
      description = "Configure Vultr VPC network interface";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      wants = [ "network.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
      };
      path = with pkgs; [ iproute2 gawk ];
      script = ''
        # Wait for default route (DHCP on public NIC may still be starting)
        for i in $(seq 1 30); do
          DEFAULT_IF=$(ip -4 route show default | head -1 | awk '{for(i=1;i<=NF;i++) if($i=="dev") print $(i+1)}')
          [ -n "$DEFAULT_IF" ] && break
          sleep 1
        done

        if [ -z "$DEFAULT_IF" ]; then
          echo "ERROR: no default route after 30s" >&2
          exit 1
        fi

        # Find VPC interface: physical NIC that isn't the default route interface
        for iface in /sys/class/net/*/; do
          name=$(basename "$iface")
          [ "$name" = "lo" ] && continue
          [ "$name" = "$DEFAULT_IF" ] && continue
          [ -d "/sys/class/net/$name/device" ] || continue

          ip addr add ${cfg.vpcAddress}/24 dev "$name" 2>/dev/null || true
          ip link set dev "$name" mtu 1450
          ip link set dev "$name" up
          echo "Configured VPC: $name = ${cfg.vpcAddress}/24 (mtu 1450)"
          exit 0
        done

        echo "WARNING: no VPC interface found" >&2
        exit 1
      '';
    };

    # --- Initrd: static VPC config for LUKS/Clevis Tang unlock ---
    # Only effective when boot.initrd.systemd.enable = true (set by seed-luks.nix).
    # Uses systemd-networkd match: any enp* device except the primary NIC.
    boot.initrd.systemd.network.networks."20-vpc" = {
      matchConfig.Name = "enp* !${cfg.vpcPublicNic}";
      address = [ "${cfg.vpcAddress}/24" ];
      linkConfig.MTUBytes = "1450";
      networkConfig.DHCP = "no";
    };

    # Ensure common VPC NIC drivers are available in initrd
    boot.initrd.availableKernelModules = [ "virtio_net" "igb" ];
  };
}
