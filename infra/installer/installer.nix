# Minimal NixOS netboot image for iPXE-based provisioning.
#
# This boots into a live NixOS environment with SSH enabled.
# nixos-anywhere connects via SSH and handles disko + install.
# No node identity needed — Pulumi knows which IP to connect to.
{ modulesPath, lib, pkgs, ... }:

{
  imports = [
    "${modulesPath}/installer/netboot/netboot-minimal.nix"
  ];

  services.openssh = {
    enable = true;
    settings.PermitRootLogin = "yes";
  };

  users.users.root.openssh.authorizedKeys.keys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICsPaFplk95wdbZnGF9q1LnQUKy36Lh+4dSHyFJwMeUK josh@6bit.com"
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4wKwiX1fnwB/U4Mc7JT4ddMExopexk0DUSd7Du12Sp ada@signi"
  ];

  # Network drivers: ixgbe for Vultr bare metal (10GbE), virtio for Vultr VMs.
  # Loaded in initrd so they're available before stage 2 networking starts.
  boot.initrd.availableKernelModules = [ "ixgbe" "virtio_net" "virtio_pci" ];

  # Force DHCP on all interfaces in stage 2.
  # netboot-minimal.nix disables NetworkManager, so this uses dhcpcd.
  networking.useDHCP = lib.mkForce true;

  # Phone-home: announce ourselves to the stake's registration endpoint.
  # The phone_home= kernel param is set by the iPXE boot script and carries
  # the stake's registration URL (e.g. http://<stake>:8081/register).
  # On boot, we POST our MAC, IP, and serial number so the provision script
  # can react to machine arrivals via inotify instead of polling SSH.
  systemd.services.phone-home = {
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    path = [ pkgs.curl pkgs.iproute2 pkgs.gawk ];
    script = ''
      URL=$(grep -oP 'phone_home=\K\S+' /proc/cmdline || true)
      [ -z "$URL" ] && exit 0

      DEV=$(ip route show default | awk '/default/ {print $5; exit}')
      MAC=$(cat /sys/class/net/$DEV/address)
      IP=$(ip -4 addr show $DEV | grep -oP 'inet \K[\d.]+' | head -1)
      SERIAL=$(cat /sys/class/dmi/id/product_serial 2>/dev/null || echo "unknown")

      until curl -sf -X POST "$URL" \
        -H "Content-Type: application/json" \
        -d "{\"mac\":\"$MAC\",\"ip\":\"$IP\",\"serial\":\"$SERIAL\"}"; do
        sleep 10
      done
    '';
  };

  system.stateVersion = "25.11";
}
