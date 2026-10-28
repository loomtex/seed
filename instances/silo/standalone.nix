# silo-standalone — silo's git service on a plain NixOS host
#
# The same silo-shell, siloauth, hooks, git smart HTTP and archive code as
# the seed instance (instances/silo), without seed.* instance options,
# cgit/UI, ACME, SSHFP/DNS or sops. The post-receive webhook stays inert
# because /run/secrets/silo-webhook-secret never exists here.
#
# Intended as a local silo stand-in for VM tests (seed.nixosModules.silo-standalone).
# It sets nothing that changes git's init.defaultBranch, so new repos get
# HEAD -> refs/heads/master exactly as on silo.
{ config, pkgs, lib, ... }:

let
  cfg = config.seed.silo.standalone;
in {
  imports = [
    ../../ssh-auth.nix
    ./shell.nix
    ./hooks.nix
    ./git-http.nix
    ./archive.nix
  ];

  options.seed.silo.standalone = {
    reposDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/silo/repos";
      description = "Directory holding the bare repos.";
    };

    hostName = lib.mkOption {
      type = lib.types.str;
      default = "silo.test";
      description = "Name the git smart HTTP virtual host answers to.";
    };
  };

  config = {
    _module.args.reposDir = cfg.reposDir;

    users.groups.git = {};

    systemd.tmpfiles.rules = [
      "d ${cfg.reposDir} 0755 git git -"
    ];

    # Answer for the stand-in's name; the vhost keeps silo's production key
    # so git-http.nix and archive.nix merge into it unchanged.
    services.nginx = {
      enable = true;
      virtualHosts."silo.loom.farm" = {
        default = true;
        serverAliases = [ cfg.hostName ];
      };
    };

    networking.firewall.allowedTCPPorts = [ 22 80 ];

    environment.systemPackages = [ pkgs.git ];
  };
}
