# Seed keycloak instance — OIDC identity provider
#
# Multi-tenant Keycloak for user authentication across seed instances.
# Uses seed.services.keycloak module for the mTLS proxy to shared postgres.
# Medium tier — JVM needs ~800MB, no local postgres anymore.
{ config, pkgs, ... }:

{
  seed.size = "m";
  seed.expose.https.enable = true;
  seed.dns.names = [ "id.loom.farm" ];
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  seed.services.keycloak = {
    enable = true;
    hostname = "id.loom.farm";
    database.host = "postgres.s-gaydazldmnsg.svc.cluster.local";
    database.name = "keycloak";
    database.username = "keycloak";
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
