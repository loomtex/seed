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

  # Entrypoint wrapper: starts NixOS init (which execs systemd) in the
  # background, then streams the journal as JSON to stdout. This makes
  # all systemd service logs visible via kubectl logs and shippable to
  # log aggregators. Without this, only NixOS stage 2 boot messages
  # appear — systemd captures everything else into its internal journal.
  entrypoint = pkgs.writeShellScript "seed-init" ''
    export PATH=${pkgs.coreutils}/bin:${pkgs.systemd}/bin

    ${toplevel}/init &
    SYSD_PID=$!

    # Forward SIGTERM to systemd for graceful shutdown
    trap "kill $SYSD_PID 2>/dev/null; wait $SYSD_PID 2>/dev/null; exit 0" TERM INT

    # Wait for journald to be ready
    while [ ! -e /run/systemd/journal/stdout ]; do sleep 0.5; done

    # Stream structured journal to stdout (kubectl logs / log aggregator)
    journalctl -f --output=json --no-pager &

    # Wait for systemd — if it exits, the container should stop
    wait $SYSD_PID
  '';
in pkgs.nix-snapshotter.buildImage {
  name = "seed-${name}";
  resolvedByNix = true;
  copyToRoot = rootfs;
  config.entrypoint = [ "${entrypoint}" ];
}
