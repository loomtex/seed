# Minimal NixOS netboot image for iPXE-based provisioning.
#
# This boots into a live NixOS environment with SSH enabled.
# nixos-anywhere connects via SSH and handles disko + install.
# No node identity needed — Pulumi knows which IP to connect to.
{ modulesPath, lib, ... }:

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

  # Intel 10GbE NIC driver (Vultr bare metal uses ixgbe)
  boot.initrd.availableKernelModules = [ "ixgbe" ];

  # The iPXE environment has networking via DHCP
  networking.useDHCP = lib.mkForce true;

  system.stateVersion = "25.11";
}
