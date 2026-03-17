# Seed gateway instance — TLS termination, DNS proxy, IPv4 ingress
#
# Single point of ingress for the flake. Handles:
# - TLS termination via Caddy (ACME DNS-01 certs)
# - Reverse proxy to web (static site), silo (cgit), controller (webhook)
# - DNS TCP/UDP forwarding to the dns instance
# - SSH TCP forwarding to the silo instance
#
# All IPv4 and IPv6 ingress routes point here. Backend services are
# reached via k8s ClusterIP DNS names over plain HTTP/TCP.
{ config, pkgs, lib, ... }:

let
  ns = "s-gaydazldmnsg";
  dnsBackend = "seed-dns.${ns}.svc.cluster.local";
  webBackend = "seed-web.${ns}.svc.cluster.local";
  siloBackend = "seed-silo.${ns}.svc.cluster.local";
  controllerBackend = "seed-controller.seed-system.svc.cluster.local";

  certDir = "/var/lib/acme/ns-wildcard";
  legoDir = "/var/lib/acme/.lego";
  certFile = "${legoDir}/certificates/_.${ns}.loom.farm.crt";
  keyFile = "${legoDir}/certificates/_.${ns}.loom.farm.key";
in
{
  seed.size = "s";
  seed.expose.dns = { port = 53; protocol = "dns"; };
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "tcp"; };
  seed.expose.ssh = { port = 22; protocol = "tcp"; };
  seed.storage.data = "1Gi";

  # sops-nix: decrypt pdns API key for ACME DNS-01 challenge
  sops.defaultSopsFile = ../secrets/gateway.yaml;
  sops.secrets.pdns-api-key = {};

  # ACME credentials from sops secret
  system.activationScripts.acmeEnv = {
    deps = [ "setupSecrets" ];
    text = ''
      mkdir -p /run/acme-env
      echo "PDNS_API_URL=http://${dnsBackend}:8081" > /run/acme-env/pdns
      echo "PDNS_API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})" >> /run/acme-env/pdns
      chmod 0400 /run/acme-env/pdns
    '';
  };

  systemd.tmpfiles.rules = [
    "d /seed/storage/data/acme 0755 root root -"
  ];

  # Bind-mount PVC acme dir to /var/lib/acme so certs persist.
  # Bootstrap with self-signed cert so Caddy starts before ACME completes.
  system.activationScripts.acmeMount = {
    deps = [];
    text = ''
      mkdir -p /var/lib/acme
      if ! mountpoint -q /var/lib/acme; then
        mount --bind /seed/storage/data/acme /var/lib/acme
      fi

      mkdir -p ${certDir}
      if [ ! -f "${certDir}/fullchain.pem" ]; then
        ${pkgs.openssl}/bin/openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
          -keyout "${certDir}/key.pem" -out "${certDir}/fullchain.pem" \
          -days 1 -nodes -subj "/CN=self-signed" 2>/dev/null
        chgrp caddy "${certDir}/fullchain.pem" "${certDir}/key.pem"
        chmod 640 "${certDir}/fullchain.pem" "${certDir}/key.pem"
      fi
    '';
  };

  # ACME cert service (eventual consistency, independent of Caddy)
  systemd.services.seed-acme = {
    description = "ACME certificate (DNS-01 via pdns)";
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];
    wantedBy = [ "multi-user.target" ];

    path = [ pkgs.lego pkgs.openssl ];

    serviceConfig = {
      Type = "oneshot";
      EnvironmentFile = "/run/acme-env/pdns";
      Restart = "on-failure";
      RestartSec = "60s";
    };

    script = ''
      set -euo pipefail

      mkdir -p "${certDir}" "${legoDir}"

      if [ -f "${certDir}/fullchain.pem" ]; then
        ISSUER=$(openssl x509 -in "${certDir}/fullchain.pem" -issuer -noout 2>/dev/null || true)
        if ! echo "$ISSUER" | grep -qi "self-signed\|minica"; then
          if openssl x509 -in "${certDir}/fullchain.pem" -checkend 2592000 -noout 2>/dev/null; then
            echo "Certificate valid and not expiring within 30 days"
            exit 0
          fi
        fi
      fi

      LEGO_ARGS=(
        --accept-tos
        --path "${legoDir}"
        --email "hostmaster@loom.farm"
        --dns pdns
        --server "https://acme-v02.api.letsencrypt.org/directory"
        --key-type ec256
        -d "*.${ns}.loom.farm"
        -d "loom.farm"
        -d "silo.loom.farm"
        -d "seed.loom.farm"
      )

      if [ -f "${certFile}" ]; then
        echo "Renewing certificate"
        lego "''${LEGO_ARGS[@]}" renew --days 30
      else
        echo "Requesting new certificate"
        lego "''${LEGO_ARGS[@]}" run
      fi

      cp "${certFile}" "${certDir}/fullchain.pem"
      cp "${keyFile}" "${certDir}/key.pem"
      chgrp caddy "${certDir}/fullchain.pem" "${certDir}/key.pem"
      chmod 640 "${certDir}/fullchain.pem" "${certDir}/key.pem"

      systemctl reload caddy 2>/dev/null || true
      echo "Certificate installed successfully"
    '';
  };

  systemd.timers.seed-acme = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      RandomizedDelaySec = "1h";
      Persistent = true;
    };
  };

  # Caddy: TLS termination + reverse proxy to backends over plain HTTP
  services.caddy = {
    enable = true;
    virtualHosts."loom.farm" = {
      extraConfig = ''
        tls ${certDir}/fullchain.pem ${certDir}/key.pem
        log {
          output stderr
        }
        handle_path /_hook/* {
          reverse_proxy ${controllerBackend}:9876
        }
        handle {
          reverse_proxy https://${webBackend}:443 {
            transport http {
              tls_insecure_skip_verify
            }
          }
        }
      '';
    };
    virtualHosts."silo.loom.farm" = {
      extraConfig = ''
        tls ${certDir}/fullchain.pem ${certDir}/key.pem
        log {
          output stderr
        }
        reverse_proxy ${siloBackend}:8080
      '';
    };
  };

  # DNS TCP proxy
  systemd.services.dns-tcp-proxy = {
    description = "TCP proxy for DNS";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat TCP6-LISTEN:53,fork,reuseaddr TCP:${dnsBackend}:53";
      Restart = "always";
      RestartSec = "5s";
    };
  };

  # DNS UDP proxy
  systemd.services.dns-udp-proxy = {
    description = "UDP proxy for DNS";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat UDP6-LISTEN:53,fork,reuseaddr UDP:${dnsBackend}:53";
      Restart = "always";
      RestartSec = "5s";
    };
  };

  # SSH TCP proxy to silo
  systemd.services.silo-ssh-proxy = {
    description = "TCP proxy for silo SSH";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat TCP6-LISTEN:22,fork,reuseaddr TCP:${siloBackend}:22";
      Restart = "always";
      RestartSec = "5s";
    };
  };

  networking.firewall.allowedTCPPorts = [ 53 80 443 22 ];
  networking.firewall.allowedUDPPorts = [ 53 ];
}
