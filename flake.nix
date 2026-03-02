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
  in {
    # Overlay: fix kata-runtime CLH paths (upstream bug — package builds QEMU
    # config but CLH config points to non-existent binary in kata-runtime store path)
    overlays.default = final: prev: {
      kata-runtime = prev.kata-runtime.overrideAttrs (old: {
        postInstall = (old.postInstall or "") + ''
          sed -i \
            -e 's!path = ".*cloud-hypervisor"!path = "${final.cloud-hypervisor}/bin/cloud-hypervisor"!' \
            -e 's!valid_hypervisor_paths = \[".*cloud-hypervisor"\]!valid_hypervisor_paths = ["${final.cloud-hypervisor}/bin/cloud-hypervisor"]!' \
            "$out/share/defaults/kata-containers/configuration-clh.toml"
        '';
      });
    };

    # NixOS module: one import gives you k3s + nix-snapshotter + Kata/CLH
    nixosModules = {
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
    };

    # Re-export nix-snapshotter home modules for rootless k3s consumers
    homeModules = nix-snapshotter.homeModules;

    # Test VM: boots k3s + Kata, requires KVM on host
    nixosConfigurations.vm = nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        self.nixosModules.default
        ./vm.nix
      ];
    };

    apps.${system}.vm = {
      type = "app";
      program = "${self.nixosConfigurations.vm.config.system.build.vm}/bin/run-nixos-vm";
    };

    templates.default = {
      path = ./templates/default;
      description = "Seed compute node — k3s + nix-snapshotter + Kata/CLH";
    };
  };
}
