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

### What the CNI plugin does

A chained CNI plugin (`seed-mesh`, after flannel in the k3s conflist) runs
at pod ADD for seed-managed pods:

1. **Interface.** Create `wgt0` in the **node** namespace, so its UDP socket
   binds there, then move it into the pod namespace. Give it **no address**:
   Kata skips interfaces without addresses when it builds the sandbox
   (`network_linux.go`, `addAllEndpoints`), so `wgt0` stays on the host.
2. **Key.** Generate the private key in memory and set it on the interface.
   It is never written to disk and dies with the pod. A restart is a new
   key; there is nothing to store, back up or rotate.
3. **Port.** Allocate a listen port from a per-node range and open it in the
   node firewall (VPC interface, cluster subnet only).
4. **Data path.**
   - Outbound: a tc rule on `tap0_kata`, ahead of Kata's mirror, sends
     packets for mesh peers straight into `wgt0`.
   - Inbound: the pod IP comes off the namespace's `eth0` (the VM owns it;
     nothing in the namespace needs it), gets a `/32` route to `tap0_kata`,
     and a permanent neighbor entry for the VM's MAC. Decrypted packets are
     routed to the VM.
   - Everything else (DNS, internet egress, kubelet probes) keeps Kata's
     layer-2 mirror through flannel, unchanged.
5. **MTU.** Lower the pod's veth MTU so the guest fits inside WireGuard over
   the VPC. The VPC NIC is 1450, so 1390 over IPv4, 1370 if the endpoints
   are IPv6. Kata copies the veth MTU into the VM.
6. **Publish.** Write the public key and endpoint (`<node VPC IP>:<port>`)
   to `/run/seed-mesh/<pod uid>`. The plugin has no cluster credentials;
   seed-host-agent publishes them.

At pod DEL the namespace goes away, taking `wgt0` and its socket with it;
the plugin releases the port and the firewall rule.

### Peering: from metadata Seed already has

seed-host-agent already watches every seed-managed pod on its node
(`netpol.ts`) and knows each one's namespace, instance label, IPs and expose
annotation. It gains two jobs:

- **Publish:** read `/run/seed-mesh/<pod uid>` and annotate the pod with
  `seed.loom.farm/mesh-pubkey` and `seed.loom.farm/mesh-endpoint`.
- **Peer:** for each local pod, configure as WireGuard peers every pod it
  may talk to, with `allowed-ips` set to that pod's IPs (`/32` and `/128`).

"May talk to" is today's policy: **every pod in the same namespace.** When
`seed.firewall` / `seed.connect` are implemented, their rules compile to
peer sets (plus ports, below) instead of NetworkPolicy objects. Peering a
cross-namespace instance is adding it to the peer list.

A pod isn't Ready until its peers are configured: a readiness gate,
`seed.loom.farm/mesh-ready`, set by the host-agent.

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

Per-instance rules on the namespace's `eth0` ingress, maintained by the
host-agent alongside today's iptables chains:

- **Spoofing:** drop anything arriving through flannel with a mesh peer's
  source IP. A mesh peer's packets only ever arrive through `wgt0`.
- **Plaintext between instances:** drop seed-pod-to-seed-pod traffic that
  arrives through flannel at all. Instance-to-instance traffic is mesh
  traffic or nothing.
- **Ports:** `seed.firewall` port restrictions apply to traffic leaving
  `wgt0` toward the VM.

DNS, exposed-port ingress and internet egress keep today's rules.

### Test (2026-11-03, seed-atl1-1 and seed-atl1-2)

Two busybox Kata pods, one per node; WireGuard set up by hand after the pods
started, exactly as steps 1, 2 and 4 above; temporary firewall rule for the
ports.

| Check | Result |
|---|---|
| HTTP and ping between pods over `wgt0` | Worked (ping about 1.2 ms), handshake completed |
| Test traffic inside flannel VXLAN | **None**. Every inner flow VXLAN carried was other tenants'; the response body never appeared on the wire |
| Non-mesh traffic (cluster DNS) | Unchanged, through flannel |
| Spoof-drop rule on `eth0` | Mesh traffic unaffected |
| Plaintext on `tap0_kata` visible to node root | Yes, as expected (the trust-boundary cost above) |

Not yet tested: setup at sandbox creation through a real CNI plugin (the
address-less skip is from reading Kata's code), IPv6, large transfers at the
lowered MTU, and pods on the same node.

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

1. **Sandbox creation.** Confirm with a real `seed-mesh` CNI plugin that a
   pod starts with an address-less `wgt0` already in its namespace.
2. **IPv6 and dual-stack.** Pods are dual-stack; `allowed-ips` and the tap
   routes must cover both families. Endpoint address family follows the VPC.
3. **Port allocation.** Per-node range size, and reuse after pod DEL.
4. **Same-node pairs.** Encrypt anyway (one model everywhere) or route
   locally. Current plan: encrypt.
5. **Ingress diversion.** Exactly where exposed-port traffic leaves Kata's
   mirror for the proxy (tc in the pod namespace is the obvious place), and
   how the proxy and key-holder are packaged for the shim.
6. **Key-holder unlock source.** Controller-supplied passphrase first; KMS
   through workload identity later. Where the encrypted keys and their
   passphrases live on CephFS.
7. **Throughput.** WireGuard in the node kernel, per instance. Measure
   against today's VXLAN path.

## Phasing

1. **Mesh.** `seed-mesh` CNI plugin; host-agent publishing and peering;
   readiness gate; `eth0` enforcement. Within-namespace only, matching
   today's policy.
2. **Application keys.** Per-instance gpg-agent key-holder in the shim,
   vsock relay in `instance-base`, sops through the forwarded agent.
3. **Ingress.** Per-instance keyless proxy; host-side issuance and renewal;
   remove in-instance ACME. STARTTLS protocols one at a time.
4. **Remove the vTPM.** Drop swtpm, `age-plugin-tpm`, `seed-tpm-init`, EST;
   migrate existing instances' sops files to the new recipients.
5. **Cross-namespace.** `seed.firewall` / `seed.connect` compile to peer
   sets.
