# Seed shell instance — SSH management interface for seed tenants
#
# SSH is the interface. Users connect with their SSH key, which the controller
# maps to a namespace via .authorized_keys in each flake's root. The shell
# provides non-interactive commands: status, logs, restart.
#
# Auth flow:
#   1. sshd calls AuthorizedKeysCommand → curls controller /api/keys
#   2. If key is found, sshd accepts with forced command + namespace env var
#   3. seed-shell dispatches to the appropriate command
#   4. Commands proxy through the controller's internal API
{ config, pkgs, lib, ... }:

let
  controllerApi = "http://seed-controller.seed-system.svc.cluster.local:9876";

  # AuthorizedKeysCommand — called by sshd for every connection.
  # Fetches the key index from the controller and checks if the connecting
  # key is authorized. If so, emits an authorized_keys line with a forced
  # command and the namespace injected as an environment variable.
  shellAuthKeys = pkgs.writeShellScript "shell-auth-keys" ''
    # Args: %u %t %k (username, key-type, key-blob-base64)
    KEY_TYPE="$2"
    KEY_BLOB="$3"
    FULL_KEY="$KEY_TYPE $KEY_BLOB"

    # Fetch key index from controller
    INDEX=$(${pkgs.curl}/bin/curl -sf "${controllerApi}/api/keys" 2>/dev/null) || exit 0

    # Look up this key — find matching namespaces
    NAMESPACES=$(echo "$INDEX" | ${pkgs.jq}/bin/jq -r \
      --arg key "$FULL_KEY" \
      '.keys[$key] // empty | join(",")')

    if [ -z "$NAMESPACES" ]; then
      exit 0  # Key not found — deny
    fi

    # Emit authorized_keys line with forced command and namespace context
    echo "restrict,command=\"seed-shell\",environment=\"SEED_NAMESPACES=$NAMESPACES\",environment=\"SEED_KEY_TYPE=$KEY_TYPE\",environment=\"SEED_KEY_BLOB=$KEY_BLOB\" $FULL_KEY seed-user"
  '';

  # seed-shell — forced command for management operations
  shellCmd = pkgs.writeShellScriptBin "seed-shell" ''
    set -euo pipefail

    API="${controllerApi}/api"
    NAMESPACES="''${SEED_NAMESPACES:-}"

    if [ -z "$NAMESPACES" ]; then
      echo "error: no namespace context" >&2
      exit 1
    fi

    # For now, use the first namespace (multi-namespace support later)
    NS=$(echo "$NAMESPACES" | ${pkgs.coreutils}/bin/cut -d, -f1)

    # Parse command from SSH_ORIGINAL_COMMAND or show status by default
    CMD="''${SSH_ORIGINAL_COMMAND:-status}"
    ACTION=$(echo "$CMD" | ${pkgs.gawk}/bin/awk '{print $1}')
    ARG=$(echo "$CMD" | ${pkgs.gawk}/bin/awk '{print $2}')

    case "$ACTION" in
      status)
        RESULT=$(${pkgs.curl}/bin/curl -sf "$API/ns/$NS/status") || {
          echo "error: failed to fetch status" >&2
          exit 1
        }
        echo "$RESULT" | ${pkgs.jq}/bin/jq -r '
          "namespace: \(.namespace)\n",
          (.instances | to_entries[] |
            "\(.key):" +
            "  \(if .value.ready then "ready" else "not ready" end)" +
            "  phase=\(.value.phase)" +
            "  restarts=\(.value.restarts)" +
            "  age=\(.value.age)" +
            ""
          )'
        ;;

      logs)
        if [ -z "$ARG" ]; then
          echo "usage: logs <instance>" >&2
          exit 1
        fi
        RESULT=$(${pkgs.curl}/bin/curl -sf "$API/ns/$NS/logs/$ARG") || {
          echo "error: failed to fetch logs for $ARG" >&2
          exit 1
        }
        echo "$RESULT" | ${pkgs.jq}/bin/jq -r '.lines[]'
        NOTE=$(echo "$RESULT" | ${pkgs.jq}/bin/jq -r '.note // empty')
        if [ -n "$NOTE" ]; then
          echo "note: $NOTE" >&2
        fi
        ;;

      restart)
        if [ -z "$ARG" ]; then
          echo "usage: restart <instance>" >&2
          exit 1
        fi
        RESULT=$(${pkgs.curl}/bin/curl -sf -X POST "$API/ns/$NS/restart/$ARG") || {
          echo "error: failed to restart $ARG" >&2
          exit 1
        }
        echo "$RESULT" | ${pkgs.jq}/bin/jq -r '"restarted \(.instance) (pod \(.pod))"'
        ;;

      help|--help|-h)
        echo "seed shell — manage your seed instances"
        echo ""
        echo "commands:"
        echo "  status              show instance status (default)"
        echo "  logs <instance>     show recent logs"
        echo "  restart <instance>  restart an instance"
        echo "  help                show this help"
        ;;

      *)
        echo "unknown command: $ACTION" >&2
        echo "run 'help' for usage" >&2
        exit 1
        ;;
    esac
  '';

in
{
  seed.size = "xs";
  seed.expose.ssh = { port = 22; protocol = "tcp"; };

  environment.systemPackages = [ shellCmd ];

  services.openssh = {
    enable = true;
    settings = {
      PermitRootLogin = "no";
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
    };
  };

  # In Kata VMs, unix_chkpwd doesn't work (no setuid support with
  # boot.isContainer). Use a minimal PAM config that skips account checks.
  security.pam.services.sshd = {
    allowNullPassword = true;
    account = lib.mkForce [{
      name = "permit";
      enable = true;
      order = 0;
      control = "required";
      modulePath = "pam_permit.so";
    }];
  };

  users.users.seed = {
    isNormalUser = true;
    home = "/home/seed";
    shell = "${shellCmd}/bin/seed-shell";
  };

  # Install AuthorizedKeysCommand script to /etc/ssh/ where sshd trusts ownership
  environment.etc."ssh/shell-auth-keys" = {
    source = shellAuthKeys;
    mode = "0755";
  };

  services.openssh.extraConfig = ''
    Match User seed
      AuthorizedKeysCommand /etc/ssh/shell-auth-keys %u %t %k
      AuthorizedKeysCommandUser root
  '';
}
