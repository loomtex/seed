# Stripped NixOS profile for Seed instances running inside Kata VMs
#
# Kata provides the kernel, initrd, and virtio networking. This profile
# disables everything NixOS would normally configure for bare metal/VM boot.
# All settings use mkDefault so tenants can override if needed.
{ lib, pkgs, ... }:

{
  # boot.isContainer disables kernel, initrd, bootloader, and hardware scan.
  # Kata VMs run real systemd (not container init), but isContainer gives us
  # the right closure size. Services needing /run/* dirs should use RuntimeDirectory.
  boot.isContainer = lib.mkDefault true;

  # No documentation — smaller closure
  documentation.enable = lib.mkDefault false;

  # No nix daemon — instances are pre-built closures
  nix.enable = lib.mkDefault false;

  # No sudo — there's no interactive shell escalation in instances
  security.sudo.enable = lib.mkDefault false;

  # Immutable users — no passwd/shadow management
  users.mutableUsers = lib.mkDefault false;

  # No interactive login — instances are headless, managed by the controller
  users.allowNoPasswordLogin = lib.mkDefault true;

  # Kata handles networking via virtio-net + tc redirects
  networking.useDHCP = lib.mkDefault false;

  # Minimal package set — just enough for systemd services to function
  environment.systemPackages = lib.mkDefault (with pkgs; [
    coreutils
    bashInteractive
    util-linux
  ]);

  # No polkit — headless instances don't need privilege negotiation
  security.polkit.enable = lib.mkDefault false;

  # Forward structured journal to console — kubectl logs captures /dev/console
  # output from Kata VMs, but systemd journal is internal by default
  services.journald.extraConfig = lib.mkDefault ''
    ForwardToConsole=yes
    TTYPath=/dev/console
    MaxLevelConsole=info
  '';

  system.stateVersion = lib.mkDefault "25.11";
}
