{
  import = [
    ../../archetypes/puncher/configuration.nix
  ];

  sops.secrets.vultr-api-key = {
    sopsFile = ../../../secrets/seed-puncher-1.yaml;
  };

  networking.hostName = "puncher-atl-1";
}
