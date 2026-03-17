# Seed web instance — static site backend
#
# Plain HTTP server for loom.farm static content. TLS termination
# is handled by the gateway instance; this just serves files.
{ pkgs, ... }:

{
  seed.size = "xs";
  seed.expose.http = { port = 8080; protocol = "tcp"; };

  services.caddy = {
    enable = true;
    virtualHosts.":8080" = {
      extraConfig = ''
        log {
          output stderr
        }
        root * ${../site}
        file_server
      '';
    };
  };

  networking.firewall.allowedTCPPorts = [ 8080 ];
}
