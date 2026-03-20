{ pkgs, ... }:

let
  # Replace this with your application
  app = pkgs.writeShellScript "app" ''
    while true; do
      echo -e "HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nHello from Seed!" | \
        ${pkgs.busybox}/bin/nc -l -p 3000 -q 0
    done
  '';
in {
  seed.expose.https.enable = true;
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  # Caddy handles TLS automatically via the platform ACME endpoint.
  # {$SEED_ACME_URL} and {$SEED_FQDN} are Caddy env var syntax, not nix.
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN} {
        reverse_proxy localhost:3000
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";

  systemd.services.app = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = app;
    serviceConfig.Restart = "always";
  };
}
