# Hardware inventory + desired topology for all seed clusters.
# Single source of truth — archetype functions in flake.nix generate
# all nixosConfigurations from this data.
{
  clusters.atl = {
    region = "atl";
    timeZone = "America/Denver";
    vpc.subnet = "10.0.0.0/24";
    reservedIpv4 = "96.30.193.227";
    reservedIpv6 = "2001:19f0:5400:20a7::/64";

    stake = {
      plan = "vx1-g-4c-16g-240s";
      type = "vm";
      vpcIp = "10.0.0.2";
    };

    puncher = {
      name = "seed-puncher-1";
      plan = "vc2-1c-2gb";
      type = "vm";
      vpcIp = "10.0.0.1";
      tangPort = 7654;
    };

    nodes = {
      seed-atl-1 = {
        type = "bm";
        plan = "vbm-6c-32gb";
        vpcIp = "10.0.0.10";
        clusterInit = true;
        controller = true;
      };
      seed-atl-2 = { type = "bm"; plan = "vbm-6c-32gb"; vpcIp = "10.0.0.11"; };
      seed-atl-3 = { type = "bm"; plan = "vbm-6c-32gb"; vpcIp = "10.0.0.12"; };
    };
  };
}
