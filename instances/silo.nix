# Seed silo instance — git server with cgit web interface
#
# Identity = SSH key. No accounts, no database.
# First push auto-creates a bare repo. ACLs via .authorized_keys in each repo.
# Host key fingerprint published as SSHFP DNS record to PowerDNS.
# cgit provides read-only web browsing with syntax highlighting and markdown rendering.
{ config, pkgs, lib, ... }:

let
  reposDir = "/seed/storage/repos";
  # Dotfile so cgit scan-path skips it (hidden dirs are ignored)
  hostKeyDir = "${reposDir}/.ssh-host-keys";

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

  # SSHFP publishing — posts host key fingerprint to PowerDNS
  publishSshfp = pkgs.writeShellScript "silo-publish-sshfp" ''
    set -euo pipefail

    API_KEY=$(cat ${config.sops.secrets.pdns-api-key.path})
    API="http://dns.s-gaydazldmnsg.svc.cluster.local:8081/api/v1/servers/localhost"

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

  # Post-receive hook — two jobs:
  # 1. Sync .authorized_keys from repo tree → bare repo metadata
  # 2. Webhook to seed-controller for reconciliation
  #
  # Installed at /etc/silo/hooks/ via core.hooksPath — users can't override.
  postReceiveHook = pkgs.writeShellScript "post-receive" ''
    REPO_DIR=$(${pkgs.coreutils}/bin/realpath "$GIT_DIR")
    REPO_NAME=$(${pkgs.coreutils}/bin/basename "$REPO_DIR" .git)
    DEFAULT_BRANCH=$(${pkgs.git}/bin/git -C "$REPO_DIR" symbolic-ref HEAD 2>/dev/null || echo "refs/heads/master")

    # Parse ref updates from stdin — find the default branch push
    HEAD_SHA=""
    while read OLD NEW REF; do
      if [ "$REF" = "$DEFAULT_BRANCH" ]; then
        HEAD_SHA="$NEW"
      fi
    done

    # --- Sync .authorized_keys from tree to bare repo metadata ---
    # Owner key (.owner_key) always grants push regardless.
    # .authorized_keys in the tree is for collaborators — additive only.
    if [ -n "$HEAD_SHA" ] && ${pkgs.git}/bin/git -C "$REPO_DIR" cat-file -e "$HEAD_SHA:.authorized_keys" 2>/dev/null; then
      ${pkgs.git}/bin/git -C "$REPO_DIR" show "$HEAD_SHA:.authorized_keys" > "$REPO_DIR/.authorized_keys"
    fi

    # --- Webhook to seed-controller ---
    SECRET_FILE="/run/secrets/silo-webhook-secret"
    [ ! -f "$SECRET_FILE" ] && exit 0
    SECRET=$(${pkgs.coreutils}/bin/cat "$SECRET_FILE")

    BODY="{\"repository\":{\"full_name\":\"$REPO_NAME\"}}"
    SIGNATURE="sha256=$(${pkgs.coreutils}/bin/printf '%s' "$BODY" | ${pkgs.openssl}/bin/openssl dgst -sha256 -hmac "$SECRET" -hex 2>/dev/null | ${pkgs.gawk}/bin/awk '{print $NF}')"

    ${pkgs.curl}/bin/curl -sf -X POST \
      -H "Content-Type: application/json" \
      -H "X-Hub-Signature-256: $SIGNATURE" \
      -d "$BODY" \
      "http://seed-controller.seed-system.svc.cluster.local:9876/refresh" \
      >/dev/null 2>&1 || true
  '';

  # Tree-sitter grammars for syntax highlighting with language injection
  #
  # Each grammar needs: source (for timestamp checks), prebuilt parser (.so),
  # queries (highlights.scm, injections.scm), and tree-sitter.json metadata.
  # Prebuilt parsers from nixpkgs are used directly (correct ABI) — no gcc
  # needed at runtime. The .so cache uses future timestamps so tree-sitter
  # skips recompilation.
  tsGrammars = with pkgs.tree-sitter-grammars; {
    nix        = { pkg = tree-sitter-nix;        exts = [ "nix" ];            injection = "^nix$"; };
    bash       = { pkg = tree-sitter-bash;       exts = [ "sh" "bash" ];      injection = "^(shell|bash|sh)$"; };
    c          = { pkg = tree-sitter-c;          exts = [ "c" "h" ];          injection = "^c$"; };
    go         = { pkg = tree-sitter-go;         exts = [ "go" ];             injection = "^go$"; };
    rust       = { pkg = tree-sitter-rust;       exts = [ "rs" ];             injection = "^rust$"; };
    python     = { pkg = tree-sitter-python;     exts = [ "py" ];             injection = "^python$"; };
    javascript = { pkg = tree-sitter-javascript; exts = [ "js" "mjs" "cjs" ]; injection = "^(javascript|js)$"; };
    typescript = { pkg = tree-sitter-typescript; exts = [ "ts" ];             injection = "^(typescript|ts)$"; };
    json       = { pkg = tree-sitter-json;       exts = [ "json" ];           injection = "^json$"; };
    toml       = { pkg = tree-sitter-toml;       exts = [ "toml" ];           injection = "^toml$"; };
    yaml       = { pkg = tree-sitter-yaml;       exts = [ "yml" "yaml" ];     injection = "^yaml$"; };
    html       = { pkg = tree-sitter-html;       exts = [ "htm" "html" ];     injection = "^html$"; };
    lua        = { pkg = tree-sitter-lua;        exts = [ "lua" ];            injection = "^lua$"; };
    make       = { pkg = tree-sitter-make;       exts = [ "mk" "Makefile" ];  injection = "^(make|makefile)$"; };
  };

  # Filename-based injection rules for nix indented strings.
  # Appended to the nix grammar's injections.scm so tree-sitter
  # highlights content in: func "file.ext" ''content''
  nixInjectionRules = pkgs.writeText "nix-injection-rules.scm"
    (lib.concatStrings (lib.mapAttrsToList (lang: cfg:
      let extPattern = if builtins.length cfg.exts == 1
        then builtins.head cfg.exts
        else "(${lib.concatStringsSep "|" cfg.exts})";
      in ''

        ((apply_expression
           function: (apply_expression
             argument: (string_expression (string_fragment) @_filename))
           argument: (indented_string_expression (string_fragment) @injection.content))
         (#match? @_filename "\\.${extPattern}$")
         (#set! injection.language "${lang}")
         (#set! injection.combined))
      '') tsGrammars));

  # Assemble grammar directories + prebuilt parser cache
  tsGrammarDir = pkgs.runCommand "ts-grammars" {} (''
    mkdir -p $out/.cache/tree-sitter/lib
  '' + lib.concatStringsSep "\n" (lib.mapAttrsToList (name: cfg: let
    grammar = cfg.pkg;
    tsJson = builtins.toJSON {
      grammars = [{
        inherit name;
        scope = "source.${name}";
        file-types = cfg.exts;
        injection-regex = cfg.injection;
      }];
      metadata = { version = "0.0.0"; license = "MIT"; };
    };
  in ''
    DIR=$out/tree-sitter-${name}
    mkdir -p $DIR/src/tree_sitter $DIR/queries

    # Source files (for tree-sitter timestamp comparison only)
    for f in ${grammar.src}/src/*.c ${grammar.src}/src/*.h; do
      [ -e "$f" ] && ln -s "$f" $DIR/src/
    done
    for f in ${grammar.src}/src/tree_sitter/*; do
      [ -e "$f" ] && ln -s "$f" $DIR/src/tree_sitter/
    done
    ln -s ${grammar.src}/src/grammar.json $DIR/src/grammar.json
    ln -s ${grammar.src}/src/node-types.json $DIR/src/node-types.json

    # Highlight + injection queries
    for f in ${grammar}/queries/*; do ln -s "$f" $DIR/queries/; done

    # Append filename-based injection rules for nix indented strings.
    # Generated from tsGrammars — any grammar with file extensions gets
    # an injection rule matching that extension in nix string arguments.
    if [ "$name" = "nix" ]; then
      rm $DIR/queries/injections.scm
      cp ${grammar}/queries/injections.scm $DIR/queries/injections.scm
      cat >> $DIR/queries/injections.scm < ${nixInjectionRules}
    fi

    # tree-sitter.json metadata (language discovery)
    cat > $DIR/tree-sitter.json << 'TSJSON'
    ${tsJson}
    TSJSON

    # Prebuilt parser from nixpkgs (matches tree-sitter ABI)
    cp ${grammar}/parser $out/.cache/tree-sitter/lib/${name}.so
    # Future timestamp so tree-sitter skips recompilation
    touch -t 203001010000 $out/.cache/tree-sitter/lib/${name}.so
  '') tsGrammars));

  tsConfig = pkgs.writeText "ts-config.json" (builtins.toJSON {
    parser-directories = [ "${tsGrammarDir}" ];
  });

  # cgit source-filter — tree-sitter highlighting with language injection
  siloSourceFilter = pkgs.writeShellScript "silo-source-filter" ''
    FILENAME="$1"

    case "$FILENAME" in
      *.md|*.markdown|*.mdown)
        echo "<div class=\"markdown-body\">"
        ${pkgs.cmark}/bin/cmark
        echo "</div>"
        exit 0
        ;;
    esac

    # Point tree-sitter at prebuilt parser cache
    export HOME="/tmp/ts-home"
    if [ ! -d "$HOME/.cache/tree-sitter/lib" ]; then
      ${pkgs.coreutils}/bin/mkdir -p "$HOME/.cache/tree-sitter"
      ${pkgs.coreutils}/bin/ln -sfn ${tsGrammarDir}/.cache/tree-sitter/lib "$HOME/.cache/tree-sitter/lib"
    fi

    # Write stdin to temp file with correct extension
    EXTENSION="''${FILENAME##*.}"
    TMPFILE="/tmp/cgit-ts-$$.$EXTENSION"
    ${pkgs.coreutils}/bin/cat > "$TMPFILE"
    trap '${pkgs.coreutils}/bin/rm -f "$TMPFILE"' EXIT

    # Run tree-sitter, extract highlighted lines (strip HTML document wrapper)
    # tree-sitter outputs: <tr><td class=line-number>N</td><td class=line>CONTENT\n</td></tr>
    # spanning two lines — delete the </td></tr> lines and strip the <tr><td> prefix
    if OUTPUT=$(${pkgs.tree-sitter}/bin/tree-sitter highlight --html --css-classes \
        --config-path ${tsConfig} "$TMPFILE" 2>/dev/null); then
      echo "$OUTPUT" | ${pkgs.gnused}/bin/sed -n '/<table>/,/<\/table>/{ /<\/*table>/d; /<\/td><\/tr>/d; s/<tr><td class=line-number>[0-9]*<\/td><td class=line>//; p; }'
    else
      # Fallback to highlight for unsupported languages
      ${pkgs.highlight}/bin/highlight --force -f -I -O xhtml -S "$EXTENSION" < "$TMPFILE" 2>/dev/null \
        || ${pkgs.coreutils}/bin/cat "$TMPFILE"
    fi
  '';

  # cgit about-filter — renders README on summary pages
  siloAboutFilter = pkgs.writeShellScript "silo-about-filter" ''
    FILENAME="$1"
    case "$FILENAME" in
      *.md|*.markdown|*.mdown)
        echo "<div class=\"markdown-body\">"
        ${pkgs.cmark}/bin/cmark
        echo "</div>"
        ;;
      *.htm|*.html)
        ${pkgs.coreutils}/bin/cat
        ;;
      *)
        echo "<pre>"
        ${pkgs.coreutils}/bin/cat | ${pkgs.gnused}/bin/sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
        echo "</pre>"
        ;;
    esac
  '';

  # cgit head-include — CSS for tree-sitter + highlight fallback + markdown
  cgitHeadInclude = pkgs.writeText "cgit-head-include.html" ''
    <style>
      /* tree-sitter highlight classes */
      .keyword { color: #5f00d7; }
      .string { color: #008700; }
      .string.special { color: #008787; }
      .function { color: #005fd7; }
      .function.builtin { font-weight: bold; color: #005fd7; }
      .variable { color: #383a42; }
      .variable.builtin { font-weight: bold; color: #383a42; }
      .variable.parameter { text-decoration: underline; color: #383a42; }
      .comment { font-style: italic; color: #8a8a8a; }
      .constant { color: #875f00; }
      .constant.builtin { font-weight: bold; color: #875f00; }
      .number { font-weight: bold; color: #875f00; }
      .operator { font-weight: bold; color: #4e4e4e; }
      .punctuation { color: #4e4e4e; }
      .punctuation.bracket { color: #4e4e4e; }
      .punctuation.delimiter { color: #4e4e4e; }
      .punctuation.special { color: #4e4e4e; }
      .type { color: #005f5f; }
      .type.builtin { font-weight: bold; color: #005f5f; }
      .constructor { color: #af8700; }
      .module { color: #af8700; }
      .property { color: #af0000; }
      .property.builtin { font-weight: bold; color: #af0000; }
      .attribute { font-style: italic; color: #af0000; }
      .tag { color: #000087; }
      .embedded { color: #383a42; }

      /* highlight v4 fallback classes */
      .hl.num { color: #875f00; }
      .hl.str { color: #008700; }
      .hl.kwa { color: #5f00d7; font-weight: bold; }
      .hl.kwb { color: #005f5f; }
      .hl.kwc { color: #005fd7; }
      .hl.kwd { color: #af8700; }
      .hl.slc, .hl.com { color: #8a8a8a; font-style: italic; }
      .hl.opt { color: #4e4e4e; }
      .hl.ppc { color: #af0000; }

      /* markdown-body */
      .markdown-body { max-width: 900px; line-height: 1.6; font-size: 14px; }
      .markdown-body h1 { font-size: 1.8em; border-bottom: 1px solid #ddd; padding-bottom: .3em; }
      .markdown-body h2 { font-size: 1.4em; border-bottom: 1px solid #eee; padding-bottom: .3em; }
      .markdown-body h3 { font-size: 1.2em; }
      .markdown-body code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 90%; }
      .markdown-body pre { background: #f4f4f4; padding: 12px; border-radius: 4px; overflow-x: auto; }
      .markdown-body pre code { background: none; padding: 0; }
      .markdown-body blockquote { border-left: 4px solid #ddd; margin: 0; padding: 0 1em; color: #666; }
      .markdown-body table { border-collapse: collapse; }
      .markdown-body td, .markdown-body th { border: 1px solid #ddd; padding: 6px 12px; }
      .markdown-body th { background: #f4f4f4; }
      .markdown-body img { max-width: 100%; }

      /* line highlighting */
      .linenumbers a.line-hl { background: #fff5b1; color: rgba(27,31,35,.6); }
      .lines .line-hl { background: #fffbdd; display: block; }
    </style>
    <script>
    (function() {
      var wrapped = false;
      function wrapLines() {
        if (wrapped) return;
        var code = document.querySelector('table.blob td.lines pre code');
        if (!code) return;
        wrapped = true;
        var html = code.innerHTML;
        if (html.charAt(html.length - 1) === '\n') html = html.slice(0, -1);
        var lines = html.split('\n');
        code.innerHTML = lines.map(function(l, i) {
          return '<span class="code-line" data-line="' + (i + 1) + '">' + l + '\n</span>';
        }).join(''');
      }
      function highlight() {
        wrapLines();
        document.querySelectorAll('.line-hl').forEach(function(el) {
          el.classList.remove('line-hl');
        });
        var h = location.hash.substring(1);
        if (!h) return;
        var m = h.match(/^n(\d+)(?:-n(\d+))?$/);
        if (!m) return;
        var start = parseInt(m[1], 10);
        var end = m[2] ? parseInt(m[2], 10) : start;
        if (end < start) { var t = start; start = end; end = t; }
        for (var i = start; i <= end; i++) {
          var a = document.getElementById('n' + i);
          if (a) a.classList.add('line-hl');
          var span = document.querySelector('.code-line[data-line="' + i + '"]');
          if (span) span.classList.add('line-hl');
        }
      }
      function clickHandler(e) {
        var a = e.target.closest('td.linenumbers a');
        if (!a) return;
        var id = a.id;
        if (!id || !/^n\d+$/.test(id)) return;
        if (e.shiftKey && location.hash) {
          var prev = location.hash.substring(1).match(/^n(\d+)/);
          if (prev) {
            e.preventDefault();
            location.hash = '#' + prev[0] + '-' + id;
            return;
          }
        }
      }
      document.addEventListener('DOMContentLoaded', highlight);
      window.addEventListener('hashchange', highlight);
      document.addEventListener('click', clickHandler);
    })();
    </script>
  '';

  # cgitrc configuration
  # NOTE: scan-path must be LAST — cgit processes it immediately using
  # only the settings defined above it in the file.
  cgitrc = pkgs.writeText "cgitrc" ''
    virtual-root=/
    css=/cgit-data/cgit.css
    logo=/cgit-data/cgit.png
    remove-suffix=1
    clone-url=ssh://git@silo.loom.farm/$CGIT_REPO_URL
    source-filter=${siloSourceFilter}
    about-filter=${siloAboutFilter}
    head-include=${cgitHeadInclude}
    readme=:README.md
    readme=:readme.md
    enable-blame=1
    enable-log-filecount=1
    enable-commit-graph=1
    enable-http-clone=0
    cache-size=0
    scan-path=${reposDir}
  '';

  # CGI script for git archive over HTTP
  #
  # Serves tarballs at /<repo>/archive/<ref>.tar.gz
  # Returns a Link header with immutable URL (pinned to commit SHA) + lastModified
  # so nix can cache and content-address the tarball.
  siloArchiveCgi = pkgs.writeShellScript "silo-archive-cgi" ''
    set -euo pipefail

    # Parse REQUEST_URI: /<repo>/archive/<ref>.tar.gz
    if ! echo "$REQUEST_URI" | ${pkgs.gnugrep}/bin/grep -qE '^/[^/]+/archive/[^/]+\.tar\.gz(\?.*)?$'; then
      echo "Status: 404"
      echo "Content-Type: text/plain"
      echo ""
      echo "Not found"
      exit 0
    fi

    REPO=$(echo "$REQUEST_URI" | ${pkgs.coreutils}/bin/cut -d/ -f2)
    REF=$(echo "$REQUEST_URI" | ${pkgs.coreutils}/bin/cut -d/ -f4 | ${pkgs.gnused}/bin/sed 's/\.tar\.gz.*//')

    # Sanitize
    case "$REPO" in *..* | */*) echo "Status: 400"; echo ""; exit 0;; esac
    case "$REF" in *..*) echo "Status: 400"; echo ""; exit 0;; esac

    REPO_PATH="${reposDir}/$REPO.git"
    if [ ! -d "$REPO_PATH" ]; then
      echo "Status: 404"
      echo "Content-Type: text/plain"
      echo ""
      echo "Repository not found"
      exit 0
    fi

    # Resolve ref to SHA
    SHA=$(${pkgs.git}/bin/git -C "$REPO_PATH" rev-parse --verify "$REF" 2>/dev/null) || {
      echo "Status: 404"
      echo "Content-Type: text/plain"
      echo ""
      echo "Ref not found: $REF"
      exit 0
    }

    # Get last modified timestamp
    LAST_MODIFIED=$(${pkgs.git}/bin/git -C "$REPO_PATH" log -1 --format=%ct "$SHA")

    # Link header: immutable URL pinned to commit SHA
    echo "Status: 200"
    echo "Content-Type: application/gzip"
    echo "Link: <https://''${HTTP_HOST:-silo.loom.farm}/$REPO/archive/$SHA.tar.gz?lastModified=$LAST_MODIFIED>; rel=\"immutable\""
    echo ""

    # Stream tarball
    exec ${pkgs.git}/bin/git -C "$REPO_PATH" archive --format=tar.gz --prefix=source/ "$SHA"
  '';

in {
  seed.expose.ssh.enable = true;
  seed.expose.https.enable = true;
  seed.expose.http.enable = true;
  seed.dns.names = [ "silo.loom.farm" ];
  seed.storage.repos = "10Gi";
  seed.storage.acme = { size = "100Mi"; mountPoint = "/var/lib/acme"; };
  seed.shoot.enable = true;

  # sops-nix secrets
  sops.defaultSopsFile = ../secrets/silo.yaml;
  sops.secrets.pdns-api-key = {};
  sops.secrets.silo-webhook-secret = { owner = "git"; };

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
  users.groups.git = {};

  # Ensure correct user owns the persistent dirs
  systemd.tmpfiles.rules = [
    "d ${reposDir} 0755 git git -"
    "d ${hostKeyDir} 0700 root root -"
    # Remove lost+found — ext4 creates it but cgit scan-path errors on it
    "R ${reposDir}/lost+found -"
  ];

  # Migrate ssh-host-keys to dotfile path (one-time, idempotent)
  systemd.services.silo-migrate-hostkeys = {
    description = "Migrate SSH host keys to hidden directory";
    wantedBy = [ "multi-user.target" ];
    before = [ "sshd.service" "sshd-keygen.service" ];
    unitConfig.ConditionPathIsDirectory = "${reposDir}/ssh-host-keys";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = pkgs.writeShellScript "migrate-hostkeys" ''
        # Move old visible dir to new hidden dir
        if [ -d "${reposDir}/ssh-host-keys" ] && [ ! -d "${hostKeyDir}" ]; then
          mv "${reposDir}/ssh-host-keys" "${hostKeyDir}"
        elif [ -d "${reposDir}/ssh-host-keys" ] && [ -d "${hostKeyDir}" ]; then
          # Both exist — copy any missing keys, remove old dir
          cp -n "${reposDir}/ssh-host-keys/"* "${hostKeyDir}/" 2>/dev/null || true
          rm -rf "${reposDir}/ssh-host-keys"
        fi
      '';
    };
  };

  # Extra sshd settings on top of what seed.sshAuth provides
  services.openssh = {
    ports = [ 22 ];
    # Persist host keys in PVC
    hostKeys = [
      { path = "${hostKeyDir}/ssh_host_ed25519_key"; type = "ed25519"; }
      { path = "${hostKeyDir}/ssh_host_rsa_key"; type = "rsa"; bits = 4096; }
    ];
  };


  networking.firewall.allowedTCPPorts = [ 22 80 443 ];

  environment.systemPackages = [ pkgs.git pkgs.openssl siloShell ];

  # Global git hooks — all repos use the shared hooks directory
  environment.etc."gitconfig".text = ''
    [core]
      hooksPath = /etc/silo/hooks
  '';
  environment.etc."cgitrc".source = cgitrc;
  environment.etc."silo/hooks/post-receive" = {
    source = postReceiveHook;
    mode = "0755";
  };

  # Force host key generation on boot (startWhenNeeded=true defers it to first connection)
  systemd.services.sshd-keygen.wantedBy = [ "multi-user.target" ];

  # fcgiwrap — FastCGI wrapper for the archive CGI script
  # Runs as git:nginx so nginx can connect to the socket
  systemd.services.fcgiwrap = {
    description = "FastCGI wrapper for git archive and cgit";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    serviceConfig = {
      ExecStart = "${pkgs.fcgiwrap}/sbin/fcgiwrap -s unix:/run/fcgiwrap/fcgiwrap.sock";
      User = "git";
      Group = "nginx";
      RuntimeDirectory = "fcgiwrap";
      RuntimeDirectoryMode = "0750";
      UMask = "0007";
    };
  };

  # nginx — TLS frontend + cgit web interface + git archive tarballs via fcgiwrap
  services.nginx = {
    enable = true;
    virtualHosts."silo.loom.farm" = {
      serverAliases = [ "silo.s-gaydazldmnsg.seed.loom.farm" ];
      enableACME = true;
      forceSSL = true;
      locations."~ ^/([^/]+)/archive/([^/]+)\\.tar\\.gz$" = {
        extraConfig = ''
          include ${pkgs.nginx}/conf/fastcgi_params;
          fastcgi_param SCRIPT_FILENAME "${siloArchiveCgi}";
          fastcgi_param REQUEST_URI $request_uri;
          fastcgi_pass unix:/run/fcgiwrap/fcgiwrap.sock;
        '';
      };
      locations."/cgit-data/" = {
        alias = "${pkgs.cgit}/cgit/";
      };
      locations."/" = {
        extraConfig = ''
          include ${pkgs.nginx}/conf/fastcgi_params;
          fastcgi_param SCRIPT_FILENAME "${pkgs.cgit}/cgit/cgit.cgi";
          fastcgi_param SCRIPT_NAME "";
          fastcgi_param PATH_INFO $uri;
          fastcgi_param QUERY_STRING $query_string;
          fastcgi_param HTTP_HOST $server_name;
          fastcgi_pass unix:/run/fcgiwrap/fcgiwrap.sock;
        '';
      };
    };
  };

  # nginx needs fcgiwrap socket ready
  systemd.services.nginx.after = [ "fcgiwrap.service" ];
  systemd.services.nginx.wants = [ "fcgiwrap.service" ];

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
