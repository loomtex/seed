# seed.lib.mkImage — OCI image from a Seed instance
#
# Wraps nix-snapshotter's buildImage to produce an image that boots NixOS
# inside a Kata VM. Uses resolvedByNix = true — nix-snapshotter resolves
# store paths via bind mounts, and the patched kata-runtime propagates them
# through virtiofs into the guest VM via recursive bind mount (MS_BIND|MS_REC).
{ pkgs }:

{ name, toplevel, ... }:

let
  # NixOS init expects FHS mount points. Kata provides the kernel and
  # mounts /proc, /sys, /dev at boot — but the directories must exist
  # in the rootfs for the mount syscalls to succeed.
  rootfs = pkgs.runCommand "seed-rootfs-${name}" {} ''
    mkdir -p $out/{proc,sys,dev,run,tmp,etc,var,nix/store}
    ln -s ${toplevel} $out/run/current-system
  '';

  # Entrypoint wrapper: forks a log streamer that holds the container's
  # stdout fd, then execs NixOS init (→ systemd as PID 1).
  #
  # Why not just background init? systemd requires PID 1 — it refuses to
  # start with "Explicit --user argument required" otherwise.
  #
  # Why a background process instead of a systemd service? NixOS stage 2
  # init redirects stdout to /dev/null before exec'ing systemd. A systemd
  # service has no access to the original container stdout fd. The background
  # process inherits the fd before the redirect and keeps its own copy.
  entrypoint = pkgs.writeShellScript "seed-init" ''
    export PATH=${pkgs.coreutils}/bin:${pkgs.systemd}/bin

    # Log streamer: wait for journald, then stream JSON to container stdout.
    # This process inherits the container's stdout fd and keeps it across
    # the parent's exec into init. systemd adopts it as an orphan.
    (
      echo "SEED-LOG: streamer BASHPID=$BASHPID starting, fd1=$(readlink /proc/self/fd/1 2>/dev/null || echo unknown)"
      for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
        echo "SEED-LOG: tick $i, /run/systemd/journal=$(ls /run/systemd/journal/ 2>&1 || true)"
        if [ -S /run/systemd/journal/stdout ]; then
          echo "SEED-LOG: journald socket found at tick $i, starting stream"
          exec journalctl -f --output=json --no-pager
        fi
        sleep 2
      done
      echo "SEED-LOG: gave up waiting for journald after 60s"
    ) &

    exec ${toplevel}/init
  '';
in pkgs.nix-snapshotter.buildImage {
  name = "seed-${name}";
  resolvedByNix = true;
  copyToRoot = rootfs;
  config.entrypoint = [ "${entrypoint}" ];
}
