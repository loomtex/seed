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

  # Custom DNS names — AAAA records created automatically.
  # Must match a domain declared in combine.domains in flake.nix.
  seed.dns.names = [ "example.com" "www.example.com" ];

  # Caddy handles TLS automatically via the platform ACME endpoint.
  # {$SEED_ACME_URL} and {$SEED_FQDN} are Caddy env var syntax, not nix.
  # SEED_FQDN is the auto-generated name (<instance>.<namespace>.seed.loom.farm).
  # Add your custom domains as additional site addresses.
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, example.com, www.example.com {
        reverse_proxy localhost:3000
      }
    '';
  };

  # SEED_* env vars are captured to /run/seed/env during VM activation.
  # Caddy (and any other service) must load them via EnvironmentFile.
  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";

  systemd.services.app = {
    wantedBy = [ "multi-user.target" ];
    serviceConfig.ExecStart = app;
    serviceConfig.Restart = "always";
  };
}
