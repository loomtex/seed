# LUKS full-disk encryption profile for seed nodes
# Provides: Clevis/Tang auto-unlock + initrd SSH fallback
#
# Post-install steps (per node):
#   1. Generate initrd SSH host key into extra-files dir (as current user, 600 perms)
#   2. Run nixos-anywhere with --extra-files and --disk-encryption-keys
#   3. SSH into initrd (port 2222) for first boot to enter LUKS passphrase
#   4. Create JWE: echo -n <passphrase> | clevis encrypt tang '{"url":"..."}' > /persist/secrets/clevis-cryptroot.jwe
#   5. Enable boot.initrd.clevis in disks.nix, nixos-rebuild boot && reboot
{ config, lib, pkgs, ... }:

{
  # Systemd-based initrd (required for clevis, better SSH support)
  boot.initrd.systemd.enable = true;

  # Clevis + jose available on system for binding/debugging
  environment.systemPackages = [ pkgs.clevis pkgs.jose ];

  # NIC driver in initrd for network-based unlock
  boot.initrd.availableKernelModules = [ "ixgbe" ];

  # Network in initrd (DHCP for Tang + SSH)
  boot.initrd.systemd.network = {
    enable = true;
    networks."10-enp1s0f0" = {
      matchConfig.Name = "enp1s0f0";
      networkConfig.DHCP = "ipv4";
      # Wait for DHCP to complete before declaring network "online"
      # (clevis needs a routable address to reach Tang)
      linkConfig.RequiredForOnline = "routable";
    };
  };

  # SSH in initrd — fallback for manual LUKS unlock when Tang is down
  boot.initrd.network.ssh = {
    enable = true;
    port = 2222;
    authorizedKeys =
      config.users.users.josh.openssh.authorizedKeys.keys
      ++ config.users.users.ada.openssh.authorizedKeys.keys;
    hostKeys = [ "/persist/secrets/initrd/ssh_host_ed25519_key" ];
  };

  # Shell for initrd SSH: bash + auto-start password agent
  boot.initrd.systemd.users.root.shell = "/bin/bash";
  boot.initrd.systemd.extraBin.bash = "${pkgs.bashInteractive}/bin/bash";
  boot.initrd.systemd.contents."/root/.profile".text = ''
    systemd-tty-ask-password-agent
  '';

  # Clevis/Tang auto-unlock (enabled per-node after binding)
  boot.initrd.clevis = {
    enable = lib.mkDefault false;
    useTang = true;
  };

}
