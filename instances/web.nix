# Seed web instance — static site with platform TLS
#
# Serves loom.farm static content over HTTPS. TLS certificates are
# obtained automatically from the platform ACME endpoint (controller
# proxies DNS-01 to Let's Encrypt). nginx serves static files;
# security.acme (lego) handles cert lifecycle with multi-SAN support.
{ pkgs, ... }:

let
  siteDir = ../site;
in
{
  seed.expose.http.enable = true;
  seed.expose.https.enable = true;
  seed.dns.names = [ "loom.farm" "www.loom.farm" ];
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };

  services.nginx = {
    enable = true;
    virtualHosts."loom.farm" = {
      serverAliases = [ "web.s-gaydazldmnsg.seed.loom.farm" ];
      enableACME = true;
      forceSSL = true;
      root = siteDir;
      # Webhook reverse proxy — trailing / strips /_hook/ prefix
      locations."/_hook/" = {
        proxyPass = "https://seed-controller.seed-system.svc.cluster.local:9876/";
      };
    };
  };
}
