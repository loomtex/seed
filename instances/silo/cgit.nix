# cgit web interface — read-only browsing with syntax highlighting
#
# Tree-sitter for primary highlighting with language injection support.
# highlight as fallback. cmark for markdown rendering.
{ config, pkgs, lib, reposDir, ... }:

let
  siloUi = import ./ui { inherit pkgs lib; };

  # Use our fork with filename-based injection rules baked in
  tree-sitter-nix-patched = pkgs.tree-sitter-grammars.tree-sitter-nix.overrideAttrs (old: {
    src = pkgs.fetchFromGitHub {
      owner = "nuketownada";
      repo = "tree-sitter-nix";
      rev = "fbe078f";
      hash = "sha256-FQds8dl9Ews7gpigMm7bpp5E8XPk6Tra2+xrwrWsW1A=";
    };
  });

  tsGrammars = with pkgs.tree-sitter-grammars; {
    nix        = { pkg = tree-sitter-nix-patched; exts = [ "nix" ];            injection = "^nix$"; };
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

    # tree-sitter.json metadata (language discovery)
    cat > $DIR/tree-sitter.json << 'TSJSON'
    ${tsJson}
    TSJSON

    # Prebuilt parser from nixpkgs (matches tree-sitter ABI).
    # Symlink works because nix store timestamps are all epoch,
    # so tree-sitter's "is .so newer than source?" check passes.
    ln -s ${grammar}/parser $out/.cache/tree-sitter/lib/${name}.so
  '') tsGrammars));

  tsConfig = pkgs.writeText "ts-config.json" (builtins.toJSON {
    parser-directories = [ "${tsGrammarDir}" ];
  });

  # Source filter — tree-sitter highlighting with language injection
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

  # About filter — renders README on summary pages
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

  # Head include — CSS for tree-sitter + highlight fallback + markdown + line highlighting
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

in {
  environment.etc."cgitrc".source = cgitrc;

  # nginx cgit locations
  services.nginx.virtualHosts."silo.loom.farm" = {
    serverAliases = [ "silo.s-gaydazldmnsg.seed.loom.farm" ];
    enableACME = true;
    forceSSL = true;
    locations."/ui/" = {
      alias = "${siloUi}/";
      extraConfig = ''
        try_files $uri $uri/ /ui/index.html;
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

  services.nginx.enable = true;

  # nginx needs fcgiwrap socket ready
  systemd.services.nginx.after = [ "fcgiwrap.service" ];
  systemd.services.nginx.wants = [ "fcgiwrap.service" ];
}
