# Ceph distributed storage — MON + MGR + OSD per seed node.
#
# Each node runs one of each daemon. OSDs use ceph-volume + dmcrypt
# (LUKS encryption with keys stored in MON KV). Bootstrap is idempotent
# via ConditionPathExists guards on oneshot services.
#
# Requires specialArgs: clusterCeph, nodeCeph (from flake.nix)
{ config, lib, pkgs, clusterCeph, nodeCeph, ... }:

let
  hostname = config.networking.hostName;
  osdId = nodeCeph.osdId;
  osdDevice = nodeCeph.osdDevice;
  ceph = pkgs.ceph;
  # Slash-separated MON addresses for kernel CephFS mount (mon_addr option).
  # Use port 6789 (v1/v2 dual-mode) — the kernel CephFS client auto-negotiates.
  monAddrOption = lib.concatStringsSep "/" (
    map (ip: "${ip}:6789") (lib.splitString "," clusterCeph.monHost)
  );
in {
  services.ceph = {
    enable = true;
    global = {
      fsid = clusterCeph.fsid;
      monHost = clusterCeph.monHost;
      monInitialMembers = clusterCeph.monInitialMembers;
    };

    extraConfig = {
      # In-transit encryption (msgr2 secure mode — AES-128-GCM)
      "ms_cluster_mode" = "secure";
      "ms_service_mode" = "secure";
      "ms_mon_cluster_mode" = "secure";
      "ms_client_mode" = "secure crc";
      # CVE-2021-20288: all our daemons are 19.x, no need for legacy compat
      "auth_allow_insecure_global_id_reclaim" = "false";
    };

    mon = {
      enable = true;
      daemons = [ hostname ];
    };
    mgr = {
      enable = true;
      daemons = [ hostname ];
    };
    osd = {
      enable = true;
      daemons = [ osdId ];
    };
    mds = {
      enable = true;
      daemons = [ hostname ];
    };
  };

  # OSD service override: ceph-volume activation for dmcrypt.
  # dmcrypt OSDs require both OSD ID and OSD FSID for activation.
  # The FSID is generated at prepare time, so we look it up at runtime.
  systemd.services."ceph-osd-${osdId}" = {
    serviceConfig.ExecStartPre = lib.mkForce [
      ("!" + pkgs.writeShellScript "ceph-osd-${osdId}-activate" ''
        OSD_FSID=$(${ceph.out}/bin/ceph-volume lvm list ${osdId} --format json \
          | ${pkgs.jq}/bin/jq -r '."${osdId}"[0].tags["ceph.osd_fsid"]')
        exec ${ceph.out}/bin/ceph-volume lvm activate --bluestore ${osdId} "$OSD_FSID" --no-systemd
      '')
      "${ceph.lib}/libexec/ceph/ceph-osd-prestart.sh --id ${osdId} --cluster ceph"
    ];
    serviceConfig.ExecStopPost = [
      "!${ceph.out}/bin/ceph-volume lvm deactivate ${osdId}"
    ];
    unitConfig.ConditionPathExists = lib.mkForce [];
    path = with pkgs; [ util-linux lvm2 cryptsetup ];
  };

  # --- Bootstrap oneshot services (idempotent) ---

  # 1. Bootstrap MON: create monmap, keyring, mkfs
  systemd.services."ceph-bootstrap-mon" = {
    description = "Bootstrap Ceph MON for ${hostname}";
    wantedBy = [ "ceph-mon-${hostname}.service" ];
    before = [ "ceph-mon-${hostname}.service" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    unitConfig.ConditionPathExists = "!/var/lib/ceph/mon/ceph-${hostname}/keyring";
    script = let
      monKeyFile = config.sops.secrets."ceph/mon-key".path;
      adminKeyFile = config.sops.secrets."ceph/admin-key".path;
      monDir = "/var/lib/ceph/mon/ceph-${hostname}";
    in ''
      set -euo pipefail

      MON_KEY=$(cat ${monKeyFile})
      ADMIN_KEY=$(cat ${adminKeyFile})

      # Create MON keyring with mon + admin keys
      KEYRING=$(mktemp)
      ${ceph.out}/bin/ceph-authtool "$KEYRING" \
        --create-keyring \
        --name mon. \
        --add-key "$MON_KEY" \
        --cap mon 'allow *'

      ${ceph.out}/bin/ceph-authtool "$KEYRING" \
        --name client.admin \
        --add-key "$ADMIN_KEY" \
        --cap mon 'allow *' \
        --cap osd 'allow *' \
        --cap mds 'allow *' \
        --cap mgr 'allow *'

      # Create monmap with all monitors
      MONMAP=$(mktemp)
      ${ceph.out}/bin/monmaptool "$MONMAP" --create --clobber --fsid ${clusterCeph.fsid} \
        ${lib.concatStringsSep " " (lib.mapAttrsToList (name: ip:
          "--addv ${name} [v2:${ip}:3300/0,v1:${ip}:6789/0]"
        ) clusterCeph.monAddrs)}

      # Create mon data directory and mkfs
      install -d -o ceph -g ceph ${monDir}
      ${ceph.out}/bin/ceph-mon --mkfs -i ${hostname} --monmap "$MONMAP" --keyring "$KEYRING"
      chown -R ceph:ceph ${monDir}

      rm -f "$KEYRING" "$MONMAP"
    '';
    path = with pkgs; [ coreutils ];
  };

  # 2. Bootstrap MGR: create mgr keyring (needs running mon)
  systemd.services."ceph-bootstrap-mgr" = {
    description = "Bootstrap Ceph MGR for ${hostname}";
    wantedBy = [ "ceph-mgr-${hostname}.service" ];
    before = [ "ceph-mgr-${hostname}.service" ];
    after = [ "ceph-mon-${hostname}.service" ];
    requires = [ "ceph-mon-${hostname}.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    unitConfig.ConditionPathExists = "!/var/lib/ceph/mgr/ceph-${hostname}/keyring";
    script = let
      mgrDir = "/var/lib/ceph/mgr/ceph-${hostname}";
      adminKeyring = config.sops.templates."ceph-admin-keyring".path;
    in ''
      set -euo pipefail

      # Wait for mon to be in quorum
      for i in $(seq 1 60); do
        if ${ceph.out}/bin/ceph -k ${adminKeyring} mon stat 2>/dev/null | grep -q "quorum"; then
          break
        fi
        echo "Waiting for mon quorum... ($i/60)"
        sleep 2
      done

      install -d -o ceph -g ceph ${mgrDir}
      ${ceph.out}/bin/ceph -k ${adminKeyring} auth get-or-create \
        mgr.${hostname} \
        mon 'allow profile mgr' \
        osd 'allow *' \
        mds 'allow *' \
        -o ${mgrDir}/keyring
      chown -R ceph:ceph ${mgrDir}
    '';
    path = with pkgs; [ coreutils gnugrep ];
  };

  # 3. Bootstrap OSD: prepare encrypted disk (needs running mon for key storage)
  systemd.services."ceph-bootstrap-osd" = {
    description = "Bootstrap Ceph OSD ${osdId} on ${osdDevice}";
    wantedBy = [ "ceph-osd-${osdId}.service" ];
    before = [ "ceph-osd-${osdId}.service" ];
    after = [ "ceph-mon-${hostname}.service" ];
    requires = [ "ceph-mon-${hostname}.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    # Idempotent: skip if LVM VG for this OSD already exists
    script = let
      adminKeyring = config.sops.templates."ceph-admin-keyring".path;
    in ''
      set -euo pipefail

      # Check if ceph-volume already prepared this OSD
      if ${ceph.out}/bin/ceph-volume lvm list ${osdId} 2>/dev/null | grep -q "===="; then
        echo "OSD ${osdId} already prepared, skipping"
        exit 0
      fi

      # Wait for mon to be in quorum
      for i in $(seq 1 60); do
        if ${ceph.out}/bin/ceph -k ${adminKeyring} mon stat 2>/dev/null | grep -q "quorum"; then
          break
        fi
        echo "Waiting for mon quorum... ($i/60)"
        sleep 2
      done

      # Create bootstrap-osd keyring if it doesn't exist
      install -d -o ceph -g ceph /var/lib/ceph/bootstrap-osd
      ${ceph.out}/bin/ceph -k ${adminKeyring} auth get-or-create \
        client.bootstrap-osd \
        mon 'allow profile bootstrap-osd' \
        -o /var/lib/ceph/bootstrap-osd/ceph.keyring || true

      # Prepare OSD with dmcrypt (LUKS key stored in MON KV)
      ${ceph.out}/bin/ceph-volume lvm prepare \
        --bluestore \
        --dmcrypt \
        --data ${osdDevice} \
        --osd-id ${osdId} \
        --no-systemd
    '';
    path = with pkgs; [ util-linux lvm2 cryptsetup coreutils gnugrep ];
  };

  # 4. Bootstrap MDS: create keyring (needs running mon + quorum)
  systemd.services."ceph-bootstrap-mds" = {
    description = "Bootstrap Ceph MDS for ${hostname}";
    wantedBy = [ "ceph-mds-${hostname}.service" ];
    before = [ "ceph-mds-${hostname}.service" ];
    after = [ "ceph-mon-${hostname}.service" ];
    requires = [ "ceph-mon-${hostname}.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    unitConfig.ConditionPathExists = "!/var/lib/ceph/mds/ceph-${hostname}/keyring";
    script = let
      adminKeyring = config.sops.templates."ceph-admin-keyring".path;
      mdsDir = "/var/lib/ceph/mds/ceph-${hostname}";
    in ''
      set -euo pipefail

      # Wait for mon to be in quorum
      for i in $(seq 1 60); do
        if ${ceph.out}/bin/ceph -k ${adminKeyring} mon stat 2>/dev/null | grep -q "quorum"; then
          break
        fi
        echo "Waiting for mon quorum... ($i/60)"
        sleep 2
      done

      install -d -o ceph -g ceph ${mdsDir}
      ${ceph.out}/bin/ceph -k ${adminKeyring} auth get-or-create \
        mds.${hostname} \
        mon 'profile mds' \
        osd 'allow *' \
        mds 'allow' \
        -o ${mdsDir}/keyring
      chown -R ceph:ceph ${mdsDir}
    '';
    path = with pkgs; [ coreutils gnugrep ];
  };

  # 5. Bootstrap CephFS: create pools, filesystem, client auth, and mount
  systemd.services."ceph-bootstrap-cephfs" = {
    description = "Bootstrap CephFS filesystem and mount";
    wantedBy = [ "multi-user.target" ];
    after = [ "ceph-mds-${hostname}.service" ];
    wants = [ "ceph-mds-${hostname}.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = let
      adminKeyring = config.sops.templates."ceph-admin-keyring".path;
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

      # Create pools (idempotent — osd pool create is a no-op if exists)
      ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool create cephfs-metadata 16 || true
      ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool create cephfs-data 32 || true
      ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool application enable cephfs-metadata cephfs || true
      ${ceph.out}/bin/ceph -k ${adminKeyring} osd pool application enable cephfs-data cephfs || true

      # Create filesystem (idempotent)
      ${ceph.out}/bin/ceph -k ${adminKeyring} fs new seed-fs cephfs-metadata cephfs-data 2>/dev/null || true

      # Create/update client auth for host mount
      ${ceph.out}/bin/ceph -k ${adminKeyring} auth get-or-create client.cephfs \
        mon 'allow r' \
        osd 'allow rw pool=cephfs-metadata, allow rw pool=cephfs-data' \
        mds 'allow rw'

      # Get client key for kernel mount
      CEPHFS_SECRET=$(${ceph.out}/bin/ceph -k ${adminKeyring} auth get-key client.cephfs)

      # Mount CephFS (kernel 5.11+ syntax: name@fsid.fsname=/)
      mkdir -p /var/lib/seed-controller/tpm
      if ! mountpoint -q /var/lib/seed-controller/tpm; then
        mount -t ceph cephfs@${clusterCeph.fsid}.seed-fs=/ /var/lib/seed-controller/tpm \
          -o secret="$CEPHFS_SECRET",mon_addr=${monAddrOption}
      fi
    '';
    path = with pkgs; [ coreutils gnugrep util-linux ];
  };

  # CephFS kernel client module
  boot.kernelModules = [ "ceph" ];

  # --- Secrets ---

  sops.secrets."ceph/mon-key" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };
  sops.secrets."ceph/admin-key" = {
    sopsFile = ../secrets/seed-system-atl1.yaml;
  };

  sops.templates."ceph-admin-keyring" = {
    content = ''
      [client.admin]
          key = ${config.sops.placeholder."ceph/admin-key"}
          caps mon = "allow *"
          caps osd = "allow *"
          caps mds = "allow *"
          caps mgr = "allow *"
    '';
    path = "/persist/etc/ceph/ceph.client.admin.keyring";
  };

  # Symlink admin keyring into /etc/ceph/ where ceph tools expect it
  environment.etc."ceph/ceph.client.admin.keyring".source =
    config.sops.templates."ceph-admin-keyring".path;

  # --- Firewall ---

  networking.firewall.allowedTCPPorts = [
    3300  # MON v2 (msgr2)
    6789  # MON v1 (legacy compatibility)
  ];
  networking.firewall.allowedTCPPortRanges = [
    { from = 6800; to = 7300; }  # OSD + MGR
  ];

  # --- k3s ordering: wait for Ceph before starting k3s ---

  systemd.services.k3s = {
    after = [ "ceph.target" ];
    wants = [ "ceph.target" ];
  };
}
