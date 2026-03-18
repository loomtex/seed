# Seed web instance — static site with platform TLS
#
# Serves loom.farm static content over HTTPS. TLS certificates are
# obtained automatically from the platform ACME endpoint (controller
# proxies DNS-01 to Let's Encrypt). Caddy handles cert lifecycle.
#
# The controller injects SEED_ACME_URL (ACME directory) and SEED_FQDN
# (instance hostname) as env vars. Caddy expands {$VAR} at startup.
{ pkgs, ... }:

let
  siteDir = ../site;
in
{
  seed.size = "xs";
  seed.expose.http = { port = 80; protocol = "tcp"; };
  seed.expose.https = { port = 443; protocol = "http"; };
  seed.storage.caddy = "100Mi";

  # seed.acme is automatically true because expose.https has protocol "http"

  # Use configFile instead of virtualHosts so we can use Caddy env vars
  # for the site address ({$SEED_FQDN}) and ACME CA ({$SEED_ACME_URL}).
  services.caddy = {
    enable = true;
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
        storage file_system /seed/storage/caddy
      }

      {$SEED_FQDN}, loom.farm, www.loom.farm {
        handle_path /_hook/* {
          reverse_proxy seed-controller.seed-system.svc.cluster.local:9876
        }
        root * ${siteDir}
        file_server
        log {
          output stderr
        }
      }
    '';
  };

  # Load SEED_* env vars captured from PID 1 into Caddy's environment.
  # Caddy substitutes {$SEED_ACME_URL} and {$SEED_FQDN} in the Caddyfile.
  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
}
