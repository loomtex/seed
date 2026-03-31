# Seed instance persistence — impermanence-style bind mounts from PVC to rootfs
#
# Instances are ephemeral: the rootfs is rebuilt from the nix closure on every
# pod restart. Only paths declared here survive restarts, backed by the PVC
# that seed.storage provides.
#
# Patterned on nix-community/impermanence but stripped to what Kata VMs need:
# just bind mounts via activation scripts. No initrd, no neededForBoot, no
# assertions about fileSystems.
#
# Usage:
#   seed.storage.data = "1Gi";
#   seed.persist."/seed/storage/data" = {
#     directories = [ "/var/lib/pdns" "/var/lib/private" ];
#     files = [ "/etc/machine-id" ];
#   };
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.persist;

  # Submodule for each persist root (one per PVC mount)
  persistModule = lib.types.submodule ({ name, ... }: {
    options = {
      directories = lib.mkOption {
        type = lib.types.listOf (lib.types.either lib.types.str
          (lib.types.submodule {
            options = {
              directory = lib.mkOption { type = lib.types.str; };
              user = lib.mkOption { type = lib.types.str; default = "root"; };
              group = lib.mkOption { type = lib.types.str; default = "root"; };
              mode = lib.mkOption { type = lib.types.str; default = "0755"; };
            };
          }));
        default = [];
        description = "Directories to persist. Strings or attrsets with ownership.";
      };

      files = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [];
        description = "Files to persist (bind-mounted individually).";
      };
    };
  });

  # Normalize a directory entry to an attrset
  normalizeDir = d:
    if builtins.isString d then { directory = d; user = "root"; group = "root"; mode = "0755"; }
    else d;

  # All persist roots and their entries
  allRoots = lib.mapAttrsToList (persistRoot: entries: {
    inherit persistRoot;
    directories = map normalizeDir entries.directories;
    files = entries.files;
  }) cfg;

  # Activation script that creates backing dirs/files and bind-mounts them
  mountScript = pkgs.writeShellScript "seed-persist-mounts" ''
    ${lib.concatMapStringsSep "\n" (root: ''
      # Persist root: ${root.persistRoot}
      ${lib.concatMapStringsSep "\n" (d: ''
        # Directory: ${d.directory}
        backing="${root.persistRoot}${d.directory}"
        target="${d.directory}"
        mkdir -p "$backing"
        chown ${d.user}:${d.group} "$backing"
        chmod ${d.mode} "$backing"
        mkdir -p "$target"
        ${pkgs.util-linux}/bin/mount -o bind "$backing" "$target"
      '') root.directories}
      ${lib.concatMapStringsSep "\n" (f: ''
        # File: ${f}
        backing="${root.persistRoot}${f}"
        target="${f}"
        mkdir -p "$(dirname "$backing")"
        [ -f "$backing" ] || touch "$backing"
        mkdir -p "$(dirname "$target")"
        [ -f "$target" ] || touch "$target"
        ${pkgs.util-linux}/bin/mount -o bind "$backing" "$target"
      '') root.files}
    '') allRoots}
  '';

in {
  options.seed.persist = lib.mkOption {
    type = lib.types.attrsOf persistModule;
    default = {};
    description = ''
      Impermanence-style persistence for seed instances. Keys are PVC mount
      paths (e.g. "/seed/storage/data"), values declare which directories and
      files should be bind-mounted from that PVC into the rootfs.
    '';
  };

  config = lib.mkIf (cfg != {}) {
    # Run bind mounts during activation, before systemd services start.
    # This runs after the PVC is already mounted by k8s/Kata.
    system.activationScripts.seedPersist = {
      deps = [ "specialfs" "users" "groups" ];
      text = "${mountScript}";
    };

    # Ensure sops-nix secrets are set up after persist bind mounts are in place,
    # so secrets can be written into persisted directories if needed.
    system.activationScripts.setupSecrets.deps = [ "seedPersist" ];
  };
}
