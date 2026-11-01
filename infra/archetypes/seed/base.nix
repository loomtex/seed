# Base configuration shared by all seed k3s nodes.
# Host-specific settings (hostname, sopsFile, timeZone, hardware, controller)
# are provided by the archetype functions in flake.nix.
{ config, pkgs, lib, clusterNodes, clusterCeph, ... }:

let
  # Auto-upgrade schedule: round-robin into a fixed set of 30-minute buckets
  # from 04:00, so adding a node never means picking a slot by hand.
  #
  # k3s servers are ordered first and must each get their own bucket: an
  # upgrade can restart k3s (e.g. a containerd config change), and two servers
  # restarting together would drop etcd below quorum. Other nodes (k3sRole =
  # "agent") fill the buckets round-robin after them. A small fixed per-host
  # jitter keeps nodes sharing a bucket from hitting GitHub and the cache at
  # the same second.
  upgradeBuckets = 4;
  bucketMinutes = 30;
  firstUpgradeMinutes = 4 * 60;
  isServer = node: (node.k3sRole or "server") == "server";
  sortedNames = lib.sort lib.lessThan (lib.attrNames clusterNodes);
  serverNames = lib.filter (n: isServer clusterNodes.${n}) sortedNames;
  upgradeOrder = serverNames ++ lib.filter (n: !isServer clusterNodes.${n}) sortedNames;
  nodeIndex = lib.lists.findFirstIndex (n: n == config.networking.hostName) 0 upgradeOrder;
  upgradeMinutes = firstUpgradeMinutes + bucketMinutes * (lib.mod nodeIndex upgradeBuckets);
  upgradeTime = "${lib.fixedWidthNumber 2 (upgradeMinutes / 60)}:${lib.fixedWidthNumber 2 (lib.mod upgradeMinutes 60)}";
in
{
  imports = [
    ../../profiles/server.nix
    ../../profiles/seed-local-users.nix
    ../../profiles/seed-cache.nix
    ../../profiles/seed-build-pool.nix
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

  # The Kata shim (and the controller) check that the TPM state tree's
  # .seed-fs sentinel holds this fsid before trusting anything in it.
  seed.tpm.expectedFsid = clusterCeph.fsid;

  assertions = [{
    assertion = lib.length serverNames <= upgradeBuckets;
    message = "seed auto-upgrade: ${toString (lib.length serverNames)} k3s servers but only ${toString upgradeBuckets} upgrade buckets; two servers would upgrade together and could drop etcd quorum. Raise upgradeBuckets in infra/archetypes/seed/base.nix.";
  }];

  system.autoUpgrade = {
    enable = true;
    dates = upgradeTime;
    randomizedDelaySec = "10min";
    fixedRandomDelay = true;
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
