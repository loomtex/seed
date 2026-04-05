# Git smart HTTP — browser push/fetch via git-http-backend
#
# Reads (clone/fetch) are open. Writes (push) require a SiloKey
# Authorization header, verified by silo-auth-verify via nginx auth_request.
# The verified key blob is passed to git-http-backend as REMOTE_USER,
# where the pre-receive hook can use it for CODEOWNERS authorization.
{ config, pkgs, lib, reposDir, ... }:

let
  siloAuthVerify = import ./git-http { inherit pkgs; };

in {
  # Auth verifier service — tiny Go binary for Ed25519 signature verification
  systemd.services.silo-auth-verify = {
    description = "Silo Ed25519 auth verifier for git smart HTTP";
    wantedBy = [ "multi-user.target" ];
    after = [ "network.target" ];
    environment = {
      SILO_AUTH_LISTEN = "127.0.0.1:9419";
    };
    serviceConfig = {
      ExecStart = "${siloAuthVerify}/bin/git-http";
      User = "git";
      Group = "git";
      Restart = "always";
      RestartSec = "2s";
    };
  };

  # nginx git smart HTTP endpoints
  services.nginx.virtualHosts."silo.loom.farm" = {
    # Internal auth subrequest endpoint
    locations."= /_silo_auth" = {
      extraConfig = ''
        internal;
        proxy_pass http://127.0.0.1:9419/;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header Authorization $http_authorization;
      '';
    };

    # Git smart HTTP — write operations (push)
    # Matches: /<repo>.git/git-receive-pack
    #          /<repo>.git/info/refs?service=git-receive-pack
    locations."~ ^/(.+\.git)/git-receive-pack$" = {
      extraConfig = ''
        auth_request /_silo_auth;
        auth_request_set $silo_key_blob $upstream_http_x_silo_key_blob;

        include ${pkgs.nginx}/conf/fastcgi_params;
        fastcgi_param SCRIPT_FILENAME "${pkgs.git}/libexec/git-core/git-http-backend";
        fastcgi_param GIT_PROJECT_ROOT ${reposDir};
        fastcgi_param GIT_HTTP_EXPORT_ALL "";
        fastcgi_param PATH_INFO $uri;
        fastcgi_param REMOTE_USER $silo_key_blob;
        fastcgi_pass unix:/run/fcgiwrap/fcgiwrap.sock;
      '';
    };

    # Git smart HTTP — read operations (clone/fetch) — no auth
    locations."~ ^/(.+\.git)/(HEAD|info/refs|objects/|git-upload-pack)" = {
      extraConfig = ''
        # If this is a receive-pack info/refs discovery, require auth
        set $needs_auth 0;
        if ($args ~ "service=git-receive-pack") {
          set $needs_auth 1;
        }

        include ${pkgs.nginx}/conf/fastcgi_params;
        fastcgi_param SCRIPT_FILENAME "${pkgs.git}/libexec/git-core/git-http-backend";
        fastcgi_param GIT_PROJECT_ROOT ${reposDir};
        fastcgi_param GIT_HTTP_EXPORT_ALL "";
        fastcgi_param PATH_INFO $uri;
        fastcgi_pass unix:/run/fcgiwrap/fcgiwrap.sock;
      '';
    };
  };

  systemd.services.nginx.after = [ "silo-auth-verify.service" ];
  systemd.services.nginx.wants = [ "silo-auth-verify.service" ];
}
