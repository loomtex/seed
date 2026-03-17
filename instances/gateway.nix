# Seed gateway instance — HAProxy IPv4 ingress
#
# Single point of IPv4 ingress for the flake. Proxies to backend
# seed instances (dns, web) based on port. This allows the IPv4
# LoadBalancer service to use externalTrafficPolicy: Local, preserving
# client source IPs through to the backends.
#
# Backend services are reached via k8s ClusterIP DNS names.
{ pkgs, ... }:

let
  ns = "s-gaydazldmnsg";
  dnsBackend = "seed-dns.${ns}.svc.cluster.local";
  webBackend = "seed-web.${ns}.svc.cluster.local";
in
{
  seed.size = "xs";
  seed.expose.dns = { port = 53; protocol = "dns"; };
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "tcp"; };

  services.haproxy = {
    enable = true;
    config = ''
      global
        log stdout format raw local0 info

      defaults
        log global
        timeout connect 5s
        timeout client 30s
        timeout server 30s

      # --- DNS (TCP) ---

      frontend ft_dns_tcp
        bind *:53
        mode tcp
        default_backend bk_dns_tcp

      backend bk_dns_tcp
        mode tcp
        server dns ${dnsBackend}:53

      # --- HTTP/HTTPS (TCP passthrough) ---

      frontend ft_http
        bind *:80
        mode tcp
        default_backend bk_http

      backend bk_http
        mode tcp
        server web ${webBackend}:80

      frontend ft_https
        bind *:443
        mode tcp
        default_backend bk_https

      backend bk_https
        mode tcp
        server web ${webBackend}:443
    '';
  };

  # DNS UDP proxy — HAProxy doesn't support general UDP proxying
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
