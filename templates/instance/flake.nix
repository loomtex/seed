{
  description = "Seed instance — NixOS workload running in a Kata VM";

  inputs = {
    seed.url = "git+ssh://silo.loom.farm/seed.git";
    nixpkgs.follows = "seed/nixpkgs";
  };

  outputs = { seed, ... }: {
    seeds.web = seed.lib.mkSeed {
      name = "web";
      module = ./web.nix;
    };
  };
}
