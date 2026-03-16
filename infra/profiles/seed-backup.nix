# Ceph backup to S3 — encrypted pool snapshots on a timer.
#
# Backs up all Ceph storage (RBD images, CephFS filesystems) to S3
# using age encryption. Import on a single node (the backup leader).
#
# RBD: per-image snapshots + incremental export-diff → age → S3
# CephFS: filesystem snapshot → tar → age → S3
#
# Flexible: discovers pools/images automatically, handles any number of
# RBD pools and CephFS filesystems. Blacklist pools you don't want backed up.
{ config, lib, pkgs, ... }:

let
  cfg = config.combine.backup;

  ceph = pkgs.ceph;
  age = pkgs.age;

  awsCreds = config.sops.templates."seed-s3-credentials".path;

  backupScript = pkgs.writeShellScript "seed-backup" ''
    set -euo pipefail

    export AWS_SHARED_CREDENTIALS_FILE="${awsCreds}"
    export AWS_EC2_METADATA_DISABLED=true
    export PATH="${lib.makeBinPath [ ceph age pkgs.gnutar pkgs.minio-client pkgs.coreutils pkgs.gzip pkgs.util-linux pkgs.getent ]}:$PATH"

    BUCKET="${cfg.bucket}"
    ENDPOINT="${cfg.endpoint}"
    TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
    AGE_RECIPIENTS="${lib.concatStringsSep " " (map (r: "-r ${r}") cfg.recipients)}"
    BLACKLIST="${lib.concatStringsSep " " cfg.blacklistPools}"
    STATE_DIR="/persist/seed-backup"
    export MC_CONFIG_DIR="$STATE_DIR/mc"
    MC_ALIAS="seed-s3"

    mkdir -p "$STATE_DIR"

    # Configure mc alias from AWS credentials file
    ACCESS_KEY=$(grep aws_access_key_id "$AWS_SHARED_CREDENTIALS_FILE" | cut -d= -f2 | tr -d ' ')
    SECRET_KEY=$(grep aws_secret_access_key "$AWS_SHARED_CREDENTIALS_FILE" | cut -d= -f2 | tr -d ' ')
    mc alias set "$MC_ALIAS" "https://$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" --api S3v4 >/dev/null

    log() { echo "[$(date -u +%H:%M:%S)] $*"; }

    s3_put() {
      local src="$1" key="$2"
      mc cp --quiet "$src" "$MC_ALIAS/$BUCKET/$key"
    }

    is_blacklisted() {
      local pool="$1"
      for bl in $BLACKLIST; do
        [ "$pool" = "$bl" ] && return 0
      done
      return 1
    }

    # --- RBD backup ---
    # Enumerate all RBD pools, then all images in each pool.
    # For each image: create snapshot, export-diff from last snapshot, encrypt, upload.

    backup_rbd() {
      local pool="$1"
      local images
      images=$(rbd ls "$pool" 2>/dev/null) || return 0

      for image in $images; do
        local snap_name="backup-$TIMESTAMP"
        local last_snap_file="$STATE_DIR/rbd-''${pool}-''${image}-last-snap"
        local last_snap=""

        if [ -f "$last_snap_file" ]; then
          last_snap=$(cat "$last_snap_file")
        fi

        # Create new snapshot
        log "RBD $pool/$image: creating snapshot $snap_name"
        rbd snap create "$pool/$image@$snap_name"

        # Export (incremental if we have a previous snapshot)
        local tmp_export
        tmp_export=$(mktemp)

        if [ -n "$last_snap" ] && rbd snap ls "$pool/$image" | grep -q "$last_snap"; then
          log "RBD $pool/$image: incremental export from $last_snap"
          rbd export-diff --from-snap "$last_snap" "$pool/$image@$snap_name" - \
            | age -e $AGE_RECIPIENTS -o "$tmp_export"
          s3_put "$tmp_export" "backup/rbd/$pool/$image/$TIMESTAMP.incremental.age"
        else
          log "RBD $pool/$image: full export"
          rbd export-diff "$pool/$image@$snap_name" - \
            | age -e $AGE_RECIPIENTS -o "$tmp_export"
          s3_put "$tmp_export" "backup/rbd/$pool/$image/$TIMESTAMP.full.age"
        fi

        rm -f "$tmp_export"

        # Clean up old snapshot (keep only current)
        if [ -n "$last_snap" ] && [ "$last_snap" != "$snap_name" ]; then
          rbd snap rm "$pool/$image@$last_snap" 2>/dev/null || true
        fi

        # Record current snapshot for next incremental
        echo "$snap_name" > "$last_snap_file"
        log "RBD $pool/$image: done"
      done
    }

    # --- CephFS backup ---
    # For each CephFS filesystem: create snapshot, tar, encrypt, upload.

    backup_cephfs() {
      local fs_name="$1" mount_path="$2"
      local snap_name="backup-$TIMESTAMP"

      log "CephFS $fs_name: creating snapshot $snap_name"
      mkdir -p "$mount_path/.snap/$snap_name"

      local tmp_export
      tmp_export=$(mktemp)

      log "CephFS $fs_name: tar + encrypt snapshot"
      tar -C "$mount_path/.snap/$snap_name" -cf - . \
        | gzip \
        | age -e $AGE_RECIPIENTS -o "$tmp_export"

      s3_put "$tmp_export" "backup/cephfs/$fs_name/$TIMESTAMP.tar.gz.age"
      rm -f "$tmp_export"

      # Clean up old snapshots (keep last N)
      local keep=${toString cfg.retainSnapshots}
      local snaps
      snaps=$(ls -1d "$mount_path/.snap/backup-"* 2>/dev/null | sort | head -n -"$keep") || true
      for old in $snaps; do
        log "CephFS $fs_name: removing old snapshot $(basename "$old")"
        rmdir "$old" 2>/dev/null || true
      done

      log "CephFS $fs_name: done"
    }

    # --- Main ---

    log "=== Seed backup starting ==="

    # Discover and back up RBD pools
    ALL_POOLS=$(ceph osd pool ls 2>/dev/null) || { log "ERROR: cannot list pools"; exit 1; }
    for pool in $ALL_POOLS; do
      if is_blacklisted "$pool"; then
        log "Skipping blacklisted pool: $pool"
        continue
      fi

      # Check if this pool has RBD images (application = rbd)
      POOL_APP=$(ceph osd pool application get "$pool" 2>/dev/null || echo "")
      if echo "$POOL_APP" | grep -q '"rbd"'; then
        backup_rbd "$pool"
      fi
    done

    # Back up CephFS filesystems
    ${lib.concatMapStringsSep "\n" (fs: ''
      backup_cephfs "${fs.name}" "${fs.mountPoint}"
    '') cfg.cephfs}

    log "=== Backup complete ==="
  '';

in {
  options.combine.backup = {
    enable = lib.mkEnableOption "Ceph backup to S3";

    bucket = lib.mkOption {
      type = lib.types.str;
      description = "S3 bucket name for backups";
    };

    endpoint = lib.mkOption {
      type = lib.types.str;
      default = "atl2.vultrobjects.com";
      description = "S3 endpoint URL";
    };

    recipients = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      description = "age public keys for encrypting backups";
    };

    blacklistPools = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ".mgr" ];
      description = "Ceph pools to exclude from backup";
    };

    cephfs = lib.mkOption {
      type = lib.types.listOf (lib.types.submodule {
        options = {
          name = lib.mkOption { type = lib.types.str; };
          mountPoint = lib.mkOption { type = lib.types.str; };
        };
      });
      default = [];
      description = "CephFS filesystems to back up (name + mount point)";
    };

    schedule = lib.mkOption {
      type = lib.types.str;
      default = "daily";
      description = "systemd calendar expression for backup schedule";
    };

    retainSnapshots = lib.mkOption {
      type = lib.types.int;
      default = 7;
      description = "Number of CephFS snapshots and RBD incremental chains to retain on-cluster";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.seed-backup = {
      description = "Ceph backup to S3 (encrypted)";
      after = [ "ceph.target" "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [ ceph age pkgs.gnutar pkgs.minio-client pkgs.coreutils pkgs.gzip pkgs.util-linux pkgs.getent ];
      serviceConfig = {
        Type = "oneshot";
        ExecStart = backupScript;
        TimeoutStartSec = "2h";
      };
    };

    systemd.timers.seed-backup = {
      description = "Ceph backup timer";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.schedule;
        Persistent = true;
        RandomizedDelaySec = "15min";
      };
    };
  };
}
