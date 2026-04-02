{
  description = "Seed instance — API server with encrypted secrets";

  inputs = {
    seed.url = "github:loomtex/seed";
    nixpkgs.follows = "seed/nixpkgs";
    sops-nix.follows = "seed/sops-nix";
  };

  outputs = { seed, ... }: {
    seeds.api = seed.lib.mkSeed {
      name = "api";
      module = ./api.nix;
    };
  };
}
