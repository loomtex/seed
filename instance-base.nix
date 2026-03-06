# Stripped NixOS profile for Seed instances running inside Kata VMs
#
# Kata provides the kernel, initrd, and virtio networking. This profile
# disables everything NixOS would normally configure for bare metal/VM boot.
# All settings use mkDefault so tenants can override if needed.
{ lib, pkgs, ... }:

let
  tpmDevCreate = pkgs.writeShellScript "tpm-dev-create" ''
    for tpm in /sys/class/tpm/tpm*; do
      [ -e "$tpm" ] || continue
      name=$(basename "$tpm")
      if [ ! -e "/dev/$name" ]; then
        dev=$(cat "$tpm/dev" 2>/dev/null) || continue
        major=''${dev%%:*}
        minor=''${dev##*:}
        mknod "/dev/$name" c "$major" "$minor"
        chmod 0660 "/dev/$name"
      fi
    done

    # Also create /dev/tpmrm* (resource manager interface)
    for tpmrm in /sys/class/tpmrm/tpmrm*; do
      [ -e "$tpmrm" ] || continue
      name=$(basename "$tpmrm")
      if [ ! -e "/dev/$name" ]; then
        dev=$(cat "$tpmrm/dev" 2>/dev/null) || continue
        major=''${dev%%:*}
        minor=''${dev##*:}
        mknod "/dev/$name" c "$major" "$minor"
        chmod 0660 "/dev/$name"
      fi
    done
  '';
in {
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

  # Minimal package set — just enough for systemd services to function,
  # plus TPM/secrets tooling for sops-nix integration
  environment.systemPackages = lib.mkDefault (with pkgs; [
    coreutils
    bashInteractive
    util-linux
    age
    age-plugin-tpm
    tpm2-tools
    sops
  ]);

  # No polkit — headless instances don't need privilege negotiation
  security.polkit.enable = lib.mkDefault false;

  # Create TPM device nodes on every boot. Kata VMs use tmpfs on /dev (not
  # devtmpfs), so the kernel doesn't auto-create device nodes. This must run
  # unconditionally — seed-tpm-init only runs on first boot, but sops-nix
  # needs /dev/tpm0 on every boot for decryption.
  systemd.services.seed-tpm-dev = {
    description = "Create TPM device nodes from sysfs";
    wantedBy = [ "multi-user.target" ];
    before = lib.mkDefault [ "seed-tpm-init.service" "sops-nix.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "+" + tpmDevCreate;
    };
  };

  # TPM identity provisioning — generates age-plugin-tpm identity on first boot.
  # The identity file at /seed/tpm/age-identity contains the public key (recipient)
  # on its first line, usable for encrypting sops secrets for this instance.
  systemd.services.seed-tpm-init = {
    description = "Generate age-plugin-tpm identity for sops-nix";
    wantedBy = [ "multi-user.target" ];
    after = [ "seed-tpm-dev.service" ];
    requires = [ "seed-tpm-dev.service" ];
    before = lib.mkDefault [ "sops-nix.service" ];
    unitConfig.ConditionPathExists = "!/seed/tpm/age-identity";
    serviceConfig = {
      Type = "oneshot";
      ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p /seed/tpm";
      ExecStart = "${pkgs.age-plugin-tpm}/bin/age-plugin-tpm --generate -o /seed/tpm/age-identity";
      RemainAfterExit = true;
    };
  };

  # Default sops-nix to use the TPM-backed age identity provisioned by seed-tpm-init.
  # Instances using sops.secrets.* will decrypt via their unique vTPM key automatically.
  sops.age.keyFile = lib.mkDefault "/seed/tpm/age-identity";

  system.stateVersion = lib.mkDefault "25.11";
}
