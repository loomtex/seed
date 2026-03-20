{
  description = "Seed multi-instance — web frontend + API backend";

  inputs = {
    seed.url = "github:loomtex/seed";
    nixpkgs.follows = "seed/nixpkgs";
  };

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed { name = "web"; module = ./web.nix; };
    seeds.api = seed.lib.mkSeed { name = "api"; module = ./api.nix; };
  };
}
