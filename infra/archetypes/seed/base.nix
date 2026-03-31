# Base configuration shared by all seed k3s nodes.
# Host-specific settings (hostname, sopsFile, timeZone, hardware, controller)
# are provided by the archetype functions in flake.nix.
{ config, pkgs, ... }:

{
  imports = [
    ../../profiles/server.nix
    ../../profiles/seed-local-users.nix
    ../../profiles/seed-cache.nix
    ../../profiles/seed-luks.nix
    ../../profiles/seed-vpc.nix
    ../../profiles/seed-ceph.nix
    ../../profiles/seed-ceph-csi.nix
  ];

  sops = {
    age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    secrets."seed/k3s-token" = {};
  };

  # Allow ada to push closures for remote deploys
  nix.settings.trusted-users = [ "root" "ada" ];

  seed = {
    enable = true;
    role = "server";
    tokenFile = config.sops.secrets."seed/k3s-token".path;
    persistence.enable = true;
    persistence.path = "/persist";
    k3s.dualStack = true;
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
    flake = "github:loomtex/seed?dir=infra";
    allowReboot = false;
  };

  # Disable IPv6 privacy extensions on the public NIC — 'all' and 'default'
  # sysctls don't affect interfaces that exist before sysctl runs. Per-interface
  # override is required for BGP source address to be the stable SLAAC EUI-64.
  boot.kernel.sysctl."net.ipv6.conf.enp1s0f0.use_tempaddr" = lib.mkForce 0;

  networking = {
    interfaces.enp1s0f0.useDHCP = true;
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
