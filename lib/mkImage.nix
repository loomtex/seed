# seed.lib.mkImage — OCI image from a Seed instance
#
# Wraps nix-snapshotter's buildImage to produce an image that boots NixOS
# inside a Kata VM. Uses resolvedByNix so nix-snapshotter bind-mounts store
# paths at runtime — the image itself is tiny (just FHS scaffolding).
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
in pkgs.nix-snapshotter.buildImage {
  name = "seed-${name}";
  resolvedByNix = true;
  copyToRoot = rootfs;
  config.entrypoint = [ "${toplevel}/init" ];
}
