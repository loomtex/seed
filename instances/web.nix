# Seed web instance — Caddy reverse proxy + TLS via ACME DNS-01
#
# Serves loom.farm and *.s-gaydazldmnsg.loom.farm with automatic TLS.
# Certs obtained via DNS-01 challenge against the PowerDNS API (seed-dns).
{ config, pkgs, lib, ... }:

{
  seed.size = "s";
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "tcp"; };
  seed.storage.data = "1Gi";

  # sops-nix: decrypt pdns API key using the instance's TPM-backed age identity
  sops.defaultSopsFile = ../secrets/web.yaml;
  sops.secrets.pdns-api-key = {};

  # ACME cert: namespace wildcard + zone apex via DNS-01
  security.acme = {
    acceptTerms = true;
    defaults.email = "hostmaster@loom.farm";
    certs."ns-wildcard" = {
      domain = "*.s-gaydazldmnsg.loom.farm";
      extraDomainNames = [ "loom.farm" ];
      dnsProvider = "pdns";
      credentialsFile = "/run/acme-env/pdns";
      group = "caddy";
      reloadServices = [ "caddy" ];
    };
  };

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
    "d /seed/storage/data/acme 0750 root root -"
  ];

  # Bind-mount PVC acme dir to /var/lib/acme so certs persist across restarts.
  # Can't use a symlink — NixOS acme-setup uses StateDirectory which rejects symlinks.
  # Must run before systemd-tmpfiles-setup (which acme-setup depends on).
  system.activationScripts.acmeMount = {
    deps = [];
    text = ''
      mkdir -p /var/lib/acme
      if ! mountpoint -q /var/lib/acme; then
        mount --bind /seed/storage/data/acme /var/lib/acme
      fi
    '';
  };

  services.caddy = {
    enable = true;
    virtualHosts."loom.farm" = {
      useACMEHost = "ns-wildcard";
      extraConfig = ''
        handle_path /_hook/* {
          reverse_proxy {$SEED_NODE_IP}:9876
        }
        handle {
          root * ${../site}
          file_server
        }
      '';
    };
  };

  # Extract SEED_NODE_IP from PID 1's environment for Caddy.
  # Kata agent sets env vars on the init process (systemd), but systemd
  # doesn't propagate them to activation scripts or services.
  # Read from /proc/1/environ (null-delimited) instead.
  system.activationScripts.seedNodeEnv = {
    deps = [];
    text = ''
      mkdir -p /run/seed
      # Diagnostic: dump env sources to PVC for debugging
      echo "--- shell env ---" > /seed/storage/data/env-debug.txt
      env >> /seed/storage/data/env-debug.txt
      echo "--- /proc/1/environ ---" >> /seed/storage/data/env-debug.txt
      tr '\0' '\n' < /proc/1/environ >> /seed/storage/data/env-debug.txt 2>&1 || true
      tr '\0' '\n' < /proc/1/environ | grep '^SEED_NODE_IP=' > /run/seed/env || echo "SEED_NODE_IP=" > /run/seed/env
    '';
  };

  # Caddy needs certs to exist before starting (useACMEHost = no auto-fetch).
  # On first boot, the ACME service must complete before Caddy can start.
  systemd.services.caddy = {
    after = [ "acme-finished-ns-wildcard.target" ];
    wants = [ "acme-finished-ns-wildcard.target" ];
    serviceConfig.EnvironmentFile = "/run/seed/env";
  };
}
