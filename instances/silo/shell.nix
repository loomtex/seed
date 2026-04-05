# silo-shell — forced command for git SSH operations
#
# Handles git-receive-pack (push) and git-upload-pack (pull/clone).
# Auto-creates repos on first push. Checks per-repo .authorized_keys.
{ config, pkgs, lib, reposDir, ... }:

let
  siloTui = import ./tui { inherit pkgs; };

  siloShell = pkgs.writeShellScriptBin "silo-shell" ''
    set -euo pipefail

    # No git command + TTY = launch TUI
    if [ -z "''${SSH_ORIGINAL_COMMAND:-}" ] && [ -t 0 ]; then
      export SILO_REPOS_DIR="${reposDir}"
      export PATH="${pkgs.git}/bin:$PATH"
      exec ${siloTui}/bin/silo-tui
    fi

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

      # Create bare repo + store owner key (immutable, always grants push)
      ${pkgs.git}/bin/git init --bare "$FULL_PATH" > /dev/null
      echo "$KEY_LINE" > "$FULL_PATH/.owner_key"
    elif [ "$CMD" = "git-receive-pack" ]; then
      # Push requires authorization — owner key always works,
      # then check .authorized_keys (synced from repo tree by post-receive)
      AUTHORIZED=false
      if [ -f "$FULL_PATH/.owner_key" ] && ${pkgs.gnugrep}/bin/grep -qF "$SILO_KEY_BLOB" "$FULL_PATH/.owner_key"; then
        AUTHORIZED=true
      elif [ -f "$FULL_PATH/.authorized_keys" ] && ${pkgs.gnugrep}/bin/grep -qF "$SILO_KEY_BLOB" "$FULL_PATH/.authorized_keys"; then
        AUTHORIZED=true
      fi

      if [ "$AUTHORIZED" = "false" ]; then
        echo "silo: access denied" >&2
        exit 1
      fi
    fi
    # git-upload-pack (clone/pull) is always allowed — global read

    exec ${pkgs.git}/bin/$CMD "$FULL_PATH"
  '';

in {
  # SSH auth: any key accepted, identity passed via SILO_KEY_TYPE/SILO_KEY_BLOB.
  # NSS catchall maps any username to git user — `ssh silo.loom.farm` works.
  seed.sshAuth = {
    enable = true;
    uid = 1000;
    gid = 100;
    home = reposDir;
    shell = "${siloShell}/bin/silo-shell";
    userName = "git";
    group = "git";
    nssName = "siloauth";
    forcedCommand = "silo-shell";
    envPrefix = "SILO";
  };

  environment.systemPackages = [ siloShell ];
}
