{
  imports = [
    ../../archetypes/seed/init-variant.nix
    ../../archetypes/seed/vultr-hardware.nix
  ];

  sops = {
    defaultSopsFile = ../../../secrets/seed-atl-1.yaml;
  };

  networking = {
    hostName = "seed-atl-1";
  };
}
