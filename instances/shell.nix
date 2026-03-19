# Seed shell instance — SSH management interface for seed tenants
#
# SSH is the interface. Users connect with their SSH key, which the controller
# maps to repo→namespace pairs via .authorized_keys in each flake's root.
# The shell provides non-interactive commands: status, logs, restart.
#
# Auth flow:
#   1. sshd calls AuthorizedKeysCommand → curls controller /api/keys
#   2. If key is found, sshd accepts with forced command + SEED_REPOS env var
#   3. seed-shell dispatches to the appropriate command
#   4. Commands proxy through the controller's internal API
#
# Instance targeting:
#   - Bare name: "web" — auto-resolves repo if unambiguous
#   - Qualified: "seed/web" — explicit repo/instance
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

    # Look up this key — build name=namespace pairs.
    # API returns: { keys: { "ssh-ed25519 ... [comment]": [{ name: "seed", namespace: "s-xxx" }, ...] } }
    # Keys in .authorized_keys may have comments (e.g. "openpgp:0x...") but sshd
    # only gives us type+blob. Match on the first two space-separated fields.
    REPOS=$(echo "$INDEX" | ${pkgs.jq}/bin/jq -r \
      --arg key "$FULL_KEY" \
      '[ .keys | to_entries[]
         | select(.key | split(" ")[0:2] | join(" ") == $key)
         | .value[] ]
       | unique_by(.namespace)
       | map("\(.name)=\(.namespace)") | join(",")')

    if [ -z "$REPOS" ]; then
      exit 0  # Key not found — deny
    fi

    # Emit authorized_keys line with forced command and repo context.
    # restrict disables forwarding/pty/rc. environment= requires PermitUserEnvironment in sshd_config.
    echo "restrict,command=\"seed-shell\",environment=\"SEED_REPOS=$REPOS\" $FULL_KEY seed-user"
  '';

  # seed-shell — forced command for management operations
  #
  # SEED_REPOS env var format: "seed=s-gaydazldmnsg,shoot-demo=s-mfstazlgmy2g"
  # Instance targeting: bare "web" (auto-resolve) or "seed/web" (explicit repo)
  shellCmd = pkgs.writeShellScriptBin "seed-shell" ''
    set -euo pipefail

    CURL="${pkgs.curl}/bin/curl"
    JQ="${pkgs.jq}/bin/jq"
    API="${controllerApi}/api"
    REPOS_RAW="''${SEED_REPOS:-}"

    if [ -z "$REPOS_RAW" ]; then
      echo "error: no namespace context" >&2
      exit 1
    fi

    # Parse SEED_REPOS into parallel arrays: REPO_NAMES and REPO_NS
    declare -a REPO_NAMES=()
    declare -a REPO_NS=()
    IFS=',' read -ra PAIRS <<< "$REPOS_RAW"
    for pair in "''${PAIRS[@]}"; do
      REPO_NAMES+=("''${pair%%=*}")
      REPO_NS+=("''${pair#*=}")
    done

    # Resolve a repo name to its namespace
    resolve_repo() {
      local name="$1"
      for i in "''${!REPO_NAMES[@]}"; do
        if [ "''${REPO_NAMES[$i]}" = "$name" ]; then
          echo "''${REPO_NS[$i]}"
          return 0
        fi
      done
      echo "error: unknown repo '$name'" >&2
      echo "available: ''${REPO_NAMES[*]}" >&2
      return 1
    }

    # Resolve "repo/instance" or bare "instance" to (NS, INSTANCE)
    # For bare instance names, searches all repos for a match.
    resolve_instance() {
      local arg="$1"
      if [[ "$arg" == */* ]]; then
        # Explicit: repo/instance
        RESOLVED_REPO="''${arg%%/*}"
        RESOLVED_INSTANCE="''${arg#*/}"
        RESOLVED_NS=$(resolve_repo "$RESOLVED_REPO") || exit 1
        return 0
      fi

      # Bare instance name — search all repos
      local matches=()
      local match_ns=()
      local match_repo=()
      for i in "''${!REPO_NAMES[@]}"; do
        local ns="''${REPO_NS[$i]}"
        local result
        result=$($CURL -sf "$API/ns/$ns/status" 2>/dev/null) || continue
        if echo "$result" | $JQ -e --arg inst "$arg" '.instances[$inst]' >/dev/null 2>&1; then
          matches+=("$i")
          match_ns+=("$ns")
          match_repo+=("''${REPO_NAMES[$i]}")
        fi
      done

      if [ ''${#matches[@]} -eq 0 ]; then
        echo "error: instance '$arg' not found in any repo" >&2
        exit 1
      elif [ ''${#matches[@]} -gt 1 ]; then
        echo "error: '$arg' exists in multiple repos: ''${match_repo[*]}" >&2
        echo "use repo/instance to disambiguate (e.g. ''${match_repo[0]}/$arg)" >&2
        exit 1
      fi

      RESOLVED_REPO="''${match_repo[0]}"
      RESOLVED_INSTANCE="$arg"
      RESOLVED_NS="''${match_ns[0]}"
    }

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
        if [ -n "$ARG" ]; then
          # Status for a specific repo
          NS=$(resolve_repo "$ARG") || exit 1
          RESULT=$($CURL -sf "$API/ns/$NS/status") || {
            echo "error: failed to fetch status for $ARG" >&2
            exit 1
          }
          if [ "$JSON_OUT" = true ]; then
            echo "$RESULT" | $JQ .
          else
            echo "$RESULT" | $JQ -r --arg repo "$ARG" '
              "\u001b[1m\($repo)\u001b[0m",
              (.instances | to_entries[] |
                "  \u001b[1m\(.key)\u001b[0m " +
                (if .value.ready then "\u001b[32m●\u001b[0m " else "\u001b[31m●\u001b[0m " end) +
                (if .value.ready then "\u001b[32mready\u001b[0m" else "\u001b[31mnot ready\u001b[0m" end) +
                "  phase=\(.value.phase)" +
                "  restarts=\(.value.restarts)" +
                "  age=\(.value.age)"
              ), ""'
          fi
        else
          # Status for all repos
          ALL_JSON="[]"
          for i in "''${!REPO_NAMES[@]}"; do
            REPO="''${REPO_NAMES[$i]}"
            NS="''${REPO_NS[$i]}"
            RESULT=$($CURL -sf "$API/ns/$NS/status" 2>/dev/null) || continue
            ALL_JSON=$(echo "$ALL_JSON" | $JQ --arg repo "$REPO" --argjson result "$RESULT" \
              '. + [{ repo: $repo, data: $result }]')
          done

          if [ "$JSON_OUT" = true ]; then
            echo "$ALL_JSON" | $JQ .
          else
            echo "$ALL_JSON" | $JQ -r '.[] |
              "\u001b[1m\(.repo)\u001b[0m",
              (.data.instances | to_entries[] |
                "  \u001b[1m\(.key)\u001b[0m " +
                (if .value.ready then "\u001b[32m●\u001b[0m " else "\u001b[31m●\u001b[0m " end) +
                (if .value.ready then "\u001b[32mready\u001b[0m" else "\u001b[31mnot ready\u001b[0m" end) +
                "  phase=\(.value.phase)" +
                "  restarts=\(.value.restarts)" +
                "  age=\(.value.age)"
              ), ""'
          fi
        fi
        ;;

      logs)
        if [ -z "$ARG" ]; then
          echo "usage: logs <[repo/]instance> [-f|--follow] [--lines N] [--json]" >&2
          exit 1
        fi

        resolve_instance "$ARG"

        # Build query string
        QUERY=""
        [ -n "$LINES" ] && QUERY="lines=$LINES"
        if [ "$FOLLOW" = true ]; then
          [ -n "$QUERY" ] && QUERY="$QUERY&follow=true" || QUERY="follow=true"
        fi
        LOG_URL="$API/ns/$RESOLVED_NS/logs/$RESOLVED_INSTANCE"
        [ -n "$QUERY" ] && LOG_URL="$LOG_URL?$QUERY"

        if [ "$FOLLOW" = true ]; then
          # Streaming mode — read SSE events line by line
          $CURL -sfN "$LOG_URL" | while IFS= read -r line; do
            case "$line" in
              data:\ *)
                DATA="''${line#data: }"
                if [ "$JSON_OUT" = true ]; then
                  echo "$DATA"
                else
                  echo "$DATA" | $JQ -r '.line |
                    if test(":") then
                      "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
                    else . end'
                fi
                ;;
            esac
          done
        else
          RESULT=$($CURL -sf "$LOG_URL") || {
            echo "error: failed to fetch logs for $RESOLVED_INSTANCE" >&2
            exit 1
          }
          if [ "$JSON_OUT" = true ]; then
            echo "$RESULT" | $JQ .
          else
            echo "$RESULT" | $JQ -r '.lines[] |
              # Colorize unit prefix in cyan
              if test(":") then
                "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
              else . end'
            NOTE=$(echo "$RESULT" | $JQ -r '.note // empty')
            if [ -n "$NOTE" ]; then
              printf '\033[33mnote: %s\033[0m\n' "$NOTE" >&2
            fi
          fi
        fi
        ;;

      restart)
        if [ -z "$ARG" ]; then
          echo "usage: restart <[repo/]instance>" >&2
          exit 1
        fi
        resolve_instance "$ARG"
        RESULT=$($CURL -sf -X POST "$API/ns/$RESOLVED_NS/restart/$RESOLVED_INSTANCE") || {
          echo "error: failed to restart $RESOLVED_INSTANCE" >&2
          exit 1
        }
        echo "$RESULT" | $JQ -r '"restarted \(.instance) (pod \(.pod))"'
        ;;

      help|--help|-h)
        echo "seed shell — manage your seed instances"
        echo ""
        echo "commands:"
        echo "  status [repo]              show instance status (default: all repos)"
        echo "  logs <[repo/]instance>     show recent logs (default: 100 lines)"
        echo "  restart <[repo/]instance>  restart an instance"
        echo "  help                       show this help"
        echo ""
        echo "examples:"
        echo "  status                     status of all repos"
        echo "  status seed                status of the 'seed' repo"
        echo "  logs web                   logs for 'web' (auto-resolves repo)"
        echo "  logs seed/web -f           follow logs for 'web' in 'seed' repo"
        echo "  restart shoot-demo/shoot-demo"
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
