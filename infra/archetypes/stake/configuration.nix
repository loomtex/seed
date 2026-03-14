{ config, pkgs, lib, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ../../profiles/server.nix
  ];

  options.seed.netbootPath = lib.mkOption {
    type = lib.types.nullOr lib.types.path;
    default = null;
    description = "Path to the seed-netboot derivation (bzImage + initrd) for iPXE serving";
  };

  config = {

    # Kexec activation: no bootloader, no installer — activated in-place
    boot.loader.grub.enable = false;

    # Filesystem declarations for kexec compatibility.
    # Root is the squashfs+tmpfs overlay from kexec; /mnt/disk is the
    # ext4 backing store for the nix store overlay swap.
    fileSystems."/" = { device = "none"; fsType = "tmpfs"; };
    fileSystems."/mnt/disk" = {
      device = "/dev/vda";
      fsType = "ext4";
      options = [ "nofail" ];
    };

    # S3 binary cache (substituter only — credentials injected by provisioning agent)
    nix.settings = {
      substituters = [ "s3://seed-nix-cache?endpoint=atl2.vultrobjects.com&region=us-east-1&profile=default" ];
      trusted-public-keys = [ "seed-cache-1:HmHh2GMeZTBXufX8RRs30bBNVB75+QfkgFllazC365E=" ];
    };

    # System-wide packages for provisioning
    environment.systemPackages = with pkgs; [
      nodejs_22       # Registration server
      nixos-anywhere
      sops age ssh-to-age
      jq git curl
      clevis jose
    ];

    # --- ada: provisioning agent ---

    users.users.ada = {
      uid = 1100;
      group = "ada";
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      home = "/home/ada";
      openssh.authorizedKeys.keys = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4wKwiX1fnwB/U4Mc7JT4ddMExopexk0DUSd7Du12Sp ada@signi"
      ];
    };
    users.groups.ada = { gid = 1100; };

    # NOPASSWD sudo for ada — stake is ephemeral, no approval daemon needed
    security.sudo.extraRules = [{
      users = [ "ada" ];
      commands = [{ command = "ALL"; options = [ "NOPASSWD" ]; }];
    }];

    # --- Services ---

    # Serve netboot artifacts (kernel + initrd) over plain HTTP for iPXE.
    services.nginx = lib.mkIf (config.seed.netbootPath != null) {
      enable = true;
      virtualHosts."netboot" = {
        listen = [{ addr = "0.0.0.0"; port = 8080; }];
        root = "${config.seed.netbootPath}";
        extraConfig = ''
          autoindex on;
        '';
      };
    };

    # Registration endpoint: receives phone-home POSTs from netboot machines.
    systemd.services.seed-register = {
      description = "Seed machine registration endpoint";
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      serviceConfig = {
        Type = "simple";
        ExecStart = "${pkgs.nodejs_22}/bin/node ${./register-server.mjs}";
        Restart = "always";
        StateDirectory = "seed-register";
      };
    };

    # --- Networking ---

    networking = {
      useDHCP = true;
      firewall = {
        enable = true;
        allowedTCPPorts = [
          22    # SSH
          8080  # Netboot HTTP (iPXE)
          8081  # Registration endpoint
        ];
      };
    };

    i18n.defaultLocale = "en_US.UTF-8";

    services.openssh = {
      enable = true;
      settings.PermitRootLogin = "no";
    };

    users.mutableUsers = false;

    users.users.josh = {
      uid = 1000;
      group = "josh";
      initialHashedPassword = "$6$rounds=3000000$plps8mAYoxl.ngM7$UICj9iFn3SvWEBmD6Zsv0pWu8fru2jGNqvXazc7BjM9CJJxCna.du8yytejQeAL9yjQ.943AXyv8fjgSxOX.4.";
      isNormalUser = true;
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICsPaFplk95wdbZnGF9q1LnQUKy36Lh+4dSHyFJwMeUK josh@6bit.com"
      ];
    };
    users.groups.josh = { gid = 1000; };

    system.stateVersion = "25.11";
  };
}
