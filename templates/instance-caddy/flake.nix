{
  description = "Seed instance — Caddy reverse proxy with automatic TLS and custom domain";

  inputs = {
    seed.url = "github:loomtex/seed";
    nixpkgs.follows = "seed/nixpkgs";
  };

  outputs = { seed, ... }: {
    # Register a custom domain. The platform handles NameSilo registration,
    # NS delegation, zone creation in PowerDNS, and AAAA record management.
    # Set register = false if you already own the domain and will point
    # NS records at ns1.loom.farm / ns2.loom.farm manually.
    combine.domains = {
      "example.com" = {
        register = true;   # auto-register via NameSilo
        default = true;    # default domain for unqualified DNS names
      };
    };

    seeds.web = seed.lib.mkSeed {
      name = "web";
      module = ./web.nix;
    };
  };
}
