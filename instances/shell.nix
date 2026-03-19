# Seed shell instance — SSH management interface for seed tenants
#
# SSH is the interface. Any valid SSH key is accepted (NSS catchall maps any
# username to the seed user). `ssh seed.loom.farm` just works.
# Key identity determines what repos you can manage.
#
# Auth flow:
#   1. sshd calls AuthorizedKeysCommand → curls controller /api/keys
#   2. Any key is accepted. Known keys get SEED_REPOS; unknown keys get empty.
#   3. Key identity passed via SEED_KEY_TYPE/SEED_KEY_BLOB env vars.
#   4. seed-shell dispatches: repo commands need SEED_REPOS, plant works for all.
#
# Instance targeting:
#   - Bare name: "web" — auto-resolves repo if unambiguous
#   - Qualified: "seed/web" — explicit repo/instance
{ config, pkgs, lib, ... }:

let
  controllerApi = "http://seed-controller.seed-system.svc.cluster.local:9876";

  # NSS module that resolves any unknown username to the seed user.
  # sshd calls getpwnam() before auth — without this, unknown usernames
  # are rejected before AuthorizedKeysCommand even runs. This lets users
  # run `ssh seed.loom.farm` without specifying a username.
  nssSeedshell = pkgs.stdenv.mkDerivation {
    name = "nss-seedshell";
    dontUnpack = true;
    buildPhase = ''
      cat > nss_seedshell.c << 'CEOF'
      #include <nss.h>
      #include <pwd.h>
      #include <string.h>
      #include <errno.h>

      enum nss_status _nss_seedshell_getpwnam_r(
          const char *name, struct passwd *pwd,
          char *buf, size_t buflen, int *errnop)
      {
          const char *home = "/home/seed";
          const char *shell = "/run/current-system/sw/bin/seed-shell";
          size_t namelen = strlen(name) + 1;
          size_t homelen = strlen(home) + 1;
          size_t shelllen = strlen(shell) + 1;
          size_t needed = namelen + 2 + homelen + shelllen;

          if (buflen < needed) {
              *errnop = ERANGE;
              return NSS_STATUS_TRYAGAIN;
          }

          char *p = buf;
          memcpy(p, name, namelen); pwd->pw_name = p; p += namelen;
          *p = 'x'; *(p+1) = '\0'; pwd->pw_passwd = p; p += 2;
          pwd->pw_uid = 1000;
          pwd->pw_gid = 100;
          pwd->pw_gecos = pwd->pw_name;
          memcpy(p, home, homelen); pwd->pw_dir = p; p += homelen;
          memcpy(p, shell, shelllen); pwd->pw_shell = p;

          return NSS_STATUS_SUCCESS;
      }
      CEOF
      $CC -shared -o libnss_seedshell.so.2 nss_seedshell.c -Wl,-soname,libnss_seedshell.so.2
    '';
    installPhase = ''
      mkdir -p $out/lib
      cp libnss_seedshell.so.2 $out/lib/
    '';
  };

  # AuthorizedKeysCommand — called by sshd for every connection.
  # Always accepts any valid SSH key (like silo). Key identity and repo
  # context are passed to the forced command via environment variables.
  # Commands that need repos check SEED_REPOS; plant works regardless.
  shellAuthKeys = pkgs.writeShellScript "shell-auth-keys" ''
    # Args: %u %t %k (username, key-type, key-blob-base64)
    KEY_TYPE="$2"
    KEY_BLOB="$3"
    FULL_KEY="$KEY_TYPE $KEY_BLOB"

    # Fetch key index from controller
    REPOS=""
    INDEX=$(${pkgs.curl}/bin/curl -sf "${controllerApi}/api/keys" 2>/dev/null) || true

    if [ -n "$INDEX" ]; then
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
    fi

    # Always emit a line — any key is accepted.
    # Key identity passed via SEED_KEY_TYPE/SEED_KEY_BLOB for plant command.
    # SEED_REPOS may be empty for unknown keys (plant still works).
    echo "restrict,command=\"seed-shell\",environment=\"SEED_REPOS=$REPOS\",environment=\"SEED_KEY_TYPE=$KEY_TYPE\",environment=\"SEED_KEY_BLOB=$KEY_BLOB\" $FULL_KEY seed-user"
  '';

  # seed-shell — forced command for management operations
  #
  # SEED_REPOS env var format: "seed=s-gaydazldmnsg,shoot-demo=s-mfstazlgmy2g"
  # SEED_KEY_TYPE/SEED_KEY_BLOB: SSH key identity (always set)
  # Instance targeting: bare "web" (auto-resolve) or "seed/web" (explicit repo)
  shellCmd = pkgs.writeShellScriptBin "seed-shell" ''
    set -euo pipefail

    CURL="${pkgs.curl}/bin/curl"
    JQ="${pkgs.jq}/bin/jq"
    API="${controllerApi}/api"
    REPOS_RAW="''${SEED_REPOS:-}"
    KEY_BLOB="''${SEED_KEY_BLOB:-}"

    # Helper: require SEED_REPOS for commands that need repo context
    require_repos() {
      if [ -z "$REPOS_RAW" ]; then
        echo "error: no repos found for your key" >&2
        echo "use 'plant <flake-uri> <invite-code>' to register a repo first" >&2
        exit 1
      fi
    }

    # Parse SEED_REPOS into parallel arrays: REPO_NAMES and REPO_NS
    declare -a REPO_NAMES=()
    declare -a REPO_NS=()
    if [ -n "$REPOS_RAW" ]; then
      IFS=',' read -ra PAIRS <<< "$REPOS_RAW"
      for pair in "''${PAIRS[@]}"; do
        REPO_NAMES+=("''${pair%%=*}")
        REPO_NS+=("''${pair#*=}")
      done
    fi

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

    # Parse command from SSH_ORIGINAL_COMMAND into words.
    # Default to status if repos are available, help otherwise.
    DEFAULT_CMD="help"
    [ -n "$REPOS_RAW" ] && DEFAULT_CMD="status"
    # shellcheck disable=SC2086
    set -- ''${SSH_ORIGINAL_COMMAND:-$DEFAULT_CMD}

    ACTION="$1"; shift || true
    ARG=""
    ARG2=""
    JSON_OUT=false
    FOLLOW=false
    LINES=""

    while [ $# -gt 0 ]; do
      case "$1" in
        --json)   JSON_OUT=true ;;
        --follow) FOLLOW=true ;;
        -f)       FOLLOW=true ;;
        --lines)  shift; LINES="''${1:-}" ;;
        *)        if [ -z "$ARG" ]; then ARG="$1"; elif [ -z "$ARG2" ]; then ARG2="$1"; fi ;;
      esac
      shift
    done

    case "$ACTION" in
      plant)
        if [ -z "$ARG" ] || [ -z "$ARG2" ]; then
          echo "usage: plant <flake-uri> <invite-code>" >&2
          echo "" >&2
          echo "examples:" >&2
          echo "  plant github:me/my-app a3f8c2e1" >&2
          echo "  plant silo:my-app a3f8c2e1" >&2
          exit 1
        fi
        if [ -z "$KEY_BLOB" ]; then
          echo "error: key identity not available" >&2
          exit 1
        fi
        RESULT=$($CURL -sf -X POST "$API/plant" \
          -H "Content-Type: application/json" \
          -d "{\"flakeUri\":\"$ARG\",\"inviteCode\":\"$ARG2\",\"keyBlob\":\"$KEY_BLOB\"}") || {
          echo "error: plant failed" >&2
          exit 1
        }
        ERROR=$(echo "$RESULT" | $JQ -r '.error // empty')
        if [ -n "$ERROR" ]; then
          echo "error: $ERROR" >&2
          exit 1
        fi
        echo "$RESULT" | $JQ -r '"planted \(.flakeUri)\n  name: \(.name)\n  namespace: \(.namespace)"'
        ;;

      status)
        require_repos
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
              "\u001b[1;4m\($repo)\u001b[0m",
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
              "\u001b[1;4m\(.repo)\u001b[0m",
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
        require_repos
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
        require_repos
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
        echo "  plant <flake-uri> <code>   register a repo with an invite code"
        echo "  status [repo]              show instance status (default: all repos)"
        echo "  logs <[repo/]instance>     show recent logs (default: 100 lines)"
        echo "  restart <[repo/]instance>  restart an instance"
        echo "  help                       show this help"
        echo ""
        echo "examples:"
        echo "  plant github:me/app a3f8   register with invite code"
        echo "  plant silo:my-app a3f8     register a silo repo"
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

  # NSS catchall: any unknown username resolves to the seed user (uid 1000).
  # This lets `ssh seed.loom.farm` work — the client sends the local login
  # name, and sshd accepts it because getpwnam() succeeds via this module.
  # files is checked first (root, nobody, etc.), seedshell catches the rest.
  system.nssModules = [ nssSeedshell ];
  system.nssDatabases.passwd = lib.mkAfter [ "seedshell" ];

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
      AuthorizedKeysCommand = "/etc/ssh/shell-auth-keys %u %t %k";
      AuthorizedKeysCommandUser = "root";
    };
  };

  # Explicit uid so the NSS module can hardcode it.
  # isNormalUser so PAM account checks pass (isSystemUser lacks /etc/shadow entry).
  # initialHashedPassword unlocks the account (PasswordAuthentication is disabled).
  users.users.seed = {
    isNormalUser = true;
    uid = 1000;
    home = "/home/seed";
    shell = "${shellCmd}/bin/seed-shell";
    initialHashedPassword = "";
  };

  # Install AuthorizedKeysCommand script to /etc/ssh/ where sshd trusts ownership
  environment.etc."ssh/shell-auth-keys" = {
    source = shellAuthKeys;
    mode = "0755";
  };
}
