# Hardware inventory + desired topology for all seed clusters.
# The agent reads this to know what should exist.
{
  clusters.atl = {
    region = "atl";
    vpc.subnet = "10.0.0.0/24";

    stake = {
      plan = "vc2-4c-8gb";
      vpcIp = "10.0.0.2";
      flakeAttr = "seed-stake";
    };

    puncher = {
      name = "seed-puncher-1";
      plan = "vc2-1c-2gb";
      vpcIp = "10.0.0.1";
      tangPort = 7654;
      flakeAttr = "seed-puncher-1";
    };

    nodes = {
      seed-atl-1 = {
        type = "bm";
        plan = "vbm-6c-32gb";
        vpcIp = "10.0.0.10";
        clusterInit = true;
        controller = true;
        flakeAttr = "seed-atl-1";
      };
      seed-atl-2 = {
        type = "bm";
        plan = "vbm-6c-32gb";
        vpcIp = "10.0.0.11";
        flakeAttr = "seed-atl-2";
      };
      seed-atl-3 = {
        type = "bm";
        plan = "vbm-6c-32gb";
        vpcIp = "10.0.0.12";
        flakeAttr = "seed-atl-3";
      };
    };
  };
}
