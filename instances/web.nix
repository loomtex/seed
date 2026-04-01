# Seed web instance — static site with platform TLS
#
# Serves loom.farm static content over HTTPS. TLS certificates are
# obtained automatically from the platform ACME endpoint (controller
# proxies DNS-01 to Let's Encrypt). Caddy handles cert lifecycle natively.
{ pkgs, ... }:

let
  siteDir = ../site;
in
{
  seed.expose.http.enable = true;
  seed.expose.https.enable = true;
  seed.dns.names = [ "loom.farm" "www.loom.farm" ];
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, loom.farm, www.loom.farm {
        root * ${siteDir}
        file_server
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
}
