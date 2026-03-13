{
  description = "Seed infrastructure — self-contained cluster management";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-25.11";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    disko = {
      url = "github:nix-community/disko/latest";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    impermanence.url = "github:nix-community/impermanence";
    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nuketown = {
      url = "github:joshperry/nuketown/cloud-design";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
      inputs.impermanence.follows = "impermanence";
    };
    seed = {
      url = "github:loomtex/seed";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.sops-nix.follows = "sops-nix";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, home-manager, nuketown, disko, impermanence, sops-nix, seed, ... }:
  let
    system = "x86_64-linux";
    pkgs = nixpkgs.legacyPackages.${system};

    cluster = import ./cluster.nix;

    mkMachine = name: path: extraModules: nixpkgs.lib.nixosSystem {
      inherit system;
      modules = [
        disko.nixosModules.disko
        impermanence.nixosModules.impermanence
        sops-nix.nixosModules.sops
        (path + "/configuration.nix")
      ] ++ extraModules;
    };

    # ATL nodes get full seed module stack
    mkSeedNode = name: path: extraModules: mkMachine name path ([
      seed.nixosModules.default
      seed.nixosModules.persistence
    ] ++ extraModules);
  in {
    nixosConfigurations = {
      # --- Infrastructure machines ---

      seed-stake = mkMachine "seed-stake" ./machines/infra/seed-stake [
        ./machines/infra/seed-stake/disks.nix
        ./profiles/seed-cache.nix
        ./profiles/seed-vpc.nix
        {
          seed.netbootPath = seed.packages.${system}.netboot;
          sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
        }
      ];

      seed-puncher-1 = mkMachine "seed-puncher-1" ./machines/infra/seed-puncher-1 [
        { seed.vpcSubnets = [ "10.0.0.0/24" ]; }
      ];

      seed-tang-1 = mkMachine "seed-tang-1" ./machines/infra/seed-tang-1 [
        { seed.netbootPath = seed.packages.${system}.netboot; }
      ];

      # --- ATL cluster nodes ---

      seed-atl-1 = mkSeedNode "seed-atl-1" ./machines/atl/seed-atl-1 [
        seed.nixosModules.controller
        {
          seed.controller.controllerImage = "${seed.packages.${system}.controllerImage}";
          seed.controller.hostAgentImage = "${seed.packages.${system}.hostAgentImage}";
          seed.controller.poolManager = {
            enable = true;
            poolSize = 4;
            image = "${seed.packages.${system}.poolManagerImage}";
          };
        }
      ];

      seed-atl-2 = mkSeedNode "seed-atl-2" ./machines/atl/seed-atl-2 [];

      seed-atl-3 = mkSeedNode "seed-atl-3" ./machines/atl/seed-atl-3 [];
    };

    # Expose cluster inventory for nix eval
    inherit cluster;

    # Helper scripts as flake apps
    apps.${system} = {
      vultr = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "seed-vultr";
          runtimeInputs = with pkgs; [ curl jq ];
          text = builtins.readFile ./helpers/vultr.sh;
        }}/bin/seed-vultr";
      };

      sops-enroll = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "seed-sops-enroll";
          runtimeInputs = with pkgs; [ ssh-to-age sops age yq-go ];
          text = builtins.readFile ./helpers/sops-enroll.sh;
        }}/bin/seed-sops-enroll";
      };

      clevis-bind = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "seed-clevis-bind";
          runtimeInputs = with pkgs; [ clevis curl jose ];
          text = builtins.readFile ./helpers/clevis-bind.sh;
        }}/bin/seed-clevis-bind";
      };

      observe = {
        type = "app";
        program = "${pkgs.writeShellApplication {
          name = "seed-observe";
          runtimeInputs = with pkgs; [ openssh tmux ];
          text = builtins.readFile ./helpers/observe.sh;
        }}/bin/seed-observe";
      };
    };

    # Devshell with all tooling
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        nixos-anywhere sops age ssh-to-age jq git
        curl clevis jose yq-go vultr-cli
      ];
    };
  };
}
