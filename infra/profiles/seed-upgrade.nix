# Node upgrades: the host side of the seed upgrade agent.
#
# - seed-upgrade.service: oneshot that builds this host from the infra flake
#   and applies it (switch, or boot when the kernel/initrd/modules changed),
#   writing /run/seed-upgrade/state. Never reboots. Started on demand by the
#   upgrade agent in the host-agent DaemonSet (src/host-agent/upgrade.ts),
#   which owns the seed-system/node-upgrade Lease, cordon, drain, reboot and
#   health gate.
# - system.autoUpgrade: the old per-node timer, kept while
#   seed.upgradeAgent.mode = "dry-run"; disabled in "active" mode.
#
# The round-robin schedule below is mirrored by the agent
# (src/host-agent/upgrade-schedule.ts), which computes it from the k8s Node
# list (control-plane nodes first). Keep the two in sync.
{ config, pkgs, lib, clusterNodes, ... }:

let
  mode = config.seed.upgradeAgent.mode;
  flakeRepo = "loomtex/seed";
  flakeDir = "infra";

  # Auto-upgrade schedule: round-robin into a fixed set of 30-minute buckets
  # from 04:00, so adding a node never means picking a slot by hand.
  #
  # k3s servers are ordered first and must each get their own bucket: an
  # upgrade can restart k3s (e.g. a containerd config change), and two servers
  # restarting together would drop etcd below quorum. Other nodes (k3sRole =
  # "agent") fill the buckets round-robin after them. A small fixed per-host
  # jitter keeps nodes sharing a bucket from hitting GitHub and the cache at
  # the same second. (In active mode the Lease serializes upgrades anyway.)
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

  seedUpgrade = pkgs.writeShellApplication {
    name = "seed-upgrade";
    runtimeInputs = with pkgs; [
      coreutils gnugrep jq gnutar xz.bin gzip gitMinimal
      config.nix.package.out
      config.programs.ssh.package
      config.system.build.nixos-rebuild
    ];
    runtimeEnv = {
      SEED_UPGRADE_REPO = flakeRepo;
      SEED_UPGRADE_DIR = flakeDir;
      SEED_UPGRADE_HOST = config.networking.hostName;
    };
    text = builtins.readFile ./seed-upgrade.sh;
  };
in
{
  assertions = [{
    assertion = lib.length serverNames <= upgradeBuckets;
    message = "seed auto-upgrade: ${toString (lib.length serverNames)} k3s servers but only ${toString upgradeBuckets} upgrade buckets; two servers would upgrade together and could drop etcd quorum. Raise upgradeBuckets in infra/profiles/seed-upgrade.nix (and UPGRADE_BUCKETS in src/host-agent/upgrade-schedule.ts).";
  }];

  system.autoUpgrade = {
    enable = mode == "dry-run";
    dates = upgradeTime;
    randomizedDelaySec = "10min";
    fixedRandomDelay = true;
    flake = "github:${flakeRepo}?dir=${flakeDir}";
    allowReboot = false;
  };

  systemd.services.seed-upgrade = {
    description = "Seed node upgrade (build + switch/boot, started by the upgrade agent)";
    # Like nixos-upgrade.service: a switch must not restart or stop the unit
    # that is running it.
    restartIfChanged = false;
    unitConfig.X-StopOnRemoval = false;
    environment = config.nix.envVars // {
      inherit (config.environment.sessionVariables) NIX_PATH;
      HOME = "/root";
    } // config.networking.proxy.envVars;
    serviceConfig = {
      Type = "oneshot";
      ExecStart = lib.getExe seedUpgrade;
      TimeoutStartSec = "2h";
    };
  };
}
