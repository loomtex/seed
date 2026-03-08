# Seed silo instance — SSH-only git server
#
# Identity = SSH key. No accounts, no web UI, no database.
# First push auto-creates a bare repo. ACLs via .authorized_keys in each repo.
# Host key fingerprint published as SSHFP DNS record to PowerDNS.
{ config, pkgs, lib, ... }:

let
  reposDir = "/seed/storage/repos";
  hostKeyDir = "${reposDir}/ssh-host-keys";

  # AuthorizedKeysCommand — called by sshd for every connection
  #
  # Always allows login — any valid SSH key is accepted. The key identity
  # is passed to silo-shell via environment variables. silo-shell handles
  # per-repo access control (existing repos) and auto-creation (first push).
  #
  # NOTE: The script content lives in the nix store, but sshd requires the
  # AuthorizedKeysCommand path and all parent directories to be owned by root
  # with no group/world-write. Inside Kata VMs, /nix/store is a virtiofs mount
  # whose ownership doesn't satisfy this check. We install a copy at /etc/ssh/
  # via environment.etc, which sshd trusts.
  siloAuthKeys = pkgs.writeShellScript "silo-auth-keys" ''
    # Args: %u %t %k (username, key-type, key-blob-base64)
    KEY_TYPE="$2"
    KEY_BLOB="$3"
    echo "restrict,command=\"silo-shell\",environment=\"SILO_KEY_TYPE=$KEY_TYPE\",environment=\"SILO_KEY_BLOB=$KEY_BLOB\" $KEY_TYPE $KEY_BLOB silo-user"
  '';

  # silo-shell — forced command for git operations
  #
  # Handles git-receive-pack (push) and git-upload-pack (pull/clone).
  # Auto-creates repos on first push. Checks per-repo .authorized_keys.
  siloShell = pkgs.writeShellScriptBin "silo-shell" ''
    set -euo pipefail

    # SSH_ORIGINAL_COMMAND is set by sshd for forced commands
    if [ -z "''${SSH_ORIGINAL_COMMAND:-}" ]; then
      echo "silo: interactive login not supported" >&2
      exit 1
    fi

    # Parse: git-receive-pack 'repo.git' or git-upload-pack 'repo.git'
    CMD=$(echo "$SSH_ORIGINAL_COMMAND" | ${pkgs.gawk}/bin/awk '{print $1}')
    # Extract repo path, strip quotes
    REPO_PATH=$(echo "$SSH_ORIGINAL_COMMAND" | ${pkgs.coreutils}/bin/cut -d"'" -f2)

    # Validate command
    case "$CMD" in
      git-receive-pack|git-upload-pack) ;;
      *)
        echo "silo: unsupported command: $CMD" >&2
        exit 1
        ;;
    esac

    # Normalize repo path — ensure .git suffix, strip leading /
    REPO_PATH="''${REPO_PATH#/}"
    case "$REPO_PATH" in
      *.git) ;;
      *) REPO_PATH="$REPO_PATH.git" ;;
    esac

    # Sanitize: only allow alphanumeric, dash, underscore, dot, slash
    if ! echo "$REPO_PATH" | ${pkgs.gnugrep}/bin/grep -qE '^[a-zA-Z0-9._/-]+\.git$'; then
      echo "silo: invalid repo name" >&2
      exit 1
    fi

    # Prevent path traversal
    case "$REPO_PATH" in
      *..*)
        echo "silo: invalid repo path" >&2
        exit 1
        ;;
    esac

    FULL_PATH="${reposDir}/$REPO_PATH"
    KEY_LINE="$SILO_KEY_TYPE $SILO_KEY_BLOB silo-user"

    if [ ! -d "$FULL_PATH" ]; then
      # Auto-create on first push only
      if [ "$CMD" != "git-receive-pack" ]; then
        echo "silo: repository not found: $REPO_PATH" >&2
        exit 1
      fi

      # Create bare repo + write owner key
      ${pkgs.git}/bin/git init --bare "$FULL_PATH" > /dev/null
      echo "$KEY_LINE" > "$FULL_PATH/.authorized_keys"
    else
      # Verify access — check this repo's .authorized_keys
      if [ ! -f "$FULL_PATH/.authorized_keys" ]; then
        echo "silo: access denied" >&2
        exit 1
      fi

      if ! ${pkgs.gnugrep}/bin/grep -qF "$SILO_KEY_BLOB" "$FULL_PATH/.authorized_keys"; then
        echo "silo: access denied" >&2
        exit 1
      fi
    fi

    exec ${pkgs.git}/bin/$CMD "$FULL_PATH"
  '';

  # SSHFP publishing — posts host key fingerprint to PowerDNS
  publishSshfp = pkgs.writeShellScript "silo-publish-sshfp" ''
    set -euo pipefail

    API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})
    API="http://seed-dns.s-gaydazldmnsg.svc.cluster.local:8081/api/v1/servers/localhost"

    # Read ed25519 host key
    HOST_KEY="${hostKeyDir}/ssh_host_ed25519_key.pub"
    if [ ! -f "$HOST_KEY" ]; then
      echo "silo-publish-sshfp: no ed25519 host key found" >&2
      exit 1
    fi

    # Compute SHA-256 fingerprint of the raw key bytes
    KEY_BLOB=$(${pkgs.gawk}/bin/awk '{print $2}' "$HOST_KEY")
    SHA256=$(echo "$KEY_BLOB" | ${pkgs.coreutils}/bin/base64 -d | ${pkgs.openssl}/bin/openssl dgst -sha256 -hex | ${pkgs.gawk}/bin/awk '{print $NF}')

    # SSHFP: algorithm 4 (Ed25519), type 2 (SHA-256)
    SSHFP_RECORD="4 2 $SHA256"

    # Wait for pdns API (up to 30s)
    for i in $(seq 1 30); do
      ${pkgs.curl}/bin/curl -sf -H "X-API-Key: $API_KEY" "$API" > /dev/null && break
      sleep 1
    done

    # Publish SSHFP record
    ${pkgs.curl}/bin/curl -sf -X PATCH \
      -H "X-API-Key: $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"rrsets\":[{\"name\":\"silo.loom.farm.\",\"type\":\"SSHFP\",\"ttl\":3600,\"changetype\":\"REPLACE\",\"records\":[{\"content\":\"$SSHFP_RECORD\",\"disabled\":false}]}]}" \
      "$API/zones/loom.farm."

    echo "silo-publish-sshfp: published SSHFP 4 2 $SHA256"
  '';

in {
  seed.size = "xs";
  seed.expose.ssh = { port = 22; protocol = "tcp"; };
  seed.storage.repos = "10Gi";

  # sops-nix: pdns API key for SSHFP publishing
  sops.defaultSopsFile = ../secrets/silo.yaml;
  sops.secrets.pdns-api-key = {};

  # git user — all SSH connections land here
  # isNormalUser so PAM account checks pass (isSystemUser lacks /etc/shadow entry)
  users.users.git = {
    isNormalUser = true;
    group = "git";
    home = reposDir;
    shell = "${siloShell}/bin/silo-shell";
    createHome = false;
  };
  users.groups.git = {};

  # Ensure git owns the repos directory
  systemd.tmpfiles.rules = [
    "d ${reposDir} 0755 git git -"
    "d ${hostKeyDir} 0700 root root -"
  ];

  # openssh server
  services.openssh = {
    enable = true;
    ports = [ 22 ];
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      UsePAM = "no";
      PermitRootLogin = "no";
      AuthorizedKeysFile = "none";
      AuthorizedKeysCommand = "/etc/ssh/silo-auth-keys %u %t %k";
      AuthorizedKeysCommandUser = "root";
    };
    # Persist host keys in PVC
    hostKeys = [
      { path = "${hostKeyDir}/ssh_host_ed25519_key"; type = "ed25519"; }
      { path = "${hostKeyDir}/ssh_host_rsa_key"; type = "rsa"; bits = 4096; }
    ];
  };

  # Install auth script at /etc/ssh/ where sshd trusts the directory ownership
  environment.etc."ssh/silo-auth-keys" = {
    source = siloAuthKeys;
    mode = "0755";
  };

  environment.systemPackages = [ pkgs.git siloShell ];

  # Force host key generation on boot (startWhenNeeded=true defers it to first connection)
  systemd.services.sshd-keygen.wantedBy = [ "multi-user.target" ];

  # Publish SSHFP DNS record after host keys exist
  systemd.services.silo-publish-sshfp = {
    description = "Publish SSH host key fingerprint as SSHFP DNS record";
    wantedBy = [ "multi-user.target" ];
    after = [ "sshd-keygen.service" "network-online.target" ];
    wants = [ "sshd-keygen.service" "network-online.target" ];
    path = [ pkgs.curl pkgs.openssl pkgs.gawk pkgs.coreutils ];
    serviceConfig = {
      Type = "oneshot";
      ExecStart = publishSshfp;
      Restart = "on-failure";
      RestartSec = "10s";
    };
  };
}
