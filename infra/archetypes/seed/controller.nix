# Seed controller node: webhook, flake paths, ingress firewall ports, backup.
# Applied only to nodes with `controller = true` in cluster.nix.
{ config, ... }:

{
  imports = [
    ../../profiles/seed-backup.nix
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
    flakePaths = [ "github:loomtex/seed" ];
    webhook = {
      enable = true;
      secretFile = config.sops.secrets."seed/controller/gh-webhook-secret".path;
    };
  };

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
