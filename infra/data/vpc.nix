# Central VPC IP allocation for Vultr VPC v1 (no DHCP).
# All ATL1 cluster machines look up their VPC address here by hostname.
# Add new machines here — the seed-vpc.nix profile handles the rest.
{
  subnet = "10.0.0.0/24";
  ipv6Prefix = "fd02::/64";  # ULA range on VPC interface — must not overlap fd00::/56 (pod CIDR) or fd01::/108 (svc CIDR)
  hosts = {
    "stake"          = { ip = "10.0.0.2"; publicNic = "enp1s0"; };   # VM: virtio NIC
    "puncher-atl1-1" = { ip = "10.0.0.1"; publicNic = "enp1s0"; };  # VM: virtio NIC
    "seed-atl1-1"    = { ip = "10.0.0.10"; ipv6 = "fd02::10"; vpcNic = "enp1s0f1"; };  # BM: dual-port NIC
    "seed-atl1-2"    = { ip = "10.0.0.11"; ipv6 = "fd02::11"; vpcNic = "enp1s0f1"; };
    "seed-atl1-3"    = { ip = "10.0.0.12"; ipv6 = "fd02::12"; vpcNic = "enp1s0f1"; };
  };
}
