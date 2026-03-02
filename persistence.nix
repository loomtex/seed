# Impermanence integration for Seed
# Import this module alongside impermanence to persist /var/lib/rancher
{ config, lib, ... }:

let
  cfg = config.seed;
in {
  config = lib.mkIf (cfg.enable && cfg.persistence.enable) {
    environment.persistence.${cfg.persistence.path}.directories = [
      "/var/lib/rancher"
    ];
  };
}
