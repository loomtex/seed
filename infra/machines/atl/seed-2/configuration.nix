{
  imports = [
    ../../archetypes/seed/base.nix
    ../../archetypes/seed/vultr-hardware.nix
  ];

  sops = {
    defaultSopsFile = ../../../secrets/seed-atl-2.yaml;
  };

  networking = {
    hostName = "seed-atl-2";
  };
}
