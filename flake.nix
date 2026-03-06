{
  description = "The Vercel for Nix derivations — VM-isolated compute on k3s + Kata Containers";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    nix-snapshotter = {
      url = "github:joshperry/nix-snapshotter/k3s-1.34-support";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, nix-snapshotter, ... }:
  let
    system = "x86_64-linux";
    pkgs = import nixpkgs {
      inherit system;
      overlays = [
        nix-snapshotter.overlays.default
        self.overlays.default
      ];
    };

    mkInstance = import ./lib/mkInstance.nix { inherit nixpkgs self; };
    mkImage = import ./lib/mkImage.nix { inherit pkgs; };
  in {
    # Overlay: patch kata-runtime for nix-snapshotter + CLH paths
    overlays.default = final: prev: {
      kata-runtime = prev.kata-runtime.overrideAttrs (old: {
        # Patch kata shim to support multi-mount rootfs from snapshotters
        # like nix-snapshotter that return overlay + bind mounts:
        # 1. Populate rootFs metadata from first mount even with multiple mounts
        # 2. Copy Mount.Target field for subdirectory bind mount resolution
        # 3. Use recursive bind (MS_BIND|MS_REC) so sub-mounts propagate
        #    through virtiofs into the guest VM
        patches = (old.patches or []) ++ [
          ./patches/kata-multi-mount-rootfs.patch
        ];

        # Fix CLH paths (upstream bug — package builds QEMU config but CLH
        # config points to non-existent binary in kata-runtime store path)
        postInstall = (old.postInstall or "") + ''
          sed -i \
            -e 's!path = ".*cloud-hypervisor"!path = "${final.cloud-hypervisor}/bin/cloud-hypervisor"!' \
            -e 's!valid_hypervisor_paths = \[".*cloud-hypervisor"\]!valid_hypervisor_paths = ["${final.cloud-hypervisor}/bin/cloud-hypervisor"]!' \
            "$out/share/defaults/kata-containers/configuration-clh.toml"
        '';
      });
    };

    # NixOS modules
    nixosModules = {
      # Node-level: k3s + nix-snapshotter + Kata/CLH
      default = {
        imports = [
          nix-snapshotter.nixosModules.default
          ./module.nix
        ];
        nixpkgs.overlays = [
          nix-snapshotter.overlays.default
          self.overlays.default
        ];
      };

      # Import alongside impermanence to auto-persist /var/lib/rancher
      persistence = ./persistence.nix;

      # Instance-level: seed.size, seed.expose, seed.storage, seed.connect
      instance = ./instance.nix;

      # Stripped NixOS profile for Kata VM guests
      instance-base = ./instance-base.nix;

      # Controller: reconciles instance definitions into Kata pods
      controller = ./controller.nix;
    };

    # Helpers: build Seed instances and images
    lib.mkInstance = mkInstance;
    lib.mkImage = mkImage;

    # Re-export nix-snapshotter home modules for rootless k3s consumers
    homeModules = nix-snapshotter.homeModules;

    # Test VM: boots k3s + Kata + controller, requires KVM on host
    nixosConfigurations.vm = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        self.nixosModules.default
        self.nixosModules.controller
        ./vm.nix
      ];
    };

    apps.${system}.vm = {
      type = "app";
      program = "${self.nixosConfigurations.vm.config.system.build.vm}/bin/run-nixos-vm";
    };

    # Dogfooding: seed's own instances (initially a web example for testing)
    seeds = let
      instances = {
        web = mkInstance {
          name = "web";
          module = ./templates/instance/web.nix;
        };
        dns = mkInstance {
          name = "dns";
          module = ./instances/dns.nix;
        };
      };
    in builtins.mapAttrs (name: instance:
      instance // {
        image = mkImage { inherit name; inherit (instance) toplevel; };
      }
    ) instances;

    # IPv4 route block — maps external ports on a shared reserved IP to instances
    ipv4 = {
      enable = true;
      routes = {
        dns = { port = 53; protocol = "dns"; instance = "dns"; };
      };
    };

    # Automated tests (run with: nix flake check)
    checks.${system} = {
      # Tests metadata eval + image build (no KVM needed)
      image = import ./tests/image.nix { inherit self pkgs nixpkgs; };
    };

    templates = {
      default = {
        path = ./templates/default;
        description = "Seed compute node — k3s + nix-snapshotter + Kata/CLH";
      };

      instance = {
        path = ./templates/instance;
        description = "Seed instance — NixOS workload running in a Kata VM";
      };
    };
  };
}
