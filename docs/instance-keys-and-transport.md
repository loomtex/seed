# Instance Keys and Transport

*Ada and Joshua Perry, 2026-11-03. Design; not yet implemented. Supersedes
the vTPM, EST and in-instance ACME parts of `auth-and-identity.md` and
`tls-and-ingress.md`, and the NetworkPolicy compilation in
`connects-and-firewall.md`.*

**One-liner:** instances configure nothing about keys or TLS. The platform
holds every key outside the VM, encrypts instance-to-instance traffic with
per-instance WireGuard in the pod's own network namespace, terminates public
TLS at the instance's host, and forwards stock key agents into the VM for the
keys applications use directly.

---

## Why

Today every key an instance has is either in the vTPM or in the VM:

- **TPM 2.0 can't hold ed25519 keys**, the modern default for SSH and
  signing.
- **Value secrets land in the VM.** sops-nix decrypts through the TPM into
  `/run/secrets/*`. The wrapping key stays in the TPM; the values don't.
- **TLS keys depend on each application.** TPM-bound keys work only for
  OpenSSL-based software with the `tpm2` provider. Caddy, Go services and
  most other servers need key files or a local proxy (the socat + openssl
  pattern in the Postgres and Zitadel modules).
- **`tpm2-00.permall` is unencrypted on CephFS.** Node root or CephFS access
  reads every instance's TPM keys anyway.
- **Configuration grows with every key.** ACME settings, key paths, SPIFFE
  plumbing and per-app TLS options are all places for an agent to make a
  mistake.

The goal is to collapse that configuration to nothing while keeping Seed's
principle that **crypto terminates at the instance**: never at a shared
ingress, never as plaintext across the network. Plaintext crossing internal
links is the mistake Google made until 2013; nothing here repeats it.

## Trust boundary

The instance is its VM **plus its own namespace and processes on its host**.
Node root can already read a VM's memory, start and stop it, and read its
TPM state, so placing an instance's keys and its crypto endpoints on its own
host adds nothing a node compromise didn't already have. Two limits keep that
true:

1. **Nothing an instance owns is shared with another instance.** Every
   per-instance component (WireGuard interface, ingress proxy, key-holder)
   is created for that instance, owned by the Kata shim or the CNI plugin,
   and destroyed with it.
2. **The host never parses another tenant's traffic** for instance-to-
   instance communication. WireGuard is kernel crypto with no protocol
   parsing. The one exception is public ingress, which has to be parsed
   somewhere, and is confined to a per-instance, sandboxed, keyless proxy.

The cost of this boundary: plaintext exists on the host between the VM's tap
and the instance's WireGuard interface, so root on that node can capture it
with `tcpdump`. That's cheaper than inspecting VM memory, but available only
to someone who already holds the node.

---

## Layer 1: instance-to-instance — WireGuard per instance

```
 seed-atl1-1                                         seed-atl1-2
+------------------------------------+              +------------------------------------+
| pod netns (instance A)             |              |             pod netns (instance B) |
|                                    |              |                                    |
|  VM A ── tap0_kata ──┬── eth0 ─────┼── flannel ───┼──── eth0 ──┬── tap0_kata ── VM B   |
|          (L2 mirror  |   (DNS,     |   (non-mesh) |            |  (L2 mirror for       |
|           for non-   |    egress)  |              |            |   non-mesh)           |
|           mesh)      |             |              |            |                       |
|                      └── wgt0 ═════╪══ WireGuard ═╪═══ wgt0 ───┘                       |
|                          (peer:    |   UDP over   |   (peer: A)                       |
|                           B /32)   |   the VPC    |                                   |
+------------------------------------+              +------------------------------------+
     wgt0's UDP socket lives in the node netns, so encrypted packets go
     straight between node VPC addresses: no VXLAN around them.
```

### Who does what, and when

The work divides by timing. containerd runs the whole CNI chain before it
hands the pod to the Kata shim (`internal/cri/server/sandbox_run.go`:
`setupPodNetwork`, then `CreateSandbox`), and Kata reads the namespace when
it builds the sandbox. So:

- **At pod ADD**, the tap doesn't exist yet, and the pod IP must still be on
  `eth0`, or Kata gives the VM no network. The CNI plugin does only what
  Kata should see, or what must exist before it looks.
- **After the sandbox starts**, seed-host-agent finishes the data path and
  configures peers.

### mycorrhizal: the CNI plugin (pod ADD)

A chained CNI plugin, `mycorrhizal` (after flannel in the k3s conflist),
for seed-managed pods:

1. **Interface.** Create `wgt0` in the **node** namespace, so its UDP socket
   binds there, then move it into the pod namespace. Give it **no address**:
   Kata skips interfaces without addresses when it builds the sandbox
   (`network_linux.go`, `addAllEndpoints`), so `wgt0` stays on the host.
2. **Key.** Generate the private key in memory and set it on the interface.
   It is never written to disk and dies with the pod. A restart is a new
   key; there is nothing to store, back up or rotate.
3. **Port.** Allocate a listen port from a per-node range and open it in the
   node firewall (VPC interface, cluster subnet only).
4. **MTU.** Lower the pod's veth MTU so the guest fits inside WireGuard over
   the VPC. The VPC NIC is 1450, so 1390 over IPv4, 1370 if the endpoints
   are IPv6. Kata copies the veth MTU into the VM. **Set `wgt0` to the same
   MTU.** WireGuard pads each packet to a multiple of 16 bytes, up to the
   interface MTU; at its default of 1420, a full 1390-byte packet pads to
   1392 and the outer packet is 1452 bytes, two over the VPC, so every
   full-size packet fragments. (This happened in the plugin test: every
   packet split in two, reassembly failures drove the retransmits, and four
   parallel streams stalled completely.)
5. **Record.** Write the public key, endpoint (`<node VPC IP>:<port>`), pod
   IPs and the VM's MAC (the veth's) to `/run/mycorrhizal/<container id>`.
   The plugin has no cluster credentials; seed-host-agent publishes them.

At pod DEL the plugin deletes `wgt0` (the namespace takes it anyway),
releases the port and removes the firewall rule. Anything without a record
is passed through untouched.

### seed-host-agent: data path and peering (sandbox up)

seed-host-agent already watches every seed-managed pod on its node
(`netpol.ts`) and knows each one's namespace, instance label, IPs and expose
annotation. Once a pod's `tap0_kata` exists it:

1. **Finishes the data path.**
   - Inbound: the pod IPs come off the namespace's `eth0` (the VM owns them;
     nothing in the namespace needs them), get `/32` and `/128` routes to
     `tap0_kata`, and permanent neighbor entries for the VM's MAC. Decrypted
     packets are routed to the VM.
   - Outbound: tc rules on `tap0_kata`, ahead of Kata's mirror, send packets
     for each mesh peer's IPs straight into `wgt0`.
   - **IPv6 neighbor discovery stays on Kata's mirror** (a higher-priority
     rule passes ICMPv6 types 135 and 136 to `eth0`). Same-node peers share
     an on-link `/64`, so the VMs find each other with neighbor discovery;
     routed through WireGuard, those packets lose their hop limit of 255 and
     receivers drop them (RFC 4861). IPv4 needs no equivalent: ARP isn't IP.
   - Everything else (DNS, internet egress, kubelet probes) keeps Kata's
     layer-2 mirror through flannel, unchanged.
2. **Publishes** the record as pod annotations,
   `seed.loom.farm/mycorrhizal-pubkey` and
   `seed.loom.farm/mycorrhizal-endpoint`.
3. **Peers:** for each local pod, configures as WireGuard peers every pod
   **on another node** it may talk to, with `allowed-ips` set to that pod's
   IPs (`/32` and `/128`), and adds their tc rules. Peers on the same node
   aren't tunneled: their traffic stays on Kata's mirror through the node
   bridge. Encrypting it buys nothing, since the plaintext is on that host's
   taps either way, and it costs 12–17× in throughput (see
   [Performance](#performance)). Source validation (below) gives same-node
   traffic the same identity guarantee.
4. **Sets the readiness gate** `seed.loom.farm/mycorrhizal-ready` once the
   data path and peers are in place. The pod isn't Ready before then.

"May talk to" is today's policy: **every pod in the same namespace.** When
`seed.firewall` / `seed.connect` are implemented, their rules compile to
peer sets (plus ports, below) instead of NetworkPolicy objects. Peering a
cross-namespace instance is adding it to the peer list.

### What the mesh gives instances

- **Identity is the source address.** WireGuard accepts a decrypted packet
  only if its source is in the sending peer's `allowed-ips`, so inside the
  mesh a source IP *is* an authenticated instance. `pg_hba.conf`, allowlists
  and firewall rules work as written, with no certificates.
- **Every protocol works.** It's IP, so TCP, UDP and in-protocol TLS
  negotiation (PostgreSQL's `SSLRequest`) all pass untouched. Applications
  speak plaintext to their peers; the wire never carries it.
- **No guest changes.** The VM sees an ordinary NIC. Any guest OS works.

### Enforcement

Per-instance tc rules in the pod namespace, maintained by the host-agent
alongside today's iptables chains:

- **Source validation (`tap0_kata` ingress):** drop anything the VM sends
  from an address that isn't its own. Every packet leaving an instance then
  carries a true source, which is what makes same-node traffic (not
  tunneled) as trustworthy as mesh traffic.
- **Cross-node plaintext (`eth0` ingress):** drop traffic from a seed pod on
  another node that arrives through flannel. Between nodes,
  instance-to-instance traffic is WireGuard or nothing; this also covers
  spoofed mesh-peer sources.
- **Ports:** `seed.firewall` port restrictions apply to traffic heading to
  the VM from `wgt0` and from same-node peers.

DNS, exposed-port ingress and internet egress keep today's rules.

### Tests (2026-11-03, seed-atl1-1 and seed-atl1-2)

**1. By hand.** Two busybox Kata pods, one per node; WireGuard set up by
hand after the pods started; temporary firewall rule for the ports.

| Check | Result |
|---|---|
| HTTP and ping between pods over `wgt0` | Worked (ping about 1.2 ms), handshake completed |
| Test traffic inside flannel VXLAN | **None**. Every inner flow VXLAN carried was other tenants'; the response body never appeared on the wire |
| Non-mesh traffic (cluster DNS) | Unchanged, through flannel |
| Spoof-drop rule on `eth0` | Mesh traffic unaffected |
| Plaintext on `tap0_kata` visible to node root | Yes, as expected (the trust-boundary cost above) |

**2. Through a chained CNI plugin.** A shell prototype of `mycorrhizal`
chained into the live flannel conflist on both nodes, acting only on test
namespaces; a script standing in for seed-host-agent. Three Kata pods (two
on atl1-1, one on atl1-2) plus canary pods in a non-matching namespace.

| Check | Result |
|---|---|
| Kata starts with `wgt0` already in the namespace | **Yes.** Each sandbox was created 74–87 ms after the plugin finished; Kata skipped the address-less `wgt0`; the VMs saw only `eth0` and `lo` |
| Lowered MTU reaches the VM | Yes (1390); 20 MiB transfers matched their md5 every time |
| Cross-node and same-node, IPv4 and IPv6 | All pairs work, once neighbor discovery stays on the mirror (see above) |
| Mesh traffic inside VXLAN | **None**; only WireGuard between the nodes |
| DEL | State, port, firewall rule and both sockets removed |
| Recreated pod | New key; port reused |
| Pods outside the test namespaces | Flannel's result returned unchanged; canaries normal |

Throughput: see [Performance](#performance).

### Performance

iperf3 between Kata pods (alpine), 10 s runs with the first 2 s discarded,
two runs each, node CPU sampled during every run. Nodes: Xeon E-2286G (6
cores, 12 threads, 4 GHz), 10 Gb/s VPC (`ixgbe`, MTU 1450), otherwise idle.
Pod MTU 1390 in both columns; `wgt0` MTU fixed at 1390.

| Test | Flannel (VXLAN) | Mesh (WireGuard) |
|---|---|---|
| Node to node over the VPC, no pods (ceiling) | 9.39 Gbit/s | 4.13 Gbit/s (plain WireGuard, host to host) |
| Cross-node, 1 stream, 1 vCPU | 8.6 Gbit/s | 3.0–3.2 Gbit/s, 0 retransmits |
| Cross-node, 1 stream, 4 vCPU | 8.4–8.6 Gbit/s | 3.4–3.55 Gbit/s, 0 retransmits |
| Cross-node, 4 streams, 4 vCPU | 8.7 Gbit/s | 3.75–3.9 Gbit/s, 89k–198k retransmits |
| Two pairs at once, NIC default hash | | 3.95 Gbit/s total |
| Two pairs at once, UDP port hashing | | **5.7 Gbit/s** total |
| Same-node, 1 stream | 34 Gbit/s | 2.0 Gbit/s (not tunneled in the design) |

**What limits it: receive, not crypto.** WireGuard's ChaCha20-Poly1305 uses
the CPU's vector instructions and runs across cores. But each peer pair is
one UDP flow, so the receiving NIC puts all of it on one receive queue and
one core (88% softirq in every WireGuard run, including plain host to host).
VXLAN gets around this by varying its UDP source port per inner flow. The
mesh reaches 76–94% of plain WireGuard; the rest is the extra hop
(forwarding into the tap, re-segmenting at the redirect).

**What follows for the design:**

- **Per pair:** about 3–4 Gbit/s on this hardware. Enough for typical
  instance traffic; bulk transfers between two instances will notice.
- **Per node: requires UDP port hashing.** `ixgbe` hashes UDP on IP
  addresses only by default, so every pair between two nodes shares one
  queue and one core. Hashing on ports too
  (`ethtool -N <vpc nic> rx-flow-hash udp4 sdfn`, and `udp6`) spreads pairs
  across cores: two pairs went from 3.95 to 5.7 Gbit/s. This is a node
  setting the Seed module must apply to the VPC NIC.
- **Same-node pairs aren't tunneled** (see peering above).
- **Four streams on one pair** still overrun that pair's receive core, and
  WireGuard drops internally until TCP backs off.

---

## Layer 2: public ingress — a keyless proxy at the instance's host

Browsers don't speak WireGuard, so public TLS has to end somewhere. It ends
at the instance's host, not at a shared ingress:

- **One proxy per instance.** Started by the Kata shim (like swtpm and
  virtiofsd today) inside the instance's pod namespace, as its own uid, under
  systemd sandboxing. A parser bug in it is contained to one tenant's
  namespace on one host, never shared between tenants.
- **Exposed ports are diverted to it.** Traffic for `seed.expose` ports is
  taken off the `eth0` → tap mirror and delivered to the proxy, which
  forwards plaintext to the VM over the tap, like mesh traffic.
- **It holds no keys.** The instance's TLS key lives in a separate
  key-holder process (another uid). The proxy asks it to sign handshakes. A
  compromised proxy can sign while it runs; it can't take the key.
- **The platform issues the certificate.** The controller generates the key
  inside the key-holder, gets the certificate (Let's Encrypt DNS-01 through
  pdns, as the ACME endpoint does today), stores it with the key, and renews
  it on the host. Instances run no ACME client.
- **Caller information** reaches the app as `X-Forwarded-For` (HTTP) or
  PROXY protocol v2 (TCP), where the instance opts into one.
- **The exception: STARTTLS.** SMTP, IMAP and XMPP clients upgrade to TLS
  mid-connection. The proxy has to understand each of these protocols to
  take over the upgrade. The list is short; it's implemented per protocol,
  not configured per instance.

There's no opt-out for terminating TLS inside the VM at first. Every
exception is config, and config is what this design removes.

---

## Layer 3: application keys — forwarded stock agents

Some keys aren't transport: SSH keys, git and GPG signing, sops decryption,
JWT signing for GitHub Apps, AWS SigV4. Applications use these directly, and
the tools that use them already speak agent protocols.

- **Key-holder:** a stock gpg-agent with `enable-ssh-support` per instance,
  on the host, started by the Kata shim, keys in the instance's state
  directory on CephFS, **encrypted at rest** (unlike `tpm2-00.permall`).
- **Into the VM over vsock:** the guest's `instance-base` runs a small relay
  that exposes the forwarded sockets at their standard paths:
  - `SSH_AUTH_SOCK` → gpg-agent's SSH socket
  - the gpg agent socket → gpg-agent's restricted `extra` socket, the socket
    made for forwarding to an untrusted machine
- **sops:** PGP recipients through the forwarded gpg-agent work with no
  changes today. Later, a small age plugin that talks to the key-holder over
  vsock, like `age-plugin-tpm` but host-backed. Either way the durable
  wrapping key never enters the VM.
- **Unlock:** by deployment policy, not a person. The key-holder unlocks at
  VM start (the controller supplies the passphrase, later from KMS through
  workload identity) and locks on VM stop, scale-down, or revocation by the
  controller. A nuketown agent inside an instance swaps the pinentry for
  nuketown's approval (see `nuketown/docs/agent-keys.md`); everything else is
  the same.
- **Controller access:** the controller may ask an instance's key-holder to
  generate a key and return a CSR. It never exports a key. This is a new
  path: until now only the VM could use its keys.

With layers 1–3 in place, nothing depends on the vTPM: identity between
instances is the mesh, public certificates are issued on the host, and sops
goes through the forwarded agent. **swtpm, `age-plugin-tpm`, `seed-tpm-init`
and the EST attestation flow are removed.** An instance that needs a
certificate identity of its own (DANE/TLSA, cross-cluster mTLS) gets a
SPIFFE certificate issued the same way as public ones: key in the
key-holder, certificate from the platform CA, no attestation step because
the platform made the key.

---

## What this replaces

| Today | With this design |
|---|---|
| vTPM (swtpm) per instance | Removed |
| TPM-bound SPIFFE certs + EST attestation | Mesh identity (source IP); platform-issued certs where a cert is needed |
| ACME client in each instance | Platform issues and renews on the host |
| TPM-bound `/seed/tls/key.pem` + socat/openssl proxies | Keyless host proxy (public); plaintext over the mesh (internal) |
| sops via `age-plugin-tpm` | sops via forwarded gpg-agent, then a host-backed age plugin |
| NetworkPolicy compiled from `seed.firewall` (planned) | WireGuard peer sets + per-instance `eth0` rules |
| Instance TLS config | None |

## Rejected alternatives

| Alternative | Why not |
|---|---|
| **Keep the vTPM** | No ed25519; secrets still decrypted into the VM; every TLS app needs TPM-aware software or a proxy; unencrypted state on CephFS |
| **Virtual smartcard** | Cloud Hypervisor has no USB, so no virtual reader: it would be `vpcd` over vsock to a card emulator we'd write and own. Fixed slots (three for OpenPGP), no ed25519 in standard PIV, and gpg-agent's ~476-byte limit toward scdaemon |
| **PKCS#11 into the VM** (`p11-kit server`) | Covers OpenSSL apps; Go and Caddy need code or plugins; every app is a separate case |
| **Patch language runtimes** to resolve key references (Go `crypto/tls`, OpenSSL provider config) | Snowballs: Go, then Rust, Java, prebuilt binaries; a patched Go toolchain loses the binary cache |
| **Terminate TLS at a shared ingress** | Plaintext across internal links |
| **Host TLS proxy for instance-to-instance** | The host parses other tenants' traffic; protocol-specific; caller identity through headers or address tricks |
| **WireGuard inside the guest** | The private key lives in the guest kernel, readable by guest root unless Seed patches WireGuard to be write-only and enforces kernel lockdown; peer lists editable by tenants |
| **flannel `wireguard-native`** | One key per node, not per instance; no identity |

## Open questions

Answered by the 2026-11-03 tests: sandbox creation with `wgt0` present,
dual-stack, port reuse after DEL, same-node pairs (not tunneled), and
throughput (see [Performance](#performance)).

1. **Port range size.** One port per mesh pod per node; the prototype used
   100 (51900–51999). Size it from the per-node pod limit.
2. **Per-pair ceiling.** About 3–4 Gbit/s on this hardware. If two instances
   ever need more, options include more than one WireGuard interface per pod,
   with flows hashed across them. Not needed until a workload asks.
3. **Throughput on real workloads.** The numbers above are iperf3 on idle
   nodes. Measure a busy node with many pairs once port hashing is applied.
4. **Ingress diversion.** Exactly where exposed-port traffic leaves Kata's
   mirror for the proxy (tc in the pod namespace is the obvious place), and
   how the proxy and key-holder are packaged for the shim.
5. **Key-holder unlock source.** Controller-supplied passphrase first; KMS
   through workload identity later. Where the encrypted keys and their
   passphrases live on CephFS.

## Phasing

1. **Mesh.** `mycorrhizal` CNI plugin; host-agent data path, publishing and
   peering; readiness gate; source validation and cross-node enforcement;
   UDP port hashing on the VPC NIC. Within-namespace only, matching today's
   policy.
2. **Application keys.** Per-instance gpg-agent key-holder in the shim,
   vsock relay in `instance-base`, sops through the forwarded agent.
3. **Ingress.** Per-instance keyless proxy; host-side issuance and renewal;
   remove in-instance ACME. STARTTLS protocols one at a time.
4. **Remove the vTPM.** Drop swtpm, `age-plugin-tpm`, `seed-tpm-init`, EST;
   migrate existing instances' sops files to the new recipients.
5. **Cross-namespace.** `seed.firewall` / `seed.connect` compile to peer
   sets.
