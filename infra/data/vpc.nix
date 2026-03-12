# Central VPC IP allocation for Vultr VPC v1 (no DHCP).
# All ATL cluster machines look up their VPC address here by hostname.
# Add new machines here — the seed-vpc.nix profile handles the rest.
{
  subnet = "10.0.0.0/24";
  hosts = {
    "seed-puncher-1" = { ip = "10.0.0.1"; publicNic = "enp1s0"; };  # VM: virtio NIC
    "seed-atl-1"     = { ip = "10.0.0.10"; };  # BM: default publicNic = enp1s0f0
    "seed-atl-2"     = { ip = "10.0.0.11"; };
    "seed-atl-3"     = { ip = "10.0.0.12"; };
  };
}
