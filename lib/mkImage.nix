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

  # Entrypoint wrapper: creates a FIFO, starts a cat process that holds
  # the container's stdout fd, then execs NixOS init (→ systemd as PID 1).
  # A systemd service (seed-log, defined in instance-base.nix) writes
  # journalctl --output=json to the FIFO. The cat process forwards it to
  # stdout, which kubectl logs captures.
  #
  # Why not just background init? systemd requires PID 1 — it refuses to
  # start with "Explicit --user argument required" otherwise.
  entrypoint = pkgs.writeShellScript "seed-init" ''
    export PATH=${pkgs.coreutils}/bin

    # FIFO bridge: systemd service → cat → container stdout → kubectl logs
    # Use /dev because /tmp may get a tmpfs overlay from systemd
    mkfifo /dev/seed-log
    cat /dev/seed-log &

    exec ${toplevel}/init
  '';
in pkgs.nix-snapshotter.buildImage {
  name = "seed-${name}";
  resolvedByNix = true;
  copyToRoot = rootfs;
  config.entrypoint = [ "${entrypoint}" ];
}
