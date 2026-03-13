# Seed web instance — Caddy reverse proxy + TLS via ACME DNS-01
#
# Serves loom.farm and *.s-gaydazldmnsg.loom.farm with automatic TLS.
# Certs obtained via DNS-01 challenge against the PowerDNS API (seed-dns).
#
# ACME is eventually consistent: on first boot, a self-signed cert is
# generated so Caddy starts immediately. seed-acme retries every 60s
# until it gets a real cert from Let's Encrypt, then reloads Caddy.
{ config, pkgs, lib, ... }:

let
  certDir = "/var/lib/acme/ns-wildcard";
  legoDir = "/var/lib/acme/.lego";
  certFile = "${legoDir}/certificates/_.s-gaydazldmnsg.loom.farm.crt";
  keyFile = "${legoDir}/certificates/_.s-gaydazldmnsg.loom.farm.key";
in
{
  seed.size = "s";
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "tcp"; };
  seed.expose.ssh = { port = 22; protocol = "tcp"; };
  seed.storage.data = "1Gi";

  # sops-nix: decrypt pdns API key using the instance's TPM-backed age identity
  sops.defaultSopsFile = ../secrets/web.yaml;
  sops.secrets.pdns-api-key = {};

  # Create ACME credentials file from sops secret
  system.activationScripts.acmeEnv = {
    deps = [ "setupSecrets" ];
    text = ''
      mkdir -p /run/acme-env
      echo "PDNS_API_URL=http://seed-dns.s-gaydazldmnsg.svc.cluster.local:8081" > /run/acme-env/pdns
      echo "PDNS_API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})" >> /run/acme-env/pdns
      chmod 0400 /run/acme-env/pdns
    '';
  };

  systemd.tmpfiles.rules = [
    "d /seed/storage/data/acme 0755 root root -"
  ];

  # Bind-mount PVC acme dir to /var/lib/acme so certs persist across restarts.
  # Then generate a self-signed cert if none exists, so Caddy can start immediately.
  system.activationScripts.acmeMount = {
    deps = [];
    text = ''
      mkdir -p /var/lib/acme
      if ! mountpoint -q /var/lib/acme; then
        mount --bind /seed/storage/data/acme /var/lib/acme
      fi

      # Bootstrap: generate self-signed cert so Caddy can start before ACME completes
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

  # ACME cert service with retry (eventual consistency).
  # Runs independently of Caddy — does not block Caddy startup.
  # On failure (e.g. dns instance not ready yet), systemd retries every 60s.
  # On success, reloads Caddy and stays stopped until the daily timer fires.
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

      # If we already have a valid CA-signed cert not expiring within 30 days, skip
      if [ -f "${certDir}/fullchain.pem" ]; then
        ISSUER=$(openssl x509 -in "${certDir}/fullchain.pem" -issuer -noout 2>/dev/null || true)
        if ! echo "$ISSUER" | grep -qi "self-signed\|minica"; then
          if openssl x509 -in "${certDir}/fullchain.pem" -checkend 2592000 -noout 2>/dev/null; then
            echo "Certificate valid and not expiring within 30 days"
            exit 0
          fi
        fi
      fi

      # Request or renew ACME cert
      LEGO_ARGS=(
        --accept-tos
        --path "${legoDir}"
        --email "hostmaster@loom.farm"
        --dns pdns
        --server "https://acme-v02.api.letsencrypt.org/directory"
        --key-type ec256
        -d "*.s-gaydazldmnsg.loom.farm"
        -d "loom.farm"
        -d "silo.loom.farm"
        -d "seed.loom.farm"  # temporary: dodge LE duplicate cert rate limit
      )

      if [ -f "${certFile}" ]; then
        echo "Renewing certificate"
        lego "''${LEGO_ARGS[@]}" renew --days 30
      else
        echo "Requesting new certificate"
        lego "''${LEGO_ARGS[@]}" run
      fi

      # Install cert files where Caddy reads them
      cp "${certFile}" "${certDir}/fullchain.pem"
      cp "${keyFile}" "${certDir}/key.pem"
      chgrp caddy "${certDir}/fullchain.pem" "${certDir}/key.pem"
      chmod 640 "${certDir}/fullchain.pem" "${certDir}/key.pem"

      # Reload Caddy to pick up new cert
      systemctl reload caddy 2>/dev/null || true

      echo "Certificate installed successfully"
    '';
  };

  # Daily renewal check
  systemd.timers.seed-acme = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      RandomizedDelaySec = "1h";
      Persistent = true;
    };
  };

  services.caddy = {
    enable = true;
    virtualHosts."loom.farm" = {
      extraConfig = ''
        tls ${certDir}/fullchain.pem ${certDir}/key.pem
        handle_path /_hook/* {
          reverse_proxy seed-controller.seed-system.svc.cluster.local:9876
        }
        handle {
          root * ${../site}
          file_server
        }
      '';
    };
    virtualHosts."silo.loom.farm" = {
      extraConfig = ''
        tls ${certDir}/fullchain.pem ${certDir}/key.pem
        reverse_proxy seed-silo.s-gaydazldmnsg.svc.cluster.local:8080
      '';
    };
  };

  # socat TCP proxy: forward port 22 to silo pod SSH
  systemd.services.silo-ssh-proxy = {
    description = "TCP proxy for silo SSH";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat TCP6-LISTEN:22,fork,reuseaddr TCP:seed-silo.s-gaydazldmnsg.svc.cluster.local:22";
      Restart = "always";
      RestartSec = "5s";
    };
  };

  networking.firewall.allowedTCPPorts = [ 80 443 22 ];
}
