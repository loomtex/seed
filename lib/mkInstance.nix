# seed.lib.mkInstance — build a Seed instance (Kata VM workload)
#
# Takes a NixOS module and wraps it with the instance base profile + options.
# Returns { toplevel, meta, config, module } for controller consumption.
# The module is preserved so downstream consumers can re-evaluate with overrides.
{ nixpkgs, seed }:

{ name
, module
, self ? null
, namespace ? if self != null then import ./deriveNamespace.nix { inherit self; } else null
, system ? "x86_64-linux"
, extraModules ? []
}:

let
  eval = nixpkgs.lib.nixosSystem {
    inherit system;
    modules = [
      seed.nixosModules.instance-base
      seed.nixosModules.instance
      seed.nixosModules.postgresql
      seed.nixosModules.keycloak
      seed.nixosModules.zitadel
      seed.nixosModules.sops
      seed.nixosModules.ssh-auth
      { networking.hostName = name; }
      { nixpkgs.overlays = [ seed.overlays.default ]; }
      module
    ] ++ extraModules
    # Platform-assigned namespace loaded last with mkForce — tenant modules
    # cannot override this. It comes from the caller's .seed-identity when the
    # caller passes its flake's self (or from the mkSeed call site for
    # grandparented flakes). Without either it stays null: the seed flake's own
    # identity says nothing about a tenant, and the controller rejects metadata
    # naming any namespace but the assigned one.
    ++ (if namespace != null then [
      { seed.namespace = nixpkgs.lib.mkForce namespace; }
    ] else []);
  };
in {
  toplevel = eval.config.system.build.toplevel;
  meta = eval.config.seed.meta // { inherit name system; };
  config = eval.config;
  inherit module;
}
