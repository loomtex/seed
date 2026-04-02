# Stripped NixOS profile for Seed instances running inside Kata VMs
#
# Kata provides the kernel, initrd, and virtio networking. This profile
# disables everything NixOS would normally configure for bare metal/VM boot.
# All settings use mkDefault so tenants can override if needed.
{ lib, pkgs, config, ... }:

let
  # EST certificate enrollment script — obtains a SPIFFE identity cert from
  # the platform EST endpoint using vTPM attestation.
  #
  # Flow:
  #   1. Generate TPM-bound ECDSA P-256 key (private key never leaves the TPM)
  #   2. Create CSR with SPIFFE URI SAN
  #   3. Request age-encrypted challenge from controller (POST /est/challenge)
  #   4. Decrypt challenge using age-plugin-tpm (proves vTPM possession)
  #   5. Submit CSR + decrypted nonce (POST /est/enroll)
  #   6. Write signed cert + CA + key handle to /seed/tls/
  #
  # The key.pem is a TSS2 PRIVATE KEY (TPM handle), not raw key material.
  # Services use the tpm2-openssl provider for TLS operations.
  seedCertEnroll = pkgs.writeShellScript "seed-cert-enroll" ''
    set -euo pipefail

    EST_URL="''${SEED_EST_URL:-}"
    if [ -z "$EST_URL" ]; then
      echo "SEED_EST_URL not set, skipping certificate enrollment"
      exit 0
    fi
    NAMESPACE="''${SEED_NAMESPACE:?SEED_NAMESPACE must be set}"
    INSTANCE="''${SEED_INSTANCE:?SEED_INSTANCE must be set}"
    TLS_DIR="/seed/tls"
    TPM_IDENTITY="/seed/tpm/age-identity"

    export OPENSSL_MODULES="${pkgs.tpm2-openssl}/lib/ossl-modules"

    mkdir -p "$TLS_DIR"

    # Ensure TPM device exists (Kata VMs use tmpfs on /dev, nodes created by activation)
    if [ ! -e /dev/tpmrm0 ]; then
      echo "WARNING: /dev/tpmrm0 not found, running tpm-dev-create"
      ${tpmDevCreate}
    fi
    if [ ! -e /dev/tpmrm0 ]; then
      echo "ERROR: /dev/tpmrm0 still not found after device creation"
      exit 1
    fi

    # 1. Generate TPM-bound ECDSA P-256 key
    # The output is a TSS2 PRIVATE KEY PEM — a TPM key handle, not raw material.
    ${pkgs.openssl}/bin/openssl genpkey \
      -provider tpm2 -provider default \
      -algorithm EC -pkeyopt group:P-256 \
      -out "$TLS_DIR/key.pem"

    # 2. Create CSR with SPIFFE URI SAN + DNS SANs for hostname verification
    SPIFFE_URI="spiffe://seeds.loom.farm/$NAMESPACE/$INSTANCE"
    SAN="URI:$SPIFFE_URI"
    SAN="$SAN,DNS:$INSTANCE"
    SAN="$SAN,DNS:$INSTANCE.$NAMESPACE.svc.cluster.local"
    SAN="$SAN,DNS:$INSTANCE.$NAMESPACE.seed.loom.farm"
    ${pkgs.openssl}/bin/openssl req -new \
      -provider tpm2 -provider default -propquery '?provider=tpm2' \
      -key "$TLS_DIR/key.pem" \
      -subj "/O=seeds.loom.farm/OU=$NAMESPACE/CN=$INSTANCE" \
      -addext "subjectAltName=$SAN" \
      -out "$TLS_DIR/csr.pem"

    CSR_PEM=$(cat "$TLS_DIR/csr.pem")

    # 3. Request challenge from EST endpoint
    CHALLENGE_RESP=$(${pkgs.curl}/bin/curl -sf \
      --cacert /etc/ssl/certs/ca-certificates.crt \
      -X POST "$EST_URL/est/challenge" \
      -H "Content-Type: application/json" \
      -d "{\"namespace\":\"$NAMESPACE\",\"instance\":\"$INSTANCE\"}")

    CHALLENGE_ID=$(echo "$CHALLENGE_RESP" | ${pkgs.jq}/bin/jq -r '.challengeId')
    ENCRYPTED=$(echo "$CHALLENGE_RESP" | ${pkgs.jq}/bin/jq -r '.encrypted')

    # 4. Decrypt challenge using age-plugin-tpm (proves vTPM possession)
    # Timeout after 30s — age-plugin-tpm hangs if /dev/tpmrm0 is missing/broken.
    NONCE=$(echo "$ENCRYPTED" | timeout 30 ${pkgs.age}/bin/age -d -i "$TPM_IDENTITY")

    # 5. Submit CSR + decrypted nonce to EST enroll endpoint
    ENROLL_BODY=$(${pkgs.jq}/bin/jq -n \
      --arg cid "$CHALLENGE_ID" \
      --arg nonce "$NONCE" \
      --arg csr "$CSR_PEM" \
      '{challengeId: $cid, nonce: $nonce, csr: $csr}')

    ${pkgs.curl}/bin/curl -sf \
      --cacert /etc/ssl/certs/ca-certificates.crt \
      -X POST "$EST_URL/est/enroll" \
      -H "Content-Type: application/json" \
      -d "$ENROLL_BODY" \
      -o "$TLS_DIR/cert.pem"

    # 6. Fetch CA cert
    ${pkgs.curl}/bin/curl -sf \
      --cacert /etc/ssl/certs/ca-certificates.crt \
      "$EST_URL/est/cacerts" \
      -o "$TLS_DIR/ca.pem"

    # key.pem is a TPM handle (not secret), but PostgreSQL checks permissions.
    # 0640 root:tpm satisfies pg's check while allowing tpm group members to read.
    chgrp tpm "$TLS_DIR/key.pem"
    chmod 0640 "$TLS_DIR/key.pem"
    chmod 0644 "$TLS_DIR/cert.pem" "$TLS_DIR/ca.pem"

    # Remove CSR (no longer needed)
    rm -f "$TLS_DIR/csr.pem"
  '';

  tpmDevCreate = pkgs.writeShellScript "tpm-dev-create" ''
    for tpm in /sys/class/tpm/tpm*; do
      [ -e "$tpm" ] || continue
      name=$(basename "$tpm")
      if [ ! -e "/dev/$name" ]; then
        dev=$(cat "$tpm/dev" 2>/dev/null) || continue
        major=''${dev%%:*}
        minor=''${dev##*:}
        mknod "/dev/$name" c "$major" "$minor"
      fi
      chgrp tpm "/dev/$name" 2>/dev/null || true
      chmod 0660 "/dev/$name"
    done

    # Also create /dev/tpmrm* (resource manager interface)
    for tpmrm in /sys/class/tpmrm/tpmrm*; do
      [ -e "$tpmrm" ] || continue
      name=$(basename "$tpmrm")
      if [ ! -e "/dev/$name" ]; then
        dev=$(cat "$tpmrm/dev" 2>/dev/null) || continue
        major=''${dev%%:*}
        minor=''${dev##*:}
        mknod "/dev/$name" c "$major" "$minor"
      fi
      chgrp tpm "/dev/$name" 2>/dev/null || true
      chmod 0660 "/dev/$name"
    done
  '';
in {
  # boot.isContainer disables kernel, initrd, bootloader, and hardware scan.
  # Kata VMs run real systemd (not container init), but isContainer gives us
  # the right closure size. Services needing /run/* dirs should use RuntimeDirectory.
  boot.isContainer = lib.mkDefault true;

  # No documentation — smaller closure
  documentation.enable = lib.mkDefault false;

  # No nix daemon — instances are pre-built closures
  nix.enable = lib.mkDefault false;

  # No sudo — there's no interactive shell escalation in instances
  security.sudo.enable = lib.mkDefault false;

  # Immutable users — no passwd/shadow management
  users.mutableUsers = lib.mkDefault false;

  # No interactive login — instances are headless, managed by the controller
  users.allowNoPasswordLogin = lib.mkDefault true;

  # Kata handles networking via virtio-net + tc redirects
  networking.useDHCP = lib.mkDefault false;

  # k8s service DNS (CoreDNS) — enables service name resolution + external DNS
  networking.nameservers = lib.mkDefault [ "10.43.0.10" ];

  # tpm group — services that need TPM access (TLS with TPM-bound keys) join this group
  users.groups.tpm = {};

  # Minimal package set — just enough for systemd services to function,
  # plus TPM/secrets tooling for sops-nix integration
  environment.systemPackages = lib.mkDefault (with pkgs; [
    coreutils
    bashInteractive
    util-linux
    age
    age-plugin-tpm
    tpm2-tools
    tpm2-openssl
    sops
    openssl
    curl
    jq
  ]);

  # No polkit — headless instances don't need privilege negotiation
  security.polkit.enable = lib.mkDefault false;

  # No nscd/nsncd — instances use /etc/resolv.conf + /etc/passwd directly.
  # nsncd fails in Kata VMs and cascades to nss-lookup.target failure,
  # breaking DNS resolution and user lookups for all services.
  services.nscd.enable = lib.mkDefault false;
  system.nssModules = lib.mkForce [];

  # Create TPM device nodes during NixOS activation, before sops-nix runs.
  # Kata VMs use tmpfs on /dev (not devtmpfs), so the kernel doesn't
  # auto-create device nodes. sops-nix's setupSecrets activation script runs
  # before systemd starts, so we must create /dev/tpm* during activation too.
  system.activationScripts.tpmDevNodes = {
    deps = [];
    text = ''
      ${tpmDevCreate}
    '';
  };

  # Ensure sops-nix's setupSecrets runs after TPM device nodes exist.
  # Provide a no-op default text so this works even when no secrets are defined.
  system.activationScripts.setupSecrets = {
    deps = [ "tpmDevNodes" ];
    text = lib.mkDefault "";
  };

  # TPM identity provisioning — generates age-plugin-tpm identity on first boot.
  # The identity file at /seed/tpm/age-identity contains the public key (recipient)
  # on its first line, usable for encrypting sops secrets for this instance.
  systemd.services.seed-tpm-init = {
    description = "Generate age-plugin-tpm identity for sops-nix";
    wantedBy = [ "multi-user.target" ];
    before = lib.mkDefault [ "sops-nix.service" ];
    unitConfig.ConditionPathExists = "!/seed/tpm/age-identity";
    path = [ pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      ExecStartPre = "${pkgs.coreutils}/bin/mkdir -p /seed/tpm";
      ExecStart = "${pkgs.age-plugin-tpm}/bin/age-plugin-tpm --generate -o /seed/tpm/age-identity";
      RemainAfterExit = true;
    };
  };

  # TLS identity enrollment — obtains a SPIFFE identity certificate from the
  # platform EST endpoint. Requires seed-tpm-init (age identity for attestation)
  # and SEED_EST_URL (injected by the controller into all instance pods).
  systemd.services.seed-cert-enroll = {
    description = "Obtain SPIFFE identity certificate via EST";
    wantedBy = [ "multi-user.target" ];
    after = [ "seed-tpm-init.service" "network-online.target" ];
    wants = [ "network-online.target" ];
    requires = [ "seed-tpm-init.service" ];
    path = [ pkgs.age-plugin-tpm ];
    unitConfig = {
      # Retry up to 5 times within 5 minutes on boot failures
      StartLimitIntervalSec = 300;
      StartLimitBurst = 5;
    };
    serviceConfig = {
      Type = "oneshot";
      EnvironmentFile = "/run/seed/env";
      ExecStart = seedCertEnroll;
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = "30s";
    };
  };

  # Renewal timer — re-enroll at half the cert lifetime (12h for 24h certs).
  # On failure, retries every 5 minutes.
  systemd.timers.seed-cert-renew = {
    description = "Renew SPIFFE identity certificate";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnActiveSec = "12h";
      OnUnitActiveSec = "12h";
      AccuracySec = "5m";
    };
  };

  systemd.services.seed-cert-renew = {
    description = "Renew SPIFFE identity certificate via EST";
    after = [ "seed-cert-enroll.service" ];
    requires = [ "seed-cert-enroll.service" ];
    path = [ pkgs.age-plugin-tpm ];
    serviceConfig = {
      Type = "oneshot";
      EnvironmentFile = "/run/seed/env";
      ExecStart = seedCertEnroll;
      Restart = "on-failure";
      RestartSec = "5m";
    };
  };

  # Default sops-nix to use the TPM-backed age identity provisioned by seed-tpm-init.
  # Instances using sops.secrets.* will decrypt via their unique vTPM key automatically.
  sops.age.keyFile = lib.mkDefault "/seed/tpm/age-identity";
  sops.age.plugins = lib.mkDefault [ pkgs.age-plugin-tpm ];

  # Trust the platform CA if mounted by the controller.
  # NixOS creates /etc/ssl/certs/ca-certificates.crt as a symlink to the nix
  # store CA bundle. We replace it with a combined bundle (mozilla roots +
  # platform CA) so ALL programs trust it — including those in sanitized
  # environments (sshd AuthorizedKeysCommand, git hooks, etc.) where
  # SSL_CERT_FILE isn't available.
  system.activationScripts.seedTrust = {
    deps = [ "etc" ];
    text = ''
      if [ -f /etc/seed/ca/ca.crt ]; then
        rm -f /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-bundle.crt /etc/pki/tls/certs/ca-bundle.crt
        cat ${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt /etc/seed/ca/ca.crt > /etc/ssl/certs/ca-certificates.crt
        ln -sf /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-bundle.crt
        ln -sf /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt
      fi
    '';
  };

  # Capture k8s-injected SEED_* environment variables for use by services.
  # Kata VMs: systemd strips the inherited environment on startup, so
  # PassEnvironment doesn't work. This activation script reads PID 1's
  # original environment (preserved in /proc/1/environ) and writes SEED_*
  # vars to /run/seed/env. Services use EnvironmentFile=/run/seed/env.
  system.activationScripts.seedEnv = {
    text = ''
      mkdir -p /run/seed
      ${pkgs.coreutils}/bin/tr '\0' '\n' < /proc/1/environ | ${pkgs.gnugrep}/bin/grep '^SEED_' > /run/seed/env || true
    '';
  };

  system.stateVersion = lib.mkDefault "25.11";
}
