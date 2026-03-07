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
      echo "PDNS_API_URL=http://seed-dns:8081" > /run/acme-env/pdns
      echo "PDNS_API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})" >> /run/acme-env/pdns
      chmod 0400 /run/acme-env/pdns
    '';
  };

  # Persist ACME certs on PVC + create www dir
  systemd.tmpfiles.rules = [
    "d /seed/storage/data/www 0755 root root -"
    "d /seed/storage/data/acme 0750 acme caddy -"
    "L+ /var/lib/acme - - - - /seed/storage/data/acme"
  ];

  services.caddy = {
    enable = true;
    virtualHosts."loom.farm" = {
      useACMEHost = "ns-wildcard";
      extraConfig = ''
        root * /seed/storage/data/www
        file_server
      '';
    };
  };
}
