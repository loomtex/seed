{ config, ... }:

{
  imports = [
    ./base.nix
  ];

  seed = {
    k3s.clusterInit = true;
    controller = {
      enable = true;
      flakePaths = [
        "github:loomtex/seed"
      ];
      webhook = {
        enable = true;
        secretFile = config.sops.secrets."seed/controller/gh-webhook-secret".path;
      };
    };
  };

  networking = {
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
