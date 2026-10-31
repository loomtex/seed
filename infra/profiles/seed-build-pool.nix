# Cluster-wide Nix build pool.
#
# Every seed node's nix-daemon lists every OTHER node as an ssh-ng remote
# builder, so a big build started anywhere (e.g. the controller's instance
# image builds) fans out over all three machines. Each node also serves its
# store to the others through the restricted `nix-ssh` account.
#
# Pieces:
#   - nix.buildMachines: generated from cluster.nix (clusterNodes), reached
#     over the VPC address so builder traffic stays off the public NIC.
#   - nix.sshServe: `nix-ssh` user whose only possible command is
#     `nix-daemon --stdio` (ForceCommand) and whose key is additionally
#     `restrict`ed and only accepted from the VPC subnets. It is a trusted
#     user, which ssh-ng remote building requires for input-addressed
#     derivations (build-remote sends a BasicDerivation via buildDerivation).
#   - Builder SSH key: one shared keypair; private half in sops
#     (secrets/seed-nodes-atl1.yaml, k3s nodes only), deployed root-only for
#     the nix-daemon's ssh client.
#   - known_hosts: pinned from cluster.nix sshHostKey, keyed by the VPC
#     address used in buildMachines. No TOFU.
#
# The S3 post-build-hook (seed-cache.nix) still runs: on the builder for the
# build it performs, and again on the requesting node after the outputs are
# copied back (a no-op upload for paths already in the cache).
#
# Requires specialArgs: clusterNodes
{ config, lib, clusterNodes, ... }:

let
  vpcData = import ../data/vpc.nix;
  hostName = config.networking.hostName;

  peers = lib.filterAttrs (name: _: name != hostName) clusterNodes;

  builderPublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ/XAVAklMy6L69fFT6SRVchOdda3yALQujo7iXGrS9y nix-builder@seed-atl1";

  # Scheduling. All nodes are identical (Xeon E-2286G, 6C/12T, 31 GB).
  #
  # Local: max-jobs 4 x cores 3 = 12 threads, i.e. one node's worth of CPU
  # when every job is parallel, instead of the old 12 x all-cores (up to 144
  # runnable threads on 12 hardware threads).
  #
  # Remote: each peer accepts 2 jobs from each other node. A node building
  # alone gets 4 local + 2 + 2 remote = 8 concurrent jobs. The worst case on
  # one node (its own 4 plus 2 from each peer) is 8 jobs x 3 cores = 24
  # threads, 2x oversubscription, and only when all three nodes are busy.
  localMaxJobs = 4;
  localCores = 3;
  remoteMaxJobs = 2;
in {
  sops.secrets."seed/builder-ssh-key" = {
    sopsFile = ../secrets/seed-nodes-atl1.yaml;
    owner = "root";
    group = "root";
    mode = "0400";
  };

  nix.distributedBuilds = true;

  nix.buildMachines = lib.mapAttrsToList (_: node: {
    hostName = node.vpcIp;
    protocol = "ssh-ng";
    sshUser = "nix-ssh";
    sshKey = config.sops.secrets."seed/builder-ssh-key".path;
    systems = [ "x86_64-linux" ];
    maxJobs = remoteMaxJobs;
    speedFactor = 1;
    # Matches `nix config show system-features` on the nodes.
    supportedFeatures = [ "benchmark" "big-parallel" "kvm" "nixos-test" ];
  }) peers;

  nix.settings = {
    # Builders pull inputs from the S3 cache instead of from the requester.
    builders-use-substitutes = true;
    max-jobs = localMaxJobs;
    cores = localCores;
  };

  nix.sshServe = {
    enable = true;
    protocol = "ssh-ng";
    write = true;
    trusted = true;
    keys = [
      ''restrict,from="${vpcData.subnet},${vpcData.ipv6Prefix}" ${builderPublicKey}''
    ];
  };

  programs.ssh.knownHosts = lib.mapAttrs' (name: node:
    lib.nameValuePair "nix-builder-${name}" {
      hostNames = [ node.vpcIp ];
      publicKey = node.sshHostKey;
    }
  ) peers;
}
