{ config, pkgs, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./disks.nix
    ../../../profiles/server.nix
    ../../../profiles/seed-cache.nix
    ../../../profiles/seed-luks.nix
    ../../../profiles/seed-vpc.nix
    ../../../profiles/seed-controller.nix
  ];

  sops = {
    defaultSopsFile = ../../../secrets/seed-atl-1.yaml;
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
    k3s.clusterInit = true;
    k3s.dualStack = true;
    k3s.autoNodeIp = "vultr";
    controller = {
      enable = true;
      flakePaths = [
        "github:loomtex/seed"
      ];
      ipv4Address = "96.30.193.227";
      ipv6Block = "2001:19f0:5400:20a7::/64";
      webhook = {
        enable = true;
        secretFile = config.sops.secrets."seed/controller/gh-webhook-secret".path;
      };
    };
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
    allowReboot = true;
  };

  networking = {
    hostName = "seed-atl-1";
    interfaces.enp1s0f0.useDHCP = true;
    # IPv6: SLAAC handles address + gateway (accept_ra=2 set by seed module)
    # Reserved IPs: MetalLB L2 speaker manages them on the interface
    firewall = {
      enable = true;
      allowedTCPPorts = [
        22    # SSH
        53    # DNS (seed ipv4 route)
        80    # HTTP (seed ipv4 route)
        443   # HTTPS (seed ipv4 route)
        6443  # k3s API
        2379  # etcd client
        2380  # etcd peer
      ];
      allowedUDPPorts = [
        53    # DNS (seed ipv4 route)
      ];
    };
  };

  time.timeZone = "America/New_York";
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

  users.mutableUsers = false;

  users.users.josh = {
    uid = 1000;
    group = "josh";
    initialHashedPassword = "$6$rounds=3000000$plps8mAYoxl.ngM7$UICj9iFn3SvWEBmD6Zsv0pWu8fru2jGNqvXazc7BjM9CJJxCna.du8yytejQeAL9yjQ.943AXyv8fjgSxOX.4.";
    isNormalUser = true;
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICsPaFplk95wdbZnGF9q1LnQUKy36Lh+4dSHyFJwMeUK josh@6bit.com"
    ];
  };
  users.groups.josh = { gid = 1000; };

  users.users.ada = {
    uid = 1100;
    group = "ada";
    isNormalUser = true;
    hashedPassword = "!";
    openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4wKwiX1fnwB/U4Mc7JT4ddMExopexk0DUSd7Du12Sp ada@signi"
    ];
  };
  users.groups.ada = { gid = 1100; };

  security.sudo.extraRules = [{
    users = [ "ada" ];
    commands = [{ command = "ALL"; options = [ "NOPASSWD" ]; }];
  }];

  system.stateVersion = "25.11";
}
