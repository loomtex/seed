# mkK8sComponent — the "combinable" type for k8s service composition.
#
# Pairs a nix-snapshotter image with a parameterized container spec function.
# A "combinable" is any attrset with { image, imageRef, container }.
#
# Usage:
#   provisioner = mkK8sComponent {
#     name = "csi-provisioner";
#     entrypoint = "${pkgs.csi-provisioner}/bin/csi-provisioner";
#   };
#
#   provisioner.container {
#     args = [ "--csi-address=/csi/csi.sock" "--leader-election=true" ];
#     volumeMounts = [{ name = "socket-dir"; mountPath = "/csi"; }];
#   }
{ pkgs }:

{ name
, entrypoint              # Full path: "${pkg}/bin/foo"
, args ? []
, volumeMounts ? []
, env ? []
, ports ? []
, securityContext ? null
, extraRootfs ? ""        # Extra shell commands for rootfs setup
}:

let
  lib = pkgs.lib;

  # Capture defaults for the container function
  defaults = {
    inherit name args volumeMounts env ports securityContext;
  };

  image = pkgs.nix-snapshotter.buildImage {
    inherit name;
    resolvedByNix = true;
    copyToRoot = pkgs.runCommand "${name}-rootfs" {} ''
      mkdir -p $out/{tmp,nix/store}
      ${extraRootfs}
    '';
    config.entrypoint = [ entrypoint ];
  };
in {
  inherit image name;
  imageRef = "nix:0${image}";

  # container: overrides -> k8s container spec (JSON-serializable attrset)
  # Any field can be overridden; defaults come from the component definition.
  container = overrides:
    let
      merged = defaults // overrides;
    in lib.filterAttrs (_: v: v != null && v != []) {
      inherit (merged) name args volumeMounts env ports securityContext;
      image = "nix:0${image}";
    };
}
