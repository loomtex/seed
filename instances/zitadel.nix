# Seed zitadel instance — OIDC identity provider
#
# Multi-tenant Zitadel for user authentication across seed instances.
# Uses seed.services.zitadel module for the mTLS proxy to shared postgres.
# Small tier — Go binary, ~200MB RSS.
{ config, pkgs, ... }:

{
  seed.size = "s";
  seed.expose.https.enable = true;
  seed.dns.names = [ "id.loom.farm" ];
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  seed.services.zitadel = {
    enable = true;
    hostname = "id.loom.farm";
    database.host = "postgres.s-gaydazldmnsg.svc.cluster.local";
  };

  # Caddy reverse proxy — TLS via platform ACME
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, id.loom.farm {
        reverse_proxy localhost:8080
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";
}
