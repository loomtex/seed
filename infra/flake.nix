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
      url = "path:..";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.sops-nix.follows = "sops-nix";
    };
  };

  outputs = { self, nixpkgs, nixpkgs-unstable, home-manager, nuketown, disko, impermanence, sops-nix, seed, ... }:
  let
    system = "x86_64-linux";
    lib = nixpkgs.lib;
    pkgs = nixpkgs.legacyPackages.${system};

    clusterData = import ./cluster.nix;

    # Hardware module selection by machine type
    hardwareModule = type: ./archetypes/hardware/vultr-${type}.nix;

    # --- Archetype functions ---

    mkSeedNode = { cluster, name, node }: let
      clusterCeph = {
        inherit (cluster.ceph) fsid;
        monHost = lib.concatStringsSep "," (
          lib.mapAttrsToList (_: n: n.vpcIp) cluster.nodes
        );
        monInitialMembers = lib.concatStringsSep "," (
          lib.attrNames cluster.nodes
        );
        # Map of hostname → VPC IP for monmap creation
        monAddrs = lib.mapAttrs (_: n: n.vpcIp) cluster.nodes;
      };
      nodeCeph = node.ceph or {};
    in lib.nixosSystem {
      inherit system;
      specialArgs = { inherit clusterCeph nodeCeph; clusterNodes = cluster.nodes; seedFlake = seed; };
      modules = [
        disko.nixosModules.disko
        impermanence.nixosModules.impermanence
        sops-nix.nixosModules.sops
        seed.nixosModules.default
        seed.nixosModules.persistence

        (hardwareModule node.type)
        ./archetypes/seed/base.nix

        {
          networking.hostName = name;
          sops.defaultSopsFile = ./secrets/${name}.yaml;
          time.timeZone = cluster.timeZone;
        }
        # Static node IPs from cluster inventory
        (lib.mkIf ((node.vpcIpv6 or "") != "") {
          seed.k3s.nodeIp = "${node.vpcIp},${node.vpcIpv6}";
          seed.k3s.nodeExternalIp = "${node.publicIp},${node.publicIpv6}";
        })
        (lib.mkIf ((node.vpcIpv6 or "") == "" && (node.publicIp or "") != "") {
          seed.k3s.nodeIp = node.vpcIp;
          seed.k3s.nodeExternalIp = node.publicIp;
        })
      ]
      ++ lib.optionals (node.clusterInit or false) [
        { seed.k3s.clusterInit = true; }
      ]
      ++ lib.optionals (node.controller or false) [
        seed.nixosModules.controller
        ./profiles/seed-controller.nix
        ./archetypes/seed/controller.nix
        {
          seed.controller.ipv4Address = cluster.reservedIpv4;
          seed.controller.ipv6Block = cluster.reservedIpv6;
          seed.controller.controllerImage = "${seed.packages.${system}.controllerImage}";
          seed.controller.hostAgentImage = "${seed.packages.${system}.hostAgentImage}";
          seed.controller.poolManager = {
            enable = true;
            poolSize = 4;
            image = "${seed.packages.${system}.poolManagerImage}";
          };
          seed.controller.bgp = {
            enable = true;
            myASN = cluster.bgp.myASN;
            peerASN = cluster.bgp.peerASN;
            password = cluster.bgp.password;
          };
        }
      ];
    };

    mkPuncher = { cluster, name }: lib.nixosSystem {
      inherit system;
      modules = [
        disko.nixosModules.disko
        impermanence.nixosModules.impermanence
        sops-nix.nixosModules.sops

        (hardwareModule cluster.puncher.type)
        ./archetypes/puncher/configuration.nix

        {
          networking.hostName = name;
          sops.defaultSopsFile = ./secrets/${name}.yaml;
          time.timeZone = cluster.timeZone;
          seed.vpcSubnets = [ cluster.vpc.subnet ];
        }
      ];
    };

    mkStake = { cluster }: lib.nixosSystem {
      inherit system;
      modules = [
        sops-nix.nixosModules.sops
        ./archetypes/stake/configuration.nix
        ./profiles/seed-vpc.nix

        {
          networking.hostName = "stake";
          time.timeZone = cluster.timeZone;
          seed.netbootPath = seed.packages.${system}.netboot;
        }
      ];
    };

  in {
    nixosConfigurations = lib.concatMapAttrs (_clusterName: cluster:
      let
        nodes = lib.mapAttrs (name: node:
          mkSeedNode { inherit cluster name node; }
        ) cluster.nodes;

        puncher = {
          ${cluster.puncher.name} = mkPuncher {
            inherit cluster;
            name = cluster.puncher.name;
          };
        };

        stake = {
          "stake" = mkStake { inherit cluster; };
        };
      in nodes // puncher // stake
    ) clusterData.clusters;

    # Expose cluster inventory for nix eval
    cluster = clusterData;

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

      provision-stake = let
        deps = with pkgs; [ openssh curl jq sops age nixos-anywhere nix coreutils gawk ];
        script = pkgs.writeShellScript "seed-provision-stake" ''
          export PATH="${pkgs.lib.makeBinPath deps}:$PATH"
          exec ${pkgs.bash}/bin/bash ${./helpers/provision-stake.sh} "$@"
        '';
      in {
        type = "app";
        program = "${script}";
      };
    };

    # Devshell with all tooling
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        nixos-anywhere sops age ssh-to-age jq git
        curl clevis jose yq-go vultr-cli
        nodejs # TypeScript controller tests (node --import tsx/esm --test)
      ];
    };
  };
}
