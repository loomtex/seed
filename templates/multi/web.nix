{ pkgs, ... }:

{
  seed.expose.https.enable = true;
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };
  seed.storage.data = "1Gi";

  # Caddy frontend — proxies /api to the api instance, serves static files.
  # Instances in the same flake share a namespace and can reach each other
  # by name (e.g. "api" resolves to the api instance's ClusterIP).
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {$SEED_FQDN} {
        handle /api/* {
          reverse_proxy api:3000
        }
        handle {
          root * /seed/storage/data/www
          file_server
        }
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
}
