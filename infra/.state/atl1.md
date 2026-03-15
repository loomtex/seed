# ATL1 Cluster State

Current state of the ATL1 seed cluster infrastructure.
Updated by the provisioning agent after each transition.

## VPC

| Field | Value |
|-------|-------|
| ID | 3a7375f6-fff4-4952-a53c-41cdd79e2ef3 |
| State | **active** |
| Subnet | 10.0.0.0/24 |
| Region | atl |

## Reserved IPs

| Field | Value |
|-------|-------|
| IPv4 ID | 348bc22d-5a39-4181-b99b-9f5d3e305801 |
| IPv4 | 96.30.193.227 |
| IPv4 attached to | *(none)* |
| IPv6 ID | 36e2fc9c-138d-467b-beca-57a599d89624 |
| IPv6 block | 2001:19f0:5400:20a7::/64 |
| State | **allocated** |

## Stake

| Field | Value |
|-------|-------|
| ID | 471fa51a-a0b7-4b25-8b0b-ad738a7cdaf8 |
| IP | 155.138.223.154 |
| VPC IP | 10.0.0.2 |
| Plan | vx1-g-4c-16g-240s |
| State | **ready** |
| Notes | Ephemeral kexec — reboots to Debian |

## Puncher (puncher-atl1-1)

| Field | Value |
|-------|-------|
| ID | 3e49dd63-bf6f-4116-8255-da16b6a3845f |
| IP | 155.138.164.204 |
| VPC IP | 10.0.0.1 |
| Tang port | 7654 |
| State | **tang-ready** |
| Notes | Tang + Unbound + PowerDNS |

## Nodes

### seed-atl1-1

| Field | Value |
|-------|-------|
| BM ID | 05fa128a-bcf9-463e-9fd8-5524f0caf62d |
| IP | 96.30.205.16 |
| IPv6 | *(none yet)* |
| VPC IP | 10.0.0.10 |
| State | **nixos-installed** |
| Age key | age1nachhe6fxyqj8wzzypxg7lh8utg2pdn7mrg5jty77keunemcau8q0pxnhx |
| iPXE script | ba746a49-9b1b-403f-be65-98295a47b661 |
| Notes | clusterInit, controller, LUKS+Clevis, dual-stack. Booted, Clevis auto-unlock OK. k3s waiting for sops re-key. |

### seed-atl1-2

| Field | Value |
|-------|-------|
| BM ID | a2a3c072-00c5-4003-a918-d9996ac84e68 |
| IP | 144.202.24.202 |
| IPv6 | *(none yet)* |
| VPC IP | 10.0.0.11 |
| State | **nixos-installed** |
| Age key | age1ggj5uuyt5x0vrt4fmcu8lnt0f3qzqkxjm8qpqrplckvpz2s2ugdquuzn78 |
| iPXE script | ba746a49-9b1b-403f-be65-98295a47b661 |
| Notes | k3s server, LUKS+Clevis, dual-stack. Booted, Clevis auto-unlock OK. k3s waiting for sops re-key. |

### seed-atl1-3

| Field | Value |
|-------|-------|
| BM ID | 4cf7a14e-a785-43e1-9e57-1a51ead63429 |
| IP | 155.138.232.75 |
| IPv6 | *(none yet)* |
| VPC IP | 10.0.0.12 |
| State | **nixos-installed** |
| Age key | age1uzcjxhj5jnu0r5h0q8cqf7rj4tzdcp5zs6xk4rv0257n32pfxvysj7lvm3 |
| iPXE script | ba746a49-9b1b-403f-be65-98295a47b661 |
| Notes | k3s server, LUKS+Clevis, dual-stack. Booted, Clevis auto-unlock OK. k3s waiting for sops re-key. |
