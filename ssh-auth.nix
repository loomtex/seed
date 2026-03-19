# seed.sshAuth — SSH "any-key identity" module for Seed instances
#
# Provides usernameless SSH access: any SSH key is accepted, key identity
# passed via environment variables to a forced command. An NSS catchall
# module maps any username to a fixed uid so `ssh host` works without
# specifying a user.
#
# Used by seed-shell (management interface) and silo (git hosting).
{ config, lib, pkgs, ... }:

let
  cfg = config.seed.sshAuth;

  # NSS module: resolves any unknown username to the configured uid/home/shell.
  # Compiled once with hardcoded values — glibc dlopen()s it via nsswitch.conf.
  nssModule = pkgs.stdenv.mkDerivation {
    name = "nss-${cfg.nssName}";
    dontUnpack = true;
    buildPhase = ''
      cat > nss.c << 'CEOF'
      #include <nss.h>
      #include <pwd.h>
      #include <string.h>
      #include <errno.h>

      enum nss_status _nss_${cfg.nssName}_getpwnam_r(
          const char *name, struct passwd *pwd,
          char *buf, size_t buflen, int *errnop)
      {
          const char *home = "${cfg.home}";
          const char *shell = "${cfg.shell}";
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
          pwd->pw_uid = ${toString cfg.uid};
          pwd->pw_gid = ${toString cfg.gid};
          pwd->pw_gecos = pwd->pw_name;
          memcpy(p, home, homelen); pwd->pw_dir = p; p += homelen;
          memcpy(p, shell, shelllen); pwd->pw_shell = p;

          return NSS_STATUS_SUCCESS;
      }
      CEOF
      $CC -shared -o libnss_${cfg.nssName}.so.2 nss.c -Wl,-soname,libnss_${cfg.nssName}.so.2
    '';
    installPhase = ''
      mkdir -p $out/lib
      cp libnss_${cfg.nssName}.so.2 $out/lib/
    '';
  };

  # AuthorizedKeysCommand script — accepts any key, passes identity via env vars.
  # Optional authKeysHook can inject extra environment variables (e.g. repo list).
  authKeysScript = pkgs.writeShellScript "${cfg.nssName}-auth-keys" ''
    # Args from sshd: %u %t %k (username, key-type, key-blob-base64)
    KEY_TYPE="$2"
    KEY_BLOB="$3"

    # Optional hook for extra context (e.g. controller API lookup)
    EXTRA_ENV=""
    ${lib.optionalString (cfg.authKeysHook != null) ''
      EXTRA_ENV=$(${cfg.authKeysHook} "$KEY_TYPE" "$KEY_BLOB") || true
    ''}

    # Always emit a line — any key is accepted.
    echo "restrict,command=\"${cfg.forcedCommand}\",environment=\"${cfg.envPrefix}_KEY_TYPE=$KEY_TYPE\",environment=\"${cfg.envPrefix}_KEY_BLOB=$KEY_BLOB\"''${EXTRA_ENV:+,$EXTRA_ENV} $KEY_TYPE $KEY_BLOB ${cfg.nssName}-user"
  '';
in
{
  options.seed.sshAuth = {
    enable = lib.mkEnableOption "SSH any-key identity auth";

    uid = lib.mkOption {
      type = lib.types.int;
      description = "Unix UID the NSS catchall maps all usernames to.";
    };

    gid = lib.mkOption {
      type = lib.types.int;
      default = 100;
      description = "Unix GID the NSS catchall maps all usernames to.";
    };

    home = lib.mkOption {
      type = lib.types.str;
      description = "Home directory baked into the NSS catchall.";
    };

    shell = lib.mkOption {
      type = lib.types.str;
      description = "Login shell baked into the NSS catchall.";
    };

    userName = lib.mkOption {
      type = lib.types.str;
      description = "Unix username to create (for /etc/passwd, file ownership).";
    };

    group = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "Primary group name. If set, the user's group is set to this (group must be created separately).";
    };

    nssName = lib.mkOption {
      type = lib.types.str;
      description = "NSS module name (becomes libnss_<name>.so.2 and nsswitch 'passwd: ... <name>').";
    };

    forcedCommand = lib.mkOption {
      type = lib.types.str;
      description = "Forced command name in authorized_keys (e.g. 'seed-shell', 'silo-shell').";
    };

    envPrefix = lib.mkOption {
      type = lib.types.str;
      description = "Environment variable prefix (e.g. 'SEED' → SEED_KEY_TYPE, SEED_KEY_BLOB).";
    };

    authKeysHook = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Optional script called during AuthorizedKeysCommand.
        Receives KEY_TYPE and KEY_BLOB as $1 and $2.
        Should output extra authorized_keys environment= directives
        (comma-separated, no leading comma) on stdout, or empty string.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # NSS catchall: any unknown username resolves to the configured user.
    # Requires nscd for NixOS to wire the library path into glibc's search path.
    # instance-base.nix sets nssModules = mkForce [] — we override with our own mkForce.
    services.nscd.enable = true;
    system.nssModules = lib.mkForce [ nssModule ];
    system.nssDatabases.passwd = lib.mkAfter [ cfg.nssName ];

    # User account — must match the uid/gid baked into the NSS module.
    users.users.${cfg.userName} = {
      isNormalUser = true;
      uid = cfg.uid;
      home = cfg.home;
      shell = cfg.shell;
      createHome = false;
      initialHashedPassword = "";
    } // lib.optionalAttrs (cfg.group != null) {
      group = cfg.group;
    };

    # sshd: key-only auth, any key accepted via AuthorizedKeysCommand.
    services.openssh = {
      enable = true;
      settings = {
        PermitRootLogin = "no";
        PasswordAuthentication = false;
        KbdInteractiveAuthentication = false;
        UsePAM = false;
        AuthorizedKeysFile = "none";
        PermitUserEnvironment = "${cfg.envPrefix}_*";
        AuthorizedKeysCommand = "/etc/ssh/${cfg.nssName}-auth-keys %u %t %k";
        AuthorizedKeysCommandUser = "root";
      };
    };

    # Install auth script where sshd trusts ownership (virtiofs workaround).
    environment.etc."ssh/${cfg.nssName}-auth-keys" = {
      source = authKeysScript;
      mode = "0755";
    };
  };
}
