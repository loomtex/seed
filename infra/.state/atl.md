# ATL Cluster State

Current state of the ATL seed cluster infrastructure.
Updated by the provisioning agent after each transition.

## VPC

| Field | Value |
|-------|-------|
| ID | 835f9059-98bc-404a-8693-52e4c9847b3b |
| State | **active** |
| Subnet | 10.0.0.0/24 |
| Region | atl |

## Reserved IPs

| Field | Value |
|-------|-------|
| IPv4 ID | 348bc22d-5a39-4181-b99b-9f5d3e305801 |
| IPv4 | 96.30.193.227 |
| IPv4 attached to | seed-atl-1 (81ebebdd-b672-45ec-b158-e410ec573ea0) |
| IPv6 ID | 36e2fc9c-138d-467b-beca-57a599d89624 |
| IPv6 block | 2001:19f0:5400:20a7::/64 |
| State | **attached** |

## Stake

| Field | Value |
|-------|-------|
| ID | 34c58d54-3a4a-4138-8be4-52481a3801d8 |
| IP | 155.138.216.168 |
| VPC IP | 10.0.0.2 |
| Plan | vx1-g-4c-16g-240s |
| State | **ready** |
| Notes | Ephemeral kexec — reboots to Debian |

## Puncher (seed-puncher-1)

| Field | Value |
|-------|-------|
| ID | 3d5be8cb-798f-4406-bbcb-213b6a45abc9 |
| IP | 108.61.193.135 |
| VPC IP | 10.0.0.1 |
| Tang port | 7654 |
| State | **tang-ready** |
| Notes | Tang + Unbound + PowerDNS active |

## Nodes

### seed-atl-1

| Field | Value |
|-------|-------|
| BM ID | 81ebebdd-b672-45ec-b158-e410ec573ea0 |
| IP | 104.156.255.96 |
| IPv6 | 2001:19f0:5401:0c91:3eec:efff:feb9:a956 |
| VPC IP | 10.0.0.10 |
| State | **healthy** |
| Age key | age1neey2tjnrka26dndtwp400y5auud86v92f09srdr3xun80exv5jqcnlq6t |
| iPXE script | 7786b670-807e-4eb6-8a3d-7030f2032ab0 |
| Notes | clusterInit, controller, LUKS+Clevis, dual-stack |

### seed-atl-2

| Field | Value |
|-------|-------|
| BM ID | e465a3c2-2034-42fc-ac97-c1f848a86764 |
| IP | 45.76.251.217 |
| IPv6 | 2001:19f0:5400:22f6:3eec:efff:feb9:89ac |
| VPC IP | 10.0.0.11 |
| State | **healthy** |
| Age key | age16kvu4zv76gnuenewe3eaphx5uq5xd4hcw9qpf6x7ltgtlsm9kp2s05uvwy |
| Notes | k3s server, LUKS+Clevis (manual unlock on first boot), dual-stack |

### seed-atl-3

| Field | Value |
|-------|-------|
| BM ID | e0e7a0b7-1ace-4223-803c-8997014d6812 |
| IP | 155.138.221.136 |
| IPv6 | 2001:19f0:5400:2244:3eec:efff:feb9:c554 |
| VPC IP | 10.0.0.12 |
| State | **healthy** |
| Age key | age1x6fmwskwxvacf9nnsafexvpgfdl9ugj9xf9fvpvfng3rkukc3yxskddr3p |
| Notes | k3s server, VPC hot-attached, LUKS+Clevis (manual unlock on first boot), dual-stack |
