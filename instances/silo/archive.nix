# Git archive over HTTP — serves tarballs via CGI
#
# /<repo>/archive/<ref>.tar.gz
# Returns Link header with immutable URL (pinned to commit SHA) + lastModified
# so nix can cache and content-address the tarball.
{ config, pkgs, lib, reposDir, ... }:

let
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

  # nginx archive location
  services.nginx.virtualHosts."silo.loom.farm" = {
    locations."~ ^/([^/]+)/archive/([^/]+)\\.tar\\.gz$" = {
      extraConfig = ''
        include ${pkgs.nginx}/conf/fastcgi_params;
        fastcgi_param SCRIPT_FILENAME "${siloArchiveCgi}";
        fastcgi_param REQUEST_URI $request_uri;
        fastcgi_pass unix:/run/fcgiwrap/fcgiwrap.sock;
      '';
    };
  };
}
