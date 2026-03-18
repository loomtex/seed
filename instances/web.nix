# Seed web instance — static site with platform TLS
#
# Serves loom.farm static content over HTTPS. TLS certificates are
# obtained automatically from the platform ACME endpoint (controller
# proxies DNS-01 to Let's Encrypt). nginx serves static files;
# security.acme (lego) handles cert lifecycle with multi-SAN support.
{ pkgs, ... }:

let
  siteDir = ../site;
  acmeServer = "http://seed-controller.seed-system.svc.cluster.local:9876/acme/directory";
in
{
  seed.size = "xs";
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "http"; };
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };

  security.acme = {
    acceptTerms = true;
    defaults.server = acmeServer;
    defaults.email = "acme@loom.farm";
    # Single cert with both hostnames as SANs
    certs."loom.farm".extraDomainNames = [
      "web.s-gaydazldmnsg.seed.loom.farm"
    ];
  };

  services.nginx = {
    enable = true;
    virtualHosts."loom.farm" = {
      serverAliases = [ "web.s-gaydazldmnsg.seed.loom.farm" ];
      enableACME = true;
      forceSSL = true;
      root = siteDir;
      # Webhook reverse proxy — trailing / strips /_hook/ prefix
      locations."/_hook/" = {
        proxyPass = "http://seed-controller.seed-system.svc.cluster.local:9876/";
      };
    };
  };
}
