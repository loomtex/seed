{ pkgs, lib, config, ... }:

{
  imports = [
    ../../profiles/server.nix
    ../../profiles/seed-local-users.nix
    ../../profiles/seed-cache.nix
    ../../profiles/seed-vpc.nix
  ];

  options.seed.vpcSubnets = lib.mkOption {
    type = lib.types.listOf lib.types.str;
    description = "VPC CIDRs allowed to reach Tang (one per cluster)";
  };

  config = {
    # Tang and DNS must wait for VPC interface (BMs reach them over VPC)
    systemd.sockets.tangd.wants = [ "seed-vpc.service" ];
    systemd.sockets.tangd.after = [ "seed-vpc.service" ];
    systemd.services.unbound.wants = [ "seed-vpc.service" ];
    systemd.services.unbound.after = [ "seed-vpc.service" ];

    sops.age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];
    sops.secrets.vultr-api-key = {};

    # Tang: Network-Bound Disk Encryption server
    services.tang = {
      enable = true;
      listenStream = [ "7654" ];
      ipAddressAllow = config.seed.vpcSubnets;
    };

    # Generate tang keys on first boot
    systemd.services.tangd-keygen = {
      description = "Generate Tang keys if missing";
      wantedBy = [ "tangd.socket" ];
      before = [ "tangd.socket" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        ExecCondition = "${pkgs.bash}/bin/bash -c '[ ! -d /var/lib/private/tang ] || [ -z \"$(ls -A /var/lib/private/tang 2>/dev/null)\" ]'";
        ExecStart = "${pkgs.bash}/bin/bash -c 'mkdir -p /var/lib/private/tang && ${pkgs.tang}/libexec/tangd-keygen /var/lib/private/tang'";
      };
    };

    # PowerDNS: authoritative for combine.loom.farm, localhost-only.
    services.powerdns = {
      enable = true;
      extraConfig = ''
        launch=gsqlite3
        gsqlite3-database=/var/lib/pdns/combine.sqlite
        local-address=127.0.0.1
        local-port=5300
        socket-dir=/run/pdns
        api=yes
        webserver=yes
        webserver-address=127.0.0.1
        webserver-port=8081
        webserver-allow-from=127.0.0.0/8
        include-dir=/run/pdns/conf.d
      '';
    };

    systemd.services.pdns.serviceConfig.RuntimeDirectory = "pdns";

    systemd.services.pdns.serviceConfig.ExecStartPre = let
      script = pkgs.writeShellScript "pdns-init" ''
        mkdir -p /run/pdns/conf.d

        DB=/var/lib/pdns/combine.sqlite
        if [ ! -f "$DB" ]; then
          ${pkgs.sqlite}/bin/sqlite3 "$DB" < ${pkgs.pdns}/share/doc/pdns/schema.sqlite3.sql
          chown pdns:pdns "$DB"
        fi

        ${pkgs.sqlite}/bin/sqlite3 "$DB" "DELETE FROM domainmetadata WHERE kind='SOA-EDIT-DNSUPDATE';" 2>/dev/null || true
        ${pkgs.sqlite}/bin/sqlite3 "$DB" "DELETE FROM domainmetadata WHERE kind='INCEPTION-INCREMENT';" 2>/dev/null || true

        if [ ! -f /run/pdns/api-key ]; then
          ${pkgs.openssl}/bin/openssl rand -hex 16 > /run/pdns/api-key
          chmod 600 /run/pdns/api-key
        fi
        echo "api-key=$(cat /run/pdns/api-key)" > /run/pdns/conf.d/api-key.conf
      '';
    in "+${script}";

    systemd.tmpfiles.rules = [
      "d /var/lib/pdns 0750 pdns pdns -"
    ];

    # Unbound: recursive resolver
    services.unbound = {
      enable = true;
      settings = {
        server = {
          interface = [ "0.0.0.0" "::" ];
          access-control = [
            "10.0.0.0/24 allow"
            "127.0.0.0/8 allow"
            "::1/128 allow"
          ];
          do-not-query-localhost = false;
          domain-insecure = [ "combine.loom.farm" ];
        };
        forward-zone = [
          {
            name = "combine.loom.farm.";
            forward-addr = [ "127.0.0.1@5300" ];
          }
          {
            name = ".";
            forward-addr = [ "1.1.1.1" "1.0.0.1" ];
          }
        ];
      };
    };

    # combine-dns-sync: Vultr API poller -> pdns record updates
    systemd.services.combine-dns-sync = {
      description = "Sync Vultr hosts to combine.loom.farm DNS";
      after = [ "pdns.service" "network-online.target" ];
      wants = [ "network-online.target" ];
      path = with pkgs; [ curl jq ];
      environment = {
        VULTR_API_KEY_FILE = config.sops.secrets.vultr-api-key.path;
        PDNS_API_KEY_FILE = "/run/pdns/api-key";
        ALIASES_FILE = "${./combine-dns/aliases.json}";
        ZONE = "combine.loom.farm.";
      };
      serviceConfig = {
        Type = "oneshot";
        ExecStart = "${pkgs.bash}/bin/bash ${./combine-dns/sync.sh}";
        User = "root";
      };
    };

    systemd.timers.combine-dns-sync = {
      description = "Poll Vultr API and update DNS every 60s";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnBootSec = "30s";
        OnUnitActiveSec = "60s";
        RandomizedDelaySec = "5s";
      };
    };

    networking = {
      useDHCP = true;
      firewall = {
        enable = true;
        allowedTCPPorts = [
          22    # SSH
          53    # DNS (unbound)
          7654  # Tang
        ];
        allowedUDPPorts = [
          53    # DNS (unbound)
        ];
      };
    };

    i18n.defaultLocale = "en_US.UTF-8";

    environment.systemPackages = with pkgs; [
      inetutils
      dig
    ];

    services.openssh = {
      enable = true;
      settings.PermitRootLogin = "no";
    };

    system.autoUpgrade = {
      enable = true;
      dates = "04:00";
      flake = "github:loomtex/seed?dir=infra";
      allowReboot = true;
    };

    system.stateVersion = "25.11";
  };
}
