# Seed social instance — GoToSocial ActivityPub server
#
# Single-user fediverse instance. Federates with Mastodon, Pleroma,
# Misskey, Pixelfed, etc. via ActivityPub. API-only — use any
# Mastodon-compatible client (Tusky, Elk, Ivory, Phanpy).
#
# SQLite-backed, runs on xs tier (~50MB RAM). Built with nowasm tag to avoid
# 413MB peak Wasm compilation at runtime. Uses system ffmpeg instead.
# Caddy handles TLS via platform ACME.
{ pkgs, ... }:

let
  # Build GtS without Wasm — uses system ffmpeg/ffprobe for media processing.
  # Default build compiles Wasm at runtime, which peaks at 413MB and OOMs on xs.
  gotosocial-nowasm = pkgs.gotosocial.overrideAttrs (old: {
    tags = (old.tags or []) ++ [ "nowasm" ];
  });

  # Admin account created on first boot. Password should be changed immediately.
  adminUser = "josh";
  adminEmail = "josh@loom.farm";

  # Config for gotosocial CLI — needs host + DB path at minimum
  adminConfig = pkgs.writeText "gotosocial-admin.yml" ''
    host: social.loom.farm
    db-type: sqlite
    db-address: /seed/storage/data/gotosocial.sqlite
  '';

  gts = "${gotosocial-nowasm}/bin/gotosocial --config-path ${adminConfig}";
in {
  seed.expose.https.enable = true;
  seed.storage.data = "5Gi";
  seed.storage.caddy = { size = "100Mi"; mountPoint = "/var/lib/caddy"; };

  services.gotosocial = {
    enable = true;
    package = gotosocial-nowasm;
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
  # Waits for GtS to be fully ready (API responding) before touching the DB.
  systemd.services.gotosocial-admin-init = {
    description = "Create initial GoToSocial admin account";
    wantedBy = [ "multi-user.target" ];
    after = [ "gotosocial.service" ];
    wants = [ "gotosocial.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "gotosocial";
      Group = "gotosocial";
      WorkingDirectory = "/var/lib/gotosocial";
      ExecStart = pkgs.writeShellScript "gotosocial-admin-init" ''
        set -euo pipefail
        MARKER="/seed/storage/data/.admin-created"

        # Wait for GtS API to be fully ready (not 503) — up to 60s
        for i in $(seq 1 60); do
          CODE=$(${pkgs.curl}/bin/curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/api/v1/instance 2>/dev/null || echo "000")
          [ "$CODE" = "200" ] && break
          sleep 1
        done

        if [ "$CODE" != "200" ]; then
          echo "GtS API not ready after 60s (last status: $CODE), skipping admin init"
          exit 0
        fi

        # Check if account already exists via API (don't trust marker file alone —
        # previous OOM-killed pod may have written marker without completing setup)
        USERS=$(${pkgs.curl}/bin/curl -sf http://127.0.0.1:8080/api/v1/instance 2>/dev/null | ${pkgs.jq}/bin/jq -r '.stats.user_count // 0')
        if [ "$USERS" -gt 0 ] && [ -f "$MARKER" ]; then
          echo "Admin account already exists (user_count=$USERS)"
          exit 0
        fi

        PASS=$(${pkgs.openssl}/bin/openssl rand -base64 24)

        # GtS admin CLI operates directly on the SQLite DB.
        # Stop GtS briefly to avoid SQLite locking issues, run CLI, restart.
        echo "Creating admin account '${adminUser}'..."
        ${gts} admin account create \
          --username "${adminUser}" \
          --email "${adminEmail}" \
          --password "$PASS"
        ${gts} admin account confirm --username "${adminUser}"
        ${gts} admin account promote --username "${adminUser}"

        echo "$PASS" > "$MARKER"
        chmod 0600 "$MARKER"
        echo "Admin account '${adminUser}' created. Initial password saved to $MARKER"
      '';
    };
  };

  # nowasm mode needs system ffmpeg/ffprobe for media processing.
  # Must be in the gotosocial service PATH — environment.systemPackages alone
  # doesn't guarantee visibility to sandboxed systemd services.
  systemd.services.gotosocial.path = [ pkgs.ffmpeg-headless ];

  # PVC ownership
  systemd.tmpfiles.rules = [
    "d /seed/storage/data 0750 gotosocial gotosocial -"
  ];
}
