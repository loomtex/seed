{ config, pkgs, ... }:

{
  imports = [
    ../../../profiles/server.nix
    ../../../profiles/seed-local-users.nix
    ../../../profiles/seed-cache.nix
    ../../../profiles/seed-luks.nix
    ../../../profiles/seed-vpc.nix
    ../../../profiles/seed-controller.nix
  ];

  sops = {
    age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    secrets."seed/k3s-token" = {};
  };

  # GRUB: works from both BIOS and EFI installs (iPXE netboot is BIOS-only
  # on Vultr bare metal, so systemd-boot's bootctl install gets skipped).
  boot.loader.grub = {
    enable = true;
    efiSupport = true;
    efiInstallAsRemovable = true;  # writes \EFI\BOOT\BOOTX64.EFI — no NVRAM needed
    device = "/dev/disk/by-path/pci-0000:00:17.0-ata-5";
  };
  boot.loader.efi.canTouchEfiVariables = false;
  boot.loader.timeout = 5;

  boot.kernelParams = [
    "console=tty0" "console=ttyS0,115200n8"
  ];

  # Allow ada to push closures for remote deploys
  nix.settings.trusted-users = [ "root" "ada" ];

  # Seed: k3s HA bootstrap node (first server, etcd init)
  seed = {
    enable = true;
    role = "server";
    tokenFile = config.sops.secrets."seed/k3s-token".path;
    persistence.enable = true;
    persistence.path = "/persist";
    k3s.dualStack = true;
    k3s.autoNodeIp = "vultr";
  };

  # Impermanence mappings
  environment.persistence."/persist" = {
    hideMounts = true;
    directories = [
      "/root"
      "/var/cache/nix"
      "/var/log"
      "/var/lib/nixos"
      "/var/lib/systemd/coredump"
    ];
    files = [
      "/etc/machine-id"
      "/etc/ssh/ssh_host_ed25519_key.pub"
      "/etc/ssh/ssh_host_ed25519_key"
      "/etc/ssh/ssh_host_rsa_key.pub"
      "/etc/ssh/ssh_host_rsa_key"
    ];
  };

  # Don't build in /tmp ramdisk
  systemd.services.nix-daemon = {
    environment.TMPDIR = "/var/cache/nix";
    serviceConfig.CacheDirectory = "nix";
  };
  environment.variables.NIX_REMOTE = "daemon";

  system.autoUpgrade = {
    enable = true;
    dates = "04:00";
    flake = "github:loomtex/seed-infra";
    allowReboot = false;
  };

  networking = {
    interfaces.enp1s0f0.useDHCP = true;
    # IPv6: SLAAC handles address + gateway (accept_ra=2 set by seed module)
    # Reserved IPs: MetalLB L2 speaker manages them on the interface
    firewall = {
      enable = true;
      allowedTCPPorts = [
        22    # SSH
        6443  # k3s API
        2379  # etcd client
        2380  # etcd peer
      ];
    };
  };

  time.timeZone = "America/Denver";
  i18n.defaultLocale = "en_US.UTF-8";

  environment.systemPackages = with pkgs; [
    inetutils
    mtr
    sysstat
  ];

  services.openssh = {
    enable = true;
    settings.PermitRootLogin = "no";
  };

  system.stateVersion = "25.11";
}
