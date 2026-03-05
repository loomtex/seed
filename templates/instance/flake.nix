{
  description = "Seed instance — NixOS workload running in a Kata VM";

  inputs = {
    seed.url = "github:loomtex/seed";
    nixpkgs.follows = "seed/nixpkgs";
  };

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkInstance {
      name = "web";
      module = ./web.nix;
    };
  };
}
