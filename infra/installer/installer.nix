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
    path = with pkgs; [ curl iproute2 gawk gnugrep coreutils ];
    script = ''
      # Extract phone_home URL from kernel cmdline (set by iPXE boot script)
      CMDLINE=$(cat /proc/cmdline)
      URL=""
      for param in $CMDLINE; do
        case "$param" in
          phone_home=*) URL="''${param#phone_home=}" ;;
        esac
      done
      [ -z "$URL" ] && echo "No phone_home= in cmdline, skipping" && exit 0

      echo "Phone home URL: $URL"

      # Wait for a default route (DHCP may still be running)
      ATTEMPTS=0
      while ! ip route show default 2>/dev/null | grep -q default; do
        ATTEMPTS=$((ATTEMPTS + 1))
        echo "Waiting for default route... ($ATTEMPTS)"
        [ $ATTEMPTS -ge 60 ] && echo "No default route after 60 attempts" && exit 1
        sleep 5
      done

      DEV=$(ip route show default | awk '/default/ {print $5; exit}')
      MAC=$(cat /sys/class/net/$DEV/address)
      IP=$(ip -4 addr show $DEV | awk '/inet / {split($2,a,"/"); print a[1]; exit}')
      SERIAL=$(cat /sys/class/dmi/id/product_serial 2>/dev/null || echo "unknown")

      echo "Registering: dev=$DEV mac=$MAC ip=$IP serial=$SERIAL"

      until curl -sf -X POST "$URL" \
        -H "Content-Type: application/json" \
        -d "{\"mac\":\"$MAC\",\"ip\":\"$IP\",\"serial\":\"$SERIAL\"}"; do
        echo "Phone home failed, retrying in 10s..."
        sleep 10
      done
      echo "Phone home successful"
    '';
  };

  system.stateVersion = "25.11";
}
