# Stripped NixOS profile for Seed instances running inside Kata VMs
#
# Kata provides the kernel, initrd, and virtio networking. This profile
# disables everything NixOS would normally configure for bare metal/VM boot.
# All settings use mkDefault so tenants can override if needed.
{ lib, pkgs, config, ... }:

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

  # k8s service DNS (CoreDNS) — enables service name resolution + external DNS
  networking.nameservers = lib.mkDefault [ "10.43.0.10" ];

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

  # No nscd/nsncd — instances use /etc/resolv.conf + /etc/passwd directly.
  # nsncd fails in Kata VMs and cascades to nss-lookup.target failure,
  # breaking DNS resolution and user lookups for all services.
  services.nscd.enable = lib.mkDefault false;
  system.nssModules = lib.mkForce [];

  # Create TPM device nodes during NixOS activation, before sops-nix runs.
  # Kata VMs use tmpfs on /dev (not devtmpfs), so the kernel doesn't
  # auto-create device nodes. sops-nix's setupSecrets activation script runs
  # before systemd starts, so we must create /dev/tpm* during activation too.
  system.activationScripts.tpmDevNodes = {
    deps = [];
    text = ''
      ${tpmDevCreate}
    '';
  };

  # Ensure sops-nix's setupSecrets runs after TPM device nodes exist.
  # Provide a no-op default text so this works even when no secrets are defined.
  system.activationScripts.setupSecrets = {
    deps = [ "tpmDevNodes" ];
    text = lib.mkDefault "";
  };

  # TPM identity provisioning — generates age-plugin-tpm identity on first boot.
  # The identity file at /seed/tpm/age-identity contains the public key (recipient)
  # on its first line, usable for encrypting sops secrets for this instance.
  systemd.services.seed-tpm-init = {
    description = "Generate age-plugin-tpm identity for sops-nix";
    wantedBy = [ "multi-user.target" ];
    before = lib.mkDefault [ "sops-nix.service" ];
    unitConfig.ConditionPathExists = "!/seed/tpm/age-identity";
    path = [ pkgs.coreutils ];
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
  sops.age.plugins = lib.mkDefault [ pkgs.age-plugin-tpm ];

  # Trust the platform CA if mounted by the controller.
  # NixOS creates /etc/ssl/certs/ca-certificates.crt as a symlink to the nix
  # store CA bundle. We replace it with a combined bundle (mozilla roots +
  # platform CA) so ALL programs trust it — including those in sanitized
  # environments (sshd AuthorizedKeysCommand, git hooks, etc.) where
  # SSL_CERT_FILE isn't available.
  system.activationScripts.seedTrust = {
    deps = [ "etc" ];
    text = ''
      if [ -f /etc/seed/ca/ca.crt ]; then
        rm -f /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
        cat ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt /etc/seed/ca/ca.crt > /etc/ssl/certs/ca-certificates.crt
        ln -sf /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-bundle.crt
        ln -sf /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt
      fi
    '';
  };

  # Capture k8s-injected SEED_* environment variables for use by services.
  # Kata VMs: systemd strips the inherited environment on startup, so
  # PassEnvironment doesn't work. This activation script reads PID 1's
  # original environment (preserved in /proc/1/environ) and writes SEED_*
  # vars to /run/seed/env. Services use EnvironmentFile=/run/seed/env.
  system.activationScripts.seedEnv = {
    text = ''
      mkdir -p /run/seed
      ${pkgs.coreutils}/bin/tr '\0' '\n' < /proc/1/environ | ${pkgs.gnugrep}/bin/grep '^SEED_' > /run/seed/env || true
    '';
  };

  system.stateVersion = lib.mkDefault "25.11";
}
