# seed.lib.mkInstance — build a Seed instance (Kata VM workload)
#
# Takes a NixOS module and wraps it with the instance base profile + options.
# Returns { toplevel, meta, config, module } for controller consumption.
# The module is preserved so downstream consumers can re-evaluate with overrides.
{ nixpkgs, self }:

{ name
, module
, system ? "x86_64-linux"
, extraModules ? []
}:

let
  eval = nixpkgs.lib.nixosSystem {
    inherit system;
    modules = [
      self.nixosModules.instance-base
      self.nixosModules.instance
      { networking.hostName = name; }
      module
    ] ++ extraModules;
  };
in {
  toplevel = eval.config.system.build.toplevel;
  meta = eval.config.seed.meta // { inherit name system; };
  config = eval.config;
  inherit module;
}
