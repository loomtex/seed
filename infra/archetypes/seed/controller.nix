# Seed controller node: webhook, flake paths, ingress firewall ports, backup.
# Applied only to nodes with `controller = true` in cluster.nix.
{ config, ... }:

{
  imports = [
    ../../profiles/seed-backup.nix
    ../../profiles/seed-cert-manager.nix
  ];

  combine.backup = {
    enable = true;
    bucket = "seed-nix-cache";
    recipients = [
      "age14xasgltzglzdnnkk4hqpyhwve2ku590lftj5mmgdrmr2ecc3eacqzuqlvx"  # josh (yubikey)
      "age1ujjm7feyd3p2e0qtfa6zr2rzf593yd2z0xjn0ytvd8jcje68nansxy4zuu"  # ada
    ];
    cephfs = [
      { name = "seed-fs"; mountPoint = "/var/lib/seed-controller/tpm"; }
    ];
  };

  seed.controller = {
    enable = true;
    flakePaths = [ "tarball+https://silo.loom.farm/seed/archive/master.tar.gz" ];
    netpol.enable = true;
    webhook = {
      enable = true;
      secretFile = "/etc/seed/secrets/gh-webhook-secret";
    };
    dns = {
      apiUrl = "http://dns.s-gaydazldmnsg.svc.cluster.local:8081";
      apiKeyFile = "/etc/seed/secrets/pdns-api-key";
    };
    acme.accountKey = config.sops.placeholder."seed/controller/acme-account-key";
  };

  sops.templates."seed-acme-secret.json" = {
    content = config.seed.controller.acme._secretManifestJSON;
  };

  seed.k8s.services.seed-controller.extraManifestPaths = [
    config.sops.templates."seed-controller-secrets.json".path
    config.sops.templates."seed-acme-secret.json".path
  ];

  networking.firewall = {
    allowedTCPPorts = [
      53    # DNS (seed ipv4 route)
      80    # HTTP (seed ipv4 route)
      443   # HTTPS (seed ipv4 route)
    ];
    allowedUDPPorts = [
      53    # DNS (seed ipv4 route)
    ];
  };
}
