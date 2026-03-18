# Seed gateway instance — IPv4 TCP ingress
#
# Shared IPv4 address for the flake. TCP-proxies traffic to backend
# instances via k8s ClusterIP DNS names:
# - HTTP/HTTPS → web instance (web handles its own TLS via platform ACME)
# - DNS TCP/UDP → dns instance
{ pkgs, ... }:

let
  ns = "s-gaydazldmnsg";
  dnsBackend = "dns.${ns}.svc.cluster.local";
  webBackend = "web.${ns}.svc.cluster.local";
in
{
  seed.size = "xs";
  seed.expose.dns = { port = 53; protocol = "dns"; };
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "tcp"; };

  # HTTPS TCP proxy → web instance (web handles its own TLS via platform ACME)
  systemd.services.https-tcp-proxy = {
    description = "TCP proxy for HTTPS to web";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat TCP6-LISTEN:443,fork,reuseaddr TCP:${webBackend}:443";
      Restart = "always";
      RestartSec = "5s";
    };
  };

  # HTTP TCP proxy → web instance
  systemd.services.http-tcp-proxy = {
    description = "TCP proxy for HTTP to web";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.socat}/bin/socat TCP6-LISTEN:80,fork,reuseaddr TCP:${webBackend}:80";
      Restart = "always";
      RestartSec = "5s";
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

  networking.firewall.allowedTCPPorts = [ 53 80 443 ];
  networking.firewall.allowedUDPPorts = [ 53 ];
}
