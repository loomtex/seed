{ config, pkgs, lib, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ../../../profiles/server.nix
  ];

  options.seed.netbootPath = lib.mkOption {
    type = lib.types.nullOr lib.types.path;
    default = null;
    description = "Path to the seed-netboot derivation (bzImage + initrd) for iPXE serving";
  };

  config = {

    boot.loader.systemd-boot.enable = true;
    boot.loader.efi.canTouchEfiVariables = true;

    # System-wide packages for provisioning (ada gets her own via nuketown).
    environment.systemPackages = with pkgs; [
      nodejs_22       # Registration server
    ];

    # --- Nuketown: ada as provisioning agent ---

    nuketown = {
      enable = true;
      domain = "6bit.com";
      humanUser = "josh";

      agents.ada = {
        enable = true;
        uid = 1100;
        role = "provisioner";
        description = "Cluster provisioning agent — manages seed infrastructure";

        portal.enable = true;
        sudo.enable = true;

        packages = with pkgs; [
          unstable.claude-code
          nixos-anywhere
          sops age ssh-to-age
          jq git curl
          clevis jose
          vultr-cli
        ];

        git = {
          name = "Ada";
          email = "ada@6bit.com";
        };

        # Secrets added after stake host key enrollment:
        # secrets.sshKey = "ada/ssh-key";
        # secrets.gpgKey = "ada/gpg-key";
      };
    };

    # Headless auto-approve: no zenity on a server VM.
    # All of ada's sudo calls are automatically approved.
    systemd.services.nuketown-autoapprove = {
      wantedBy = [ "multi-user.target" ];
      serviceConfig = { Type = "oneshot"; RemainAfterExit = true; };
      script = ''
        mkdir -p /run/nuketown-broker
        echo "MOCK_APPROVED" > /run/nuketown-broker/mode
      '';
    };

    # ada on signi can SSH in to start provisioning sessions
    users.users.ada.openssh.authorizedKeys.keys = [
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH4wKwiX1fnwB/U4Mc7JT4ddMExopexk0DUSd7Du12Sp ada@signi"
    ];

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
      hostName = "seed-stake";
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

    time.timeZone = "America/Chicago";
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
