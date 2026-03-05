# Seed controller — reconciles instance definitions into Kata pods
#
# Runs as a systemd service on the seed node. Evaluates the flake,
# builds images, and applies k8s manifests with generation-based reaping.
#
# Optional webhook: listens for HTTP POSTs to trigger immediate
# cache-busting reconciliation (e.g. from GitHub push webhooks).
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.controller;
  stateDir = "/var/lib/seed-controller";

  webhookScript = pkgs.writeShellScript "seed-webhook" ''
    LISTEN="${cfg.webhook.address}:${toString cfg.webhook.port}"
    SECRET="${cfg.webhook.secret}"
    TRIGGER="${stateDir}/refresh"

    log() { echo "[seed-webhook] $(date -Iseconds) $*"; }

    handle_request() {
      local method path auth_ok

      # Read request line
      read -r method path _
      method=$(echo "$method" | tr -d '\r')
      path=$(echo "$path" | tr -d '\r')

      # Read headers
      auth_ok=0
      while IFS= read -r header; do
        header=$(echo "$header" | tr -d '\r')
        [ -z "$header" ] && break
        if [ -n "$SECRET" ]; then
          case "$header" in
            Authorization:\ Bearer\ "$SECRET") auth_ok=1 ;;
          esac
        else
          auth_ok=1
        fi
      done

      # Drain body
      cat >/dev/null &
      DRAIN_PID=$!
      sleep 0.1
      kill $DRAIN_PID 2>/dev/null

      if [ "$method" != "POST" ] || [ "$path" != "/refresh" ]; then
        printf "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        return
      fi

      if [ "$auth_ok" -ne 1 ]; then
        printf "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        return
      fi

      touch "$TRIGGER"
      log "refresh triggered"
      printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}\n"
    }

    log "listening on $LISTEN"
    while true; do
      handle_request < <(${pkgs.nmap}/bin/ncat -l -p ${toString cfg.webhook.port} ${lib.optionalString (cfg.webhook.address != "0.0.0.0") "--allow ${cfg.webhook.address}"} 2>/dev/null)
    done
  '';
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

    webhook = {
      enable = lib.mkEnableOption "Seed webhook for cache-busting reconciliation";

      port = lib.mkOption {
        type = lib.types.port;
        default = 9876;
        description = "Port for the webhook HTTP listener.";
      };

      address = lib.mkOption {
        type = lib.types.str;
        default = "0.0.0.0";
        description = "Address to bind the webhook listener.";
      };

      secret = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          Bearer token for webhook authentication.
          Empty = no authentication (use only behind a firewall).
        '';
      };
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
        SEED_REFRESH_TRIGGER = "${stateDir}/refresh";
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
        StateDirectory = "seed-controller";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };

    systemd.services.seed-webhook = lib.mkIf cfg.webhook.enable {
      description = "Seed webhook — triggers cache-busting reconciliation";
      wantedBy = [ "multi-user.target" ];
      after = [ "seed-controller.service" ];

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.bash}/bin/bash ${webhookScript}";
        StateDirectory = "seed-controller";
        Restart = "on-failure";
        RestartSec = 5;
      };
    };
  };
}
