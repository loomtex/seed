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

    # Emit authorized_keys line with forced command and namespace context.
    # restrict disables forwarding/pty/rc. environment= requires PermitUserEnvironment in sshd_config.
    echo "restrict,command=\"seed-shell\",environment=\"SEED_NAMESPACES=$NAMESPACES\" $FULL_KEY seed-user"
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

    # Parse command from SSH_ORIGINAL_COMMAND into words
    # shellcheck disable=SC2086
    set -- ''${SSH_ORIGINAL_COMMAND:-status}

    ACTION="$1"; shift || true
    ARG=""
    JSON_OUT=false
    FOLLOW=false
    LINES=""

    while [ $# -gt 0 ]; do
      case "$1" in
        --json)   JSON_OUT=true ;;
        --follow) FOLLOW=true ;;
        -f)       FOLLOW=true ;;
        --lines)  shift; LINES="''${1:-}" ;;
        *)        [ -z "$ARG" ] && ARG="$1" ;;
      esac
      shift
    done

    case "$ACTION" in
      status)
        RESULT=$(${pkgs.curl}/bin/curl -sf "$API/ns/$NS/status") || {
          echo "error: failed to fetch status" >&2
          exit 1
        }
        if [ "$JSON_OUT" = true ]; then
          echo "$RESULT" | ${pkgs.jq}/bin/jq .
        else
          echo "$RESULT" | ${pkgs.jq}/bin/jq -r '
            "\u001b[1mnamespace: \(.namespace)\u001b[0m\n",
            (.instances | to_entries[] |
              "\u001b[1m\(.key)\u001b[0m " +
              (if .value.ready then "\u001b[32m●\u001b[0m " else "\u001b[31m●\u001b[0m " end) +
              (if .value.ready then "\u001b[32mready\u001b[0m" else "\u001b[31mnot ready\u001b[0m" end) +
              "  phase=\(.value.phase)" +
              "  restarts=\(.value.restarts)" +
              "  age=\(.value.age)"
            )'
        fi
        ;;

      logs)
        if [ -z "$ARG" ]; then
          echo "usage: logs <instance> [-f|--follow] [--lines N] [--json]" >&2
          exit 1
        fi

        # Build query string
        QUERY=""
        [ -n "$LINES" ] && QUERY="lines=$LINES"
        if [ "$FOLLOW" = true ]; then
          [ -n "$QUERY" ] && QUERY="$QUERY&follow=true" || QUERY="follow=true"
        fi
        LOG_URL="$API/ns/$NS/logs/$ARG"
        [ -n "$QUERY" ] && LOG_URL="$LOG_URL?$QUERY"

        if [ "$FOLLOW" = true ]; then
          # Streaming mode — read SSE events line by line
          ${pkgs.curl}/bin/curl -sfN "$LOG_URL" | while IFS= read -r line; do
            case "$line" in
              data:\ *)
                DATA="''${line#data: }"
                if [ "$JSON_OUT" = true ]; then
                  echo "$DATA"
                else
                  echo "$DATA" | ${pkgs.jq}/bin/jq -r '.line |
                    if test(":") then
                      "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
                    else . end'
                fi
                ;;
            esac
          done
        else
          RESULT=$(${pkgs.curl}/bin/curl -sf "$LOG_URL") || {
            echo "error: failed to fetch logs for $ARG" >&2
            exit 1
          }
          if [ "$JSON_OUT" = true ]; then
            echo "$RESULT" | ${pkgs.jq}/bin/jq .
          else
            echo "$RESULT" | ${pkgs.jq}/bin/jq -r '.lines[] |
              # Colorize unit prefix in cyan
              if test(":") then
                "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
              else . end'
            NOTE=$(echo "$RESULT" | ${pkgs.jq}/bin/jq -r '.note // empty')
            if [ -n "$NOTE" ]; then
              printf '\033[33mnote: %s\033[0m\n' "$NOTE" >&2
            fi
          fi
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
        echo "  status                show instance status (default)"
        echo "  logs <instance>       show recent logs (default: 100 lines)"
        echo "  restart <instance>    restart an instance"
        echo "  help                  show this help"
        echo ""
        echo "flags:"
        echo "  --json                output raw JSON (for scripting)"
        echo "  -f, --follow          stream logs in real time"
        echo "  --lines N             number of log lines to show (max 10000)"
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
      # Skip PAM entirely — we only do key auth via AuthorizedKeysCommand.
      # unix_chkpwd fails in Kata VMs (setuid not supported on virtiofs).
      UsePAM = false;
      # Allow only SEED_* environment variables from authorized_keys.
      PermitUserEnvironment = "SEED_*";
    };
  };

  # isNormalUser so PAM account checks pass (isSystemUser lacks /etc/shadow entry).
  # initialHashedPassword unlocks the account (PasswordAuthentication is disabled).
  users.users.seed = {
    isNormalUser = true;
    home = "/home/seed";
    shell = "${shellCmd}/bin/seed-shell";
    initialHashedPassword = "";
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
