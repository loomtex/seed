# Seed social instance — GoToSocial ActivityPub server
#
# Single-user fediverse instance. Federates with Mastodon, Pleroma,
# Misskey, Pixelfed, etc. via ActivityPub. API-only — use any
# Mastodon-compatible client (Tusky, Elk, Ivory, Phanpy).
#
# SQLite-backed, runs on xs tier (~50MB RAM idle). Caddy handles TLS
# via the platform ACME endpoint.
{ pkgs, ... }:

let
  # Admin account created on first boot. Password should be changed immediately.
  adminUser = "josh";
  adminEmail = "josh@loom.farm";

  # Minimal config for gotosocial CLI (just needs DB path)
  adminConfig = pkgs.writeText "gotosocial-admin.yml" ''
    db-type: sqlite
    db-address: /seed/storage/data/gotosocial.sqlite
  '';

  gts = "${pkgs.gotosocial}/bin/gotosocial --config-path ${adminConfig}";
in {
  seed.expose.https.enable = true;
  seed.storage.data = "5Gi";
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  services.gotosocial = {
    enable = true;
    settings = {
      host = "social.loom.farm";
      protocol = "https";
      bind-address = "127.0.0.1";
      port = 8080;

      # SQLite — no external DB needed
      db-type = "sqlite";
      db-address = "/seed/storage/data/gotosocial.sqlite";

      # Media storage on PVC
      storage-local-base-path = "/seed/storage/data/storage";

      # Federation
      instance-expose-public-timeline = true;
      instance-deliver-to-shared-inboxes = true;

      # Sensible limits
      media-remote-cache-days = 7;
      accounts-registration-open = false;
    };
  };

  # Caddy reverse proxy — TLS via platform ACME
  services.caddy = {
    enable = true;
    dataDir = "/var/lib/caddy";
    configFile = pkgs.writeText "Caddyfile" ''
      {
        acme_ca {$SEED_ACME_URL}
      }

      {$SEED_FQDN}, social.loom.farm {
        reverse_proxy localhost:8080
      }
    '';
  };

  systemd.services.caddy.serviceConfig.EnvironmentFile = "/run/seed/env";

  # Create admin account on first boot (idempotent — skips if marker exists).
  # Initial password written to PVC marker file. Change it immediately.
  systemd.services.gotosocial-admin-init = {
    description = "Create initial GoToSocial admin account";
    wantedBy = [ "multi-user.target" ];
    after = [ "gotosocial.service" ];
    requires = [ "gotosocial.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "gotosocial";
      Group = "gotosocial";
      WorkingDirectory = "/var/lib/gotosocial";
      ExecStart = pkgs.writeShellScript "gotosocial-admin-init" ''
        set -euo pipefail
        MARKER="/seed/storage/data/.admin-created"
        [ -f "$MARKER" ] && exit 0

        # Wait for GtS API to be ready (up to 30s)
        for i in $(seq 1 30); do
          ${pkgs.curl}/bin/curl -sf http://127.0.0.1:8080/api/v1/instance > /dev/null 2>&1 && break
          sleep 1
        done

        PASS=$(${pkgs.openssl}/bin/openssl rand -base64 24)

        # GtS admin CLI operates directly on the SQLite DB
        ${gts} admin account create \
          --username "${adminUser}" \
          --email "${adminEmail}" \
          --password "$PASS" || true
        ${gts} admin account confirm --username "${adminUser}" || true
        ${gts} admin account promote --username "${adminUser}" || true

        echo "$PASS" > "$MARKER"
        chmod 0600 "$MARKER"
        echo "Admin account '${adminUser}' created. Initial password saved to $MARKER"
      '';
    };
  };

  # PVC ownership
  systemd.tmpfiles.rules = [
    "d /seed/storage/data 0750 gotosocial gotosocial -"
  ];
}
