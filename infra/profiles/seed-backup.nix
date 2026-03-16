# Ceph backup to S3 — encrypted full exports on a timer.
#
# Backs up all Ceph storage (RBD images, CephFS filesystems) to S3
# using age encryption. Import on a single node (the backup leader).
#
# RBD: full export → zstd → age → S3 (no incremental chain to manage)
# CephFS: tar → zstd → age → S3
#
# Flexible: discovers RBD pools/images automatically, handles any number of
# pools and CephFS filesystems. Blacklist pools you don't want backed up.
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

    BUCKET="${cfg.bucket}"
    ENDPOINT="${cfg.endpoint}"
    TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
    AGE_RECIPIENTS="${lib.concatStringsSep " " (map (r: "-r ${r}") cfg.recipients)}"
    BLACKLIST="${lib.concatStringsSep " " cfg.blacklistPools}"
    STATE_DIR="/persist/seed-backup"
    export MC_CONFIG_DIR="$STATE_DIR/mc"
    MC_ALIAS="seed-s3"
    RETAIN=${toString cfg.retainSnapshots}

    mkdir -p "$STATE_DIR"

    # Configure mc alias from AWS credentials file
    ACCESS_KEY=$(grep aws_access_key_id "$AWS_SHARED_CREDENTIALS_FILE" | cut -d= -f2 | tr -d ' ')
    SECRET_KEY=$(grep aws_secret_access_key "$AWS_SHARED_CREDENTIALS_FILE" | cut -d= -f2 | tr -d ' ')
    mc alias set "$MC_ALIAS" "https://$ENDPOINT" "$ACCESS_KEY" "$SECRET_KEY" --api S3v4 >/dev/null

    log() { echo "[$(date -u +%H:%M:%S)] $*"; }

    s3_put() {
      local src="$1" key="$2"
      mc cp "$src" "$MC_ALIAS/$BUCKET/$key"
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
    # Full export each image: rbd export → age → S3.

    backup_rbd() {
      local pool="$1"
      local images
      images=$(rbd ls "$pool" 2>/dev/null) || return 0

      for image in $images; do
        log "RBD $pool/$image: full export"

        local tmp_export
        tmp_export=$(mktemp)

        rbd export "$pool/$image" - \
          | zstd -T0 \
          | age -e $AGE_RECIPIENTS -o "$tmp_export"

        s3_put "$tmp_export" "backup/rbd/$pool/$image/$TIMESTAMP.zst.age"
        rm -f "$tmp_export"

        log "RBD $pool/$image: done"
      done
    }

    # --- CephFS backup ---
    # Tar the mount point, compress, encrypt, upload.

    backup_cephfs() {
      local fs_name="$1" mount_path="$2"

      log "CephFS $fs_name: tar + compress + encrypt"

      local tmp_export
      tmp_export=$(mktemp)

      # Grab flock on each instance's .lock file during tar to ensure
      # consistent swtpm NVRAM state (swtpm uses flock for write serialization).
      local lock_fds=()
      local lock_fd=10
      for lockfile in "$mount_path"/*/.lock; do
        [ -f "$lockfile" ] || continue
        eval "exec ''${lock_fd}<$lockfile"
        flock -s "$lock_fd"
        lock_fds+=("$lock_fd")
        lock_fd=$((lock_fd + 1))
      done

      tar -C "$mount_path" -cf - . \
        | zstd -T0 \
        | age -e $AGE_RECIPIENTS -o "$tmp_export"

      # Release locks
      for fd in "''${lock_fds[@]}"; do
        eval "exec ''${fd}<&-"
      done

      s3_put "$tmp_export" "backup/cephfs/$fs_name/$TIMESTAMP.tar.zst.age"
      rm -f "$tmp_export"

      log "CephFS $fs_name: done"
    }

    # --- Prune old backups from S3 ---

    prune_prefix() {
      local prefix="$1"
      local objects
      objects=$(mc ls "$MC_ALIAS/$BUCKET/$prefix" 2>/dev/null \
        | awk '{print $NF}' | sort) || return 0

      local count
      count=$(echo "$objects" | wc -l)
      if [ "$count" -le "$RETAIN" ]; then
        return 0
      fi

      local to_delete
      to_delete=$(echo "$objects" | head -n -"$RETAIN")
      for obj in $to_delete; do
        log "Pruning $prefix$obj"
        mc rm "$MC_ALIAS/$BUCKET/$prefix$obj" >/dev/null 2>&1 || true
      done
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

        # Prune old backups for each image
        images=$(rbd ls "$pool" 2>/dev/null) || true
        for image in $images; do
          prune_prefix "backup/rbd/$pool/$image/"
        done
      fi
    done

    # Back up CephFS filesystems
    ${lib.concatMapStringsSep "\n" (fs: ''
      backup_cephfs "${fs.name}" "${fs.mountPoint}"
      prune_prefix "backup/cephfs/${fs.name}/"
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
      description = "Number of backups to retain in S3 per image/filesystem";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.seed-backup = {
      description = "Ceph backup to S3 (encrypted)";
      after = [ "ceph.target" "network-online.target" ];
      wants = [ "network-online.target" ];
      path = [ ceph age pkgs.gnutar pkgs.minio-client pkgs.coreutils pkgs.zstd pkgs.util-linux pkgs.getent pkgs.gawk ];
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
