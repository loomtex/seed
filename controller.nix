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

  # Per-request handler script: stdin=request, stdout=response (invoked by ncat --sh-exec)
  webhookHandler = pkgs.writeShellScript "seed-webhook-handler" ''
    SECRET_FILE="${cfg.webhook.secretFile}"
    TRIGGER="${stateDir}/refresh"

    # Load HMAC secret
    HMAC_SECRET=""
    if [ -n "$SECRET_FILE" ] && [ -f "$SECRET_FILE" ]; then
      HMAC_SECRET=$(cat "$SECRET_FILE" | tr -d '\n')
    fi

    # Read request line
    read -r method path _
    method=$(echo "$method" | tr -d '\r')
    path=$(echo "$path" | tr -d '\r')

    # Read headers
    content_length=0
    signature=""
    while IFS= read -r header; do
      header=$(echo "$header" | tr -d '\r')
      [ -z "$header" ] && break
      case "$header" in
        Content-Length:\ *|content-length:\ *)
          content_length=''${header#*: }
          ;;
        X-Hub-Signature-256:\ *|x-hub-signature-256:\ *)
          signature=''${header#*: }
          ;;
      esac
    done

    if [ "$method" != "POST" ] || [ "$path" != "/refresh" ]; then
      [ "$content_length" -gt 0 ] 2>/dev/null && head -c "$content_length" >/dev/null
      printf "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
      exit 0
    fi

    # Read body
    body=""
    if [ "$content_length" -gt 0 ] 2>/dev/null; then
      body=$(head -c "$content_length")
    fi

    # Verify HMAC-SHA256 signature
    if [ -n "$HMAC_SECRET" ]; then
      if [ -z "$signature" ]; then
        echo "[seed-webhook] $(date -Iseconds) rejected: missing signature" >&2
        printf "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        exit 0
      fi

      expected="sha256=$(echo -n "$body" | ${pkgs.openssl}/bin/openssl dgst -sha256 -hmac "$HMAC_SECRET" -hex 2>/dev/null | sed 's/^.* //')"
      if [ "$expected" != "$signature" ]; then
        echo "[seed-webhook] $(date -Iseconds) rejected: invalid signature" >&2
        printf "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        exit 0
      fi
    fi

    touch "$TRIGGER"
    echo "[seed-webhook] $(date -Iseconds) refresh triggered" >&2
    printf "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 16\r\nConnection: close\r\n\r\n{\"status\":\"ok\"}\n"
  '';

  webhookScript = pkgs.writeShellScript "seed-webhook" ''
    echo "[seed-webhook] $(date -Iseconds) listening on ${cfg.webhook.address}:${toString cfg.webhook.port}"
    while true; do
      ${pkgs.nmap}/bin/ncat -l -p ${toString cfg.webhook.port} \
        ${lib.optionalString (cfg.webhook.address != "0.0.0.0") "--allow ${cfg.webhook.address}"} \
        --sh-exec ${webhookHandler} 2>&1
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

    ipv4Address = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Reserved IPv4 address for public LoadBalancer services.";
    };

    ipv6Block = lib.mkOption {
      type = lib.types.str;
      default = "";
      description = "Reserved IPv6 /64 block for public LoadBalancer services (e.g. 2001:db8::/64).";
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

      secretFile = lib.mkOption {
        type = lib.types.str;
        default = "";
        description = ''
          Path to file containing the HMAC-SHA256 secret for GitHub webhook verification.
          Empty = no authentication (accept all requests).
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
      } // lib.optionalAttrs (cfg.ipv4Address != "") {
        SEED_IPV4_ADDRESS = cfg.ipv4Address;
      } // lib.optionalAttrs (cfg.ipv6Block != "") {
        SEED_IPV6_BLOCK = cfg.ipv6Block;
      };

      path = with pkgs; [
        bash
        coreutils  # includes basenc for namespace derivation
        git
        jq
        kubectl
        nix
        swtpm
      ];

      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.bash}/bin/bash ${./controller.sh}";
        StateDirectory = "seed-controller";
        Restart = "on-failure";
        RestartSec = 10;
      };
    };

    # Allow pods to reach the webhook listener (pod CIDR → host port)
    networking.firewall.extraCommands = lib.mkIf cfg.webhook.enable ''
      iptables -A nixos-fw -p tcp -s 10.42.0.0/16 --dport ${toString cfg.webhook.port} -j nixos-fw-accept
    '';

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
