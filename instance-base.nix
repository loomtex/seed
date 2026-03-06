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

  # TPM identity provisioning — generates age-plugin-tpm identity on first boot.
  # The identity file at /seed/tpm/age-identity contains the public key (recipient)
  # on its first line, usable for encrypting sops secrets for this instance.
  systemd.services.seed-tpm-init = {
    description = "Generate age-plugin-tpm identity for sops-nix";
    wantedBy = [ "multi-user.target" ];
    before = lib.mkDefault [ "sops-nix.service" ];
    unitConfig.ConditionPathExists = "!/seed/tpm/age-identity";
    path = [ pkgs.coreutils pkgs.util-linux pkgs.gnugrep ];
    serviceConfig = {
      Type = "oneshot";
      ExecStartPre = [
        "${pkgs.coreutils}/bin/mkdir -p /seed/tpm"
        # TPM diagnostics: write to PVC so host can read results
        "+${pkgs.writeShellScript "tpm-diag" ''
          exec > /seed/tpm/diagnostics.txt 2>&1
          echo "=== TPM diagnostics $(date) ==="
          echo "--- dmesg tpm/crb/acpi ---"
          dmesg 2>/dev/null | grep -i -E 'tpm|crb|msft0101|fed40' || echo "(no matches)"
          echo "--- /proc/iomem (fed40) ---"
          grep -i fed40 /proc/iomem 2>/dev/null || echo "(no matches)"
          echo "--- /sys/firmware/acpi/tables ---"
          ls -la /sys/firmware/acpi/tables/ 2>/dev/null | grep -i tpm || echo "(no TPM2 table)"
          echo "--- /sys/class/tpm ---"
          ls -la /sys/class/tpm/ 2>/dev/null || echo "(no tpm class)"
          echo "--- /dev/tpm* ---"
          ls -la /dev/tpm* 2>/dev/null || echo "(no tpm devices)"
          echo "=== end TPM diagnostics ==="
        ''}"
      ];
      ExecStart = "${pkgs.age-plugin-tpm}/bin/age-plugin-tpm --generate -o /seed/tpm/age-identity";
      RemainAfterExit = true;
    };
  };

  system.stateVersion = lib.mkDefault "25.11";
}
