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
    #
    # trap: systemd sends SIGTERM to stray processes on startup — ignore it.
    # TERM=dumb: prevent journalctl from adding ANSI color codes to JSON.
    #
    # Diagnostics: write lifecycle trace to /run/seed-log-debug so we can
    # check the file after boot to understand failures (the file persists
    # even when stdout is broken).
    # Save container stdout as fd 3 before anything can close it.
    # The background streamer writes to fd 3, not fd 1 — this survives
    # even if NixOS init or systemd manipulates fd 1.
    exec 3>&1

    (
      trap "" TERM HUP PIPE
      echo "streamer:started pid=$BASHPID" >&3
      echo "streamer:fd1=$(readlink /proc/self/fd/1 2>/dev/null)" >&3
      echo "streamer:fd3=$(readlink /proc/self/fd/3 2>/dev/null)" >&3
      while [ ! -S /run/systemd/journal/stdout ]; do sleep 1; done
      echo "streamer:socket-found" >&3
      TERM=dumb journalctl -f --output=json --no-pager >&3
    ) &

    exec ${toplevel}/init
  '';
in pkgs.nix-snapshotter.buildImage {
  name = "seed-${name}";
  resolvedByNix = true;
  copyToRoot = rootfs;
  config.entrypoint = [ "${entrypoint}" ];
}
