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
| BM ID | *(to be recorded)* |
| IP | *(to be recorded)* |
| VPC IP | 10.0.0.10 |
| State | **absent** |
| Age key | age1gcnvkfuptygecafugm5m54cfh2krnh95x023w9pjyj4uz2pu697qwv7knd |
| Notes | clusterInit, controller |

### seed-atl-2

| Field | Value |
|-------|-------|
| BM ID | *(to be recorded)* |
| IP | *(to be recorded)* |
| VPC IP | 10.0.0.11 |
| State | **absent** |
| Age key | age19xq48wjmej07g6sl8kg86a64jsxe5gc47y2f6ghefjxeqhhcad7q4sm0vx |

### seed-atl-3

| Field | Value |
|-------|-------|
| BM ID | *(to be recorded)* |
| IP | *(to be recorded)* |
| VPC IP | 10.0.0.12 |
| State | **absent** |
| Age key | age1dql0yg48r4m6xsycwxf2dn3wrvdld6rrszgm2yaxud4jwamx7vgq59gxy9 |
