# Ceph RBD CSI driver — enables PVC provisioning from the Ceph pool.
#
# Three concerns:
#   1. Bootstrap: create k8s-rbd pool + client.k8s user (idempotent oneshot)
#   2. Host config: rbd kernel module
#   3. k8s manifests: CSI driver + provisioner + nodeplugin via seed.k8s.services
#
# The Ceph auth key is pre-generated and stored in sops. The bootstrap service
# creates the Ceph user with that key, and the k8s Secret gets the same key
# via sops.templates. No manual coordination needed.
#
# Requires specialArgs: clusterCeph, clusterNodes, seedFlake
{ config, lib, pkgs, clusterCeph, clusterNodes, seedFlake, ... }:

let
  mkK8sComponent = seedFlake.lib.mkK8sComponent pkgs;
  mkCephCsiRbd = seedFlake.lib.mkCephCsiRbd { inherit pkgs mkK8sComponent; };

  ceph = pkgs.ceph;
  hostname = config.networking.hostName;
  adminKeyring = config.sops.templates."ceph-admin-keyring".path;

  csiRbd = mkCephCsiRbd {
    monitors = lib.mapAttrsToList (_: n: "${n.vpcIp}:6789") clusterNodes;
    fsid = clusterCeph.fsid;
    secretKey = config.sops.placeholder."ceph/csi-k8s-key";
  };
in {
  sops.secrets."ceph/csi-k8s-key" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };

  sops.templates."ceph-csi-rbd-secret.json" = {
    content = csiRbd.secretManifestJSON;
  };

  boot.kernelModules = csiRbd.hostConfig.kernelModules;

  # --- Bootstrap: create Ceph pool + CSI user (idempotent) ---
  systemd.services."ceph-bootstrap-csi" = {
    description = "Bootstrap Ceph RBD pool and CSI client user";
    wantedBy = [ "multi-user.target" ];
    after = [ "ceph-mon-${hostname}.service" ];
    requires = [ "ceph-mon-${hostname}.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = let
      csiKeyFile = config.sops.secrets."ceph/csi-k8s-key".path;
    in ''
      set -euo pipefail

      # Wait for mon quorum
      for i in $(seq 1 60); do
        if ${ceph.out}/bin/ceph -k ${adminKeyring} mon stat 2>/dev/null | grep -q "quorum"; then
          break
        fi
        echo "Waiting for mon quorum... ($i/60)"
        sleep 2
      done

      # Create pool (idempotent — no-op if exists)
      if ! ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool stats k8s-rbd &>/dev/null; then
        echo "Creating k8s-rbd pool..."
        ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool create k8s-rbd 32
        ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool set k8s-rbd size 3
        ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool set k8s-rbd min_size 2
        ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool application enable k8s-rbd rbd
        ${ceph.out}/bin/rbd -k ${adminKeyring} --id admin pool init k8s-rbd
      else
        echo "Pool k8s-rbd already exists"
      fi

      # Create CSI user with pre-generated key from sops.
      # ceph auth import replaces get-or-create because --key authenticates
      # the client, not the new user. Import a keyring with our key instead.
      if ! ${ceph.out}/bin/ceph -k ${adminKeyring} auth get client.k8s &>/dev/null; then
        echo "Creating client.k8s with sops-managed key..."
        CSI_KEY=$(cat ${csiKeyFile})
        TMPKR=$(mktemp)
        ${ceph.out}/bin/ceph-authtool "$TMPKR" \
          --create-keyring \
          --name client.k8s \
          --add-key "$CSI_KEY" \
          --cap mon 'profile rbd' \
          --cap osd 'profile rbd pool=k8s-rbd' \
          --cap mgr 'profile rbd pool=k8s-rbd'
        ${ceph.out}/bin/ceph -k ${adminKeyring} auth import -i "$TMPKR"
        rm -f "$TMPKR"
      else
        echo "client.k8s already exists"
      fi

      echo "Ceph CSI bootstrap complete"
    '';
    path = with pkgs; [ coreutils gnugrep ];
  };

  seed.k8s.services.ceph-csi = {
    manifests = csiRbd.manifests;
    extraManifestPaths = [
      config.sops.templates."ceph-csi-rbd-secret.json".path
    ];
  };
}
