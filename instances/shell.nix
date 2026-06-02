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
  controllerApi = "https://seed-controller.seed-system.svc.cluster.local:9876";

  # TUI — interactive terminal dashboard (Go + bubbletea)
  seedTui = pkgs.buildGoModule {
    pname = "seed-tui";
    version = "0.1.0";
    src = ./shell-tui;
    vendorHash = "sha256-YSjJ8NOL97hXZLnfGYIjoKmARv+gWOsv+5qkl9konnA=";
  };

  # Auth-keys hook: look up the connecting key in the controller's key index
  # and output an extra environment= directive with the repo list.
  # Called by seed.sshAuth with $1=KEY_TYPE $2=KEY_BLOB.
  shellAuthHook = pkgs.writeShellScript "shell-auth-hook" ''
    KEY_TYPE="$1"
    KEY_BLOB="$2"
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
         | map("\(.name)=\(.namespace)=\(.identity // "")") | join(",")')
    fi

    # Output extra environment= directive for authorized_keys line
    echo "environment=\"SEED_REPOS=$REPOS\""
  '';

  # seed-shell — forced command for management operations
  #
  # SEED_REPOS env var format: "seed=s-gaydazldmnsg,shoot-demo=s-mfstazlgmy2g"
  # SEED_KEY_TYPE/SEED_KEY_BLOB: SSH key identity (always set)
  # Instance targeting: bare "web" (auto-resolve) or "seed/web" (explicit repo)
  shellCmd = pkgs.writeShellApplication {
    name = "seed-shell";
    runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ];
    text = ''
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

    # Parse SEED_REPOS into parallel arrays: REPO_NAMES, REPO_NS, REPO_IDENTITY
    # Format: name=namespace=identity (3-part), or name=namespace (2-part legacy)
    declare -a REPO_NAMES=()
    declare -a REPO_NS=()
    declare -a REPO_IDENTITY=()
    if [ -n "$REPOS_RAW" ]; then
      IFS=',' read -ra PAIRS <<< "$REPOS_RAW"
      for pair in "''${PAIRS[@]}"; do
        # Split on '=' — name=namespace=identity
        IFS='=' read -r _name _ns _id <<< "$pair"
        REPO_NAMES+=("$_name")
        REPO_NS+=("$_ns")
        REPO_IDENTITY+=("''${_id:-}")
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
        result=$(curl -sf "$API/ns/$ns/status" 2>/dev/null) || continue
        if echo "$result" | jq -e --arg inst "$arg" '.instances[$inst]' >/dev/null 2>&1; then
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

    # Interactive TUI: if no command given and TTY is allocated, launch TUI
    if [ -z "''${SSH_ORIGINAL_COMMAND:-}" ] && [ -t 0 ] && [ -n "$REPOS_RAW" ]; then
      export SEED_API_URL="${controllerApi}"
      export SEED_REPOS="$REPOS_RAW"
      exec ${seedTui}/bin/tui
    fi

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
    WATCH=0

    ARG3=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --json)   JSON_OUT=true ;;
        --follow) FOLLOW=true ;;
        -f)       FOLLOW=true ;;
        --lines)  shift; LINES="''${1:-}" ;;
        --watch|-w) WATCH="''${2:-5}"; shift ;;
        *)        if [ -z "$ARG" ]; then ARG="$1"; elif [ -z "$ARG2" ]; then ARG2="$1"; elif [ -z "$ARG3" ]; then ARG3="$1"; fi ;;
      esac
      shift
    done

    case "$ACTION" in
      plant)
        if [ -z "$ARG" ] || [ -z "$ARG2" ]; then
          echo "usage: plant <flake-uri> <invite-code> [<signature>]" >&2
          echo "" >&2
          echo "examples:" >&2
          echo "  plant github:me/my-app a3f8c2e1" >&2
          echo "  plant silo:my-app a3f8c2e1" >&2
          echo "  plant silo:my-app a3f8c2e1 <base64-ssh-signature>" >&2
          exit 1
        fi
        if [ -z "$KEY_BLOB" ]; then
          echo "error: key identity not available" >&2
          exit 1
        fi
        # Build JSON payload — include signature if provided
        PLANT_JSON="{\"flakeUri\":\"$ARG\",\"inviteCode\":\"$ARG2\",\"keyBlob\":\"$KEY_BLOB\""
        if [ -n "$ARG3" ]; then
          PLANT_JSON="$PLANT_JSON,\"signature\":\"$ARG3\""
        fi
        PLANT_JSON="$PLANT_JSON}"
        RESULT=$(curl -sf -X POST "$API/plant" \
          -H "Content-Type: application/json" \
          -d "$PLANT_JSON") || {
          echo "error: plant failed" >&2
          exit 1
        }
        ERROR=$(echo "$RESULT" | jq -r '.error // empty')
        if [ -n "$ERROR" ]; then
          echo "error: $ERROR" >&2
          exit 1
        fi
        echo "$RESULT" | jq -r '"planted \(.flakeUri)\n  name: \(.name)\n  namespace: \(.namespace)" + (if .identity != "" then "\n  identity: \(.identity)" else "" end)'
        ;;

      replant)
        if [ -z "$ARG" ] || [ -z "$ARG2" ]; then
          echo "usage: replant <identity-cid> <new-flake-uri>" >&2
          echo "" >&2
          echo "change the source URI for an identity-based repo." >&2
          echo "your SSH key must be in .authorized_keys of the new repo," >&2
          echo "and the new repo must have the same .seed-identity file." >&2
          echo "" >&2
          echo "examples:" >&2
          echo "  replant k51qzi5... silo:my-app" >&2
          echo "  replant k51qzi5... github:me/my-app" >&2
          exit 1
        fi
        if [ -z "$KEY_BLOB" ]; then
          echo "error: key identity not available" >&2
          exit 1
        fi
        RESULT=$(curl -sf -X POST "$API/replant" \
          -H "Content-Type: application/json" \
          -d "{\"identity\":\"$ARG\",\"newFlakeUri\":\"$ARG2\",\"keyBlob\":\"$KEY_BLOB\"}") || {
          echo "error: replant failed" >&2
          exit 1
        }
        ERROR=$(echo "$RESULT" | jq -r '.error // empty')
        if [ -n "$ERROR" ]; then
          echo "error: $ERROR" >&2
          exit 1
        fi
        echo "$RESULT" | jq -r '"replanted → \(.flakeUri)\n  name: \(.name)\n  namespace: \(.namespace)\n  identity: \(.identity)"'
        ;;

      status)
        require_repos
        while true; do
          if [ "$WATCH" -gt 0 ]; then
            printf '\033[2J\033[H'
            printf '\033[2mEvery %ss — %s\033[0m\n\n' "$WATCH" "$(date +%T)"
          fi

          if [ -n "$ARG" ]; then
            # Status for a specific repo
            NS=$(resolve_repo "$ARG") || exit 1
            RESULT=$(curl -sf "$API/ns/$NS/status") || {
              echo "error: failed to fetch status for $ARG" >&2
              [ "$WATCH" -gt 0 ] && { sleep "$WATCH"; continue; }
              exit 1
            }
            if [ "$JSON_OUT" = true ]; then
              echo "$RESULT" | jq .
            else
              # Look up identity for this repo
              IDENTITY=""
              for i in "''${!REPO_NAMES[@]}"; do
                if [ "''${REPO_NAMES[$i]}" = "$ARG" ]; then
                  IDENTITY="''${REPO_IDENTITY[$i]:-}"
                  break
                fi
              done
              echo "$RESULT" | jq -r --arg repo "$ARG" --arg id "$IDENTITY" '
                .namespace as $ns |
                (.reconcile.commit // "") as $commit |
                "\u001b[1;4m\($repo)\u001b[0m" +
                  (if $commit != "" then " \u001b[2m(\($commit))\u001b[0m" else "" end) +
                  "  \u001b[2m\($ns)\u001b[0m" +
                  (if $id != "" then "  \u001b[2m\($id)\u001b[0m" else "" end),
                (.instances | to_entries[] |
                  "  \u001b[1m\(.key)\u001b[0m " +
                  (if .value.ready then "\u001b[32m●\u001b[0m " else "\u001b[31m●\u001b[0m " end) +
                  (if .value.ready then "\u001b[32mready\u001b[0m" else "\u001b[31mnot ready\u001b[0m" end) +
                  "  phase=\(.value.phase)" +
                  "  restarts=\(.value.restarts)" +
                  "  age=\(.value.age)"
                ),
                (if .reconcile then
                  if .reconcile.phase == "failed" then
                    "\n  \u001b[31mBuild \(.reconcile.buildCommit // "?") failed:\u001b[0m \(.reconcile.error)"
                  elif .reconcile.phase == "building" or .reconcile.phase == "evaluating" or .reconcile.phase == "applying" then
                    "\n  \u001b[33m⧗ \(.reconcile.phase) \(.reconcile.buildCommit // "")\u001b[0m" +
                    ([.reconcile.instances | to_entries[] | select(.value.phase == "building") | .key] |
                      if length > 0 then " — building: \(join(", "))" else "" end)
                  else empty end
                else empty end),
                ""'
            fi
          else
            # Status for all repos — build identity map as JSON for jq
            ALL_JSON="[]"
            ID_JSON="{}"
            for i in "''${!REPO_NAMES[@]}"; do
              REPO="''${REPO_NAMES[$i]}"
              NS="''${REPO_NS[$i]}"
              id="''${REPO_IDENTITY[$i]:-}"
              [ -n "$id" ] && ID_JSON=$(echo "$ID_JSON" | jq --arg repo "$REPO" --arg id "$id" '. + {($repo): $id}')
              RESULT=$(curl -sf "$API/ns/$NS/status" 2>/dev/null) || continue
              ALL_JSON=$(echo "$ALL_JSON" | jq --arg repo "$REPO" --argjson result "$RESULT" \
                '. + [{ repo: $repo, data: $result }]')
            done

            if [ "$JSON_OUT" = true ]; then
              echo "$ALL_JSON" | jq .
            else
              echo "$ALL_JSON" | jq -r --argjson ids "$ID_JSON" '.[] |
                .data.namespace as $ns |
                .repo as $repo |
                (.data.reconcile.commit // "") as $commit |
                "\u001b[1;4m\($repo)\u001b[0m" +
                  (if $commit != "" then " \u001b[2m(\($commit))\u001b[0m" else "" end) +
                  "  \u001b[2m\($ns)\u001b[0m" +
                  (if $ids[$repo] then "  \u001b[2m\($ids[$repo])\u001b[0m" else "" end),
                (.data.instances | to_entries[] |
                  "  \u001b[1m\(.key)\u001b[0m " +
                  (if .value.ready then "\u001b[32m●\u001b[0m " else "\u001b[31m●\u001b[0m " end) +
                  (if .value.ready then "\u001b[32mready\u001b[0m" else "\u001b[31mnot ready\u001b[0m" end) +
                  "  phase=\(.value.phase)" +
                  "  restarts=\(.value.restarts)" +
                  "  age=\(.value.age)"
                ),
                (if .data.reconcile then
                  if .data.reconcile.phase == "failed" then
                    "\n  \u001b[31mBuild \(.data.reconcile.buildCommit // "?") failed:\u001b[0m \(.data.reconcile.error)"
                  elif .data.reconcile.phase == "building" or .data.reconcile.phase == "evaluating" or .data.reconcile.phase == "applying" then
                    "\n  \u001b[33m⧗ \(.data.reconcile.phase) \(.data.reconcile.buildCommit // "")\u001b[0m" +
                    ([.data.reconcile.instances | to_entries[] | select(.value.phase == "building") | .key] |
                      if length > 0 then " — building: \(join(", "))" else "" end)
                  else empty end
                else empty end),
                ""'
            fi
          fi

          [ "$WATCH" -eq 0 ] && break
          sleep "$WATCH"
        done
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
          curl -sfN "$LOG_URL" | while IFS= read -r line; do
            case "$line" in
              data:\ *)
                DATA="''${line#data: }"
                if [ "$JSON_OUT" = true ]; then
                  echo "$DATA"
                else
                  echo "$DATA" | jq -r '
                    (if (.ts // "") != "" then "\u001b[2m" + (.ts[5:19] | gsub("T"; " ")) + "\u001b[0m " else "" end) +
                    ((.msg // .line) |
                      if test(":") then
                        "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
                      else . end)'
                fi
                ;;
            esac
          done
        else
          RESULT=$(curl -sf "$LOG_URL") || {
            echo "error: failed to fetch logs for $RESOLVED_INSTANCE" >&2
            exit 1
          }
          if [ "$JSON_OUT" = true ]; then
            echo "$RESULT" | jq .
          else
            echo "$RESULT" | jq -r '.lines[] |
              # Object shape is {ts,msg}; tolerate the old bare-string shape too.
              (if type == "object" then . else {ts:"", msg:.} end) |
              (if (.ts // "") != "" then "\u001b[2m" + (.ts[5:19] | gsub("T"; " ")) + "\u001b[0m " else "" end) +
              (.msg |
                if test(":") then
                  "\u001b[36m" + split(":")[0] + ":\u001b[0m" + (split(":")[1:] | join(":"))
                else . end)'
            NOTE=$(echo "$RESULT" | jq -r '.note // empty')
            if [ -n "$NOTE" ]; then
              printf '\033[33mnote: %s\033[0m\n' "$NOTE" >&2
            fi
          fi
        fi
        ;;

      build-log)
        require_repos
        # build-log [repo] [--instance NAME]
        # If ARG looks like a repo, use it; otherwise treat as instance filter
        BLOG_REPO=""
        BLOG_INSTANCE=""
        if [ -n "$ARG" ]; then
          # Check if it's a known repo name
          FOUND=false
          for i in "''${!REPO_NAMES[@]}"; do
            if [ "''${REPO_NAMES[$i]}" = "$ARG" ]; then
              FOUND=true
              break
            fi
          done
          if [ "$FOUND" = true ]; then
            BLOG_REPO="$ARG"
            BLOG_INSTANCE="''${ARG2:-}"
          else
            # Not a repo — treat as instance filter on first/only repo
            BLOG_INSTANCE="$ARG"
          fi
        fi

        # If no repo specified and only one repo, use it
        if [ -z "$BLOG_REPO" ] && [ ''${#REPO_NAMES[@]} -eq 1 ]; then
          BLOG_REPO="''${REPO_NAMES[0]}"
        elif [ -z "$BLOG_REPO" ]; then
          echo "error: multiple repos — specify which one: build-log <repo> [instance]" >&2
          echo "available: ''${REPO_NAMES[*]}" >&2
          exit 1
        fi

        NS=$(resolve_repo "$BLOG_REPO") || exit 1
        BLOG_URL="$API/ns/$NS/build-log"
        [ -n "$BLOG_INSTANCE" ] && BLOG_URL="$BLOG_URL?instance=$BLOG_INSTANCE"

        RESULT=$(curl -sf "$BLOG_URL") || {
          echo "error: failed to fetch build logs" >&2
          exit 1
        }

        if [ "$JSON_OUT" = true ]; then
          echo "$RESULT" | jq .
        else
          FAILED=$(echo "$RESULT" | jq -r '.failed')
          SOURCE=$(echo "$RESULT" | jq -r '.source')

          # Without an instance filter, only show logs on failure
          if [ -z "$BLOG_INSTANCE" ] && [ "$FAILED" != "true" ]; then
            printf '\033[2mlast build succeeded — specify an instance to view logs\033[0m\n'
          else
            [ "$SOURCE" = "cached" ] && printf '\033[2m(cached from last build)\033[0m\n'
            echo "$RESULT" | jq -r '.builds[] |
              "\u001b[1;4m\(.name)\u001b[0m",
              (.lines[] | "  \(.)"),
              ""'
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
        RESULT=$(curl -sf -X POST "$API/ns/$RESOLVED_NS/restart/$RESOLVED_INSTANCE") || {
          echo "error: failed to restart $RESOLVED_INSTANCE" >&2
          exit 1
        }
        echo "$RESULT" | jq -r '"restarted \(.instance) (pod \(.pod))"'
        ;;

      keys)
        require_repos
        if [ -z "$ARG" ]; then
          echo "usage: keys <[repo/]instance>" >&2
          exit 1
        fi
        resolve_instance "$ARG"
        RESULT=$(curl -sf "$API/ns/$RESOLVED_NS/keys/$RESOLVED_INSTANCE") || {
          echo "error: failed to fetch keys for $RESOLVED_INSTANCE" >&2
          exit 1
        }
        ERROR=$(echo "$RESULT" | jq -r '.error // empty')
        if [ -n "$ERROR" ]; then
          echo "error: $ERROR" >&2
          exit 1
        fi
        if [ "$JSON_OUT" = true ]; then
          echo "$RESULT" | jq .
        else
          echo "$RESULT" | jq -r '"age recipient for \(.instance):\n  \(.publicKey)"'
        fi
        ;;

      help|--help|-h)
        echo "seed shell — manage your seed instances"
        echo ""
        echo "commands:"
        echo "  plant <flake-uri> <code> [sig]  register a repo with an invite code"
        echo "  replant <identity> <new-uri>    change source URI (identity preserved)"
        echo "  status [repo] [-w N]            show instance status (default: all repos)"
        echo "  logs <[repo/]instance>          show recent logs (default: 100 lines)"
        echo "  build-log [repo] [instance]     show nix build output (failures only without instance)"
        echo "  restart <[repo/]instance>       restart an instance"
        echo "  keys <[repo/]instance>          show age public key (for sops encryption)"
        echo "  help                            show this help"
        echo ""
        echo "examples:"
        echo "  plant github:me/app a3f8        register with invite code"
        echo "  plant silo:my-app a3f8 <sig>    register with identity signature"
        echo "  replant k51qzi5... silo:my-app  change source URI"
        echo "  status                          status of all repos"
        echo "  status seed                     status of the 'seed' repo"
        echo "  logs web                        logs for 'web' (auto-resolves repo)"
        echo "  logs seed/web -f                follow logs for 'web' in 'seed' repo"
        echo "  build-log seed                  build output for all instances"
        echo "  build-log seed silo             build output for silo only"
        echo "  restart shoot-demo/shoot-demo"
        echo "  keys web                        age public key for sops encryption"
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
  };

in
{
  seed.expose.ssh.enable = true;
  seed.dns.names = [ "seed.loom.farm" ];

  environment.systemPackages = [ shellCmd ];

  # sshd chdir's to the user's home before running the forced command.
  # The NSS module advertises /home/seed but nothing creates it.
  systemd.tmpfiles.rules = [ "d /home/seed 0755 seed users -" ];

  seed.sshAuth = {
    enable = true;
    uid = 1000;
    gid = 100;
    home = "/home/seed";
    shell = "/run/current-system/sw/bin/seed-shell";
    userName = "seed";
    nssName = "seedshell";
    forcedCommand = "seed-shell";
    envPrefix = "SEED";
    authKeysHook = shellAuthHook;
  };
}
