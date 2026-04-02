# seed.lib.mkInstance — build a Seed instance (Kata VM workload)
#
# Takes a NixOS module and wraps it with the instance base profile + options.
# Returns { toplevel, meta, config, module } for controller consumption.
# The module is preserved so downstream consumers can re-evaluate with overrides.
{ nixpkgs, self }:

let
  derivedNamespace = import ./deriveNamespace.nix { inherit self; };
in

{ name
, module
, namespace ? derivedNamespace
, system ? "x86_64-linux"
, extraModules ? []
}:

let
  eval = nixpkgs.lib.nixosSystem {
    inherit system;
    modules = [
      self.nixosModules.instance-base
      self.nixosModules.instance
      self.nixosModules.postgresql
      self.nixosModules.keycloak
      self.nixosModules.zitadel
      self.nixosModules.sops
      self.nixosModules.ssh-auth
      { networking.hostName = name; }
      { nixpkgs.overlays = [ self.overlays.default ]; }
      module
    ] ++ extraModules
    # Platform-assigned namespace loaded last with mkForce — tenant modules
    # cannot override this. The namespace is derived from .seed-identity
    # (or overridden at the mkSeed call site for grandparented flakes).
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
