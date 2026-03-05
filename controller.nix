# Seed controller — reconciles instance definitions into Kata pods
#
# Runs as a systemd service on the seed node. Evaluates the flake,
# builds images, and applies k8s manifests with generation-based reaping.
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.controller;
in {
  options.seed.controller = {
    enable = lib.mkEnableOption "Seed instance controller";

    flakePath = lib.mkOption {
      type = lib.types.str;
      description = "Path to the flake containing seeds.* outputs.";
    };

    interval = lib.mkOption {
      type = lib.types.int;
      default = 30;
      description = "Reconciliation interval in seconds.";
    };

    namespace = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = ''
        Kubernetes namespace for seed resources.
        Empty (default) = auto-derive from flake URI. Set to override for dev/testing.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.seed-controller = {
      description = "Seed instance controller";
      wantedBy = [ "multi-user.target" ];
      after = [ "k3s.service" ];
      wants = [ "k3s.service" ];

      environment = {
        SEED_FLAKE_PATH = cfg.flakePath;
        SEED_INTERVAL = toString cfg.interval;
        KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";
      } // lib.optionalAttrs (cfg.namespace != "") {
        SEED_NAMESPACE = cfg.namespace;
      };

      path = with pkgs; [
        bash
        coreutils  # includes basenc for namespace derivation
        git
        jq
        kubectl
        nix
      ];

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.bash}/bin/bash ${./controller.sh}";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };
  };
}
