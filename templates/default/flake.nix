{
  inputs = {
    seed.url = "git+ssh://silo.loom.farm/seed.git";
    nixpkgs.follows = "seed/nixpkgs";
  };

  outputs = { seed, nixpkgs, ... }: {
    nixosConfigurations.default = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        seed.nixosModules.default
        ./configuration.nix
      ];
    };
  };
}
