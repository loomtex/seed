# Hardware inventory + desired topology for all seed clusters.
# Single source of truth — archetype functions in flake.nix generate
# all nixosConfigurations from this data.
{
  clusters.atl1 = {
    region = "atl";
    timeZone = "America/Denver";
    vpc.subnet = "10.0.0.0/24";
    reservedIpv4 = "96.30.193.227";
    reservedIpv6 = "2001:19f0:5400:20a7::/64";

    ceph.fsid = "58ec6b96-5df6-49f2-86c3-182501b0602d";

    stake = {
      plan = "vx1-g-4c-16g-240s";
      type = "vm";
      vpcIp = "10.0.0.2";
    };

    puncher = {
      name = "puncher-atl1-1";
      plan = "vc2-1c-2gb";
      type = "vm";
      vpcIp = "10.0.0.1";
      tangPort = 7654;
    };

    nodes = {
      seed-atl1-1 = {
        type = "bm";
        plan = "vbm-6c-32gb";
        vpcIp = "10.0.0.10";
        clusterInit = true;
        controller = true;
        ceph = { osdId = "0"; osdDevice = "/dev/disk/by-path/pci-0000:00:17.0-ata-4"; };
      };
      seed-atl1-2 = { type = "bm"; plan = "vbm-6c-32gb"; vpcIp = "10.0.0.11"; ceph = { osdId = "1"; osdDevice = "/dev/disk/by-path/pci-0000:00:17.0-ata-4"; }; };
      seed-atl1-3 = { type = "bm"; plan = "vbm-6c-32gb"; vpcIp = "10.0.0.12"; ceph = { osdId = "2"; osdDevice = "/dev/disk/by-path/pci-0000:00:17.0-ata-4"; }; };
    };
  };
}
