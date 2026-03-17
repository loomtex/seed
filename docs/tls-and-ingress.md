# TLS and Ingress Design

## Overview

Every seed instance gets L3 routing, automatic DNS, and access to a
platform ACME endpoint for TLS certificates. The platform handles
infrastructure; instances handle their own L7 (Caddy, nginx, etc.).

## `seed.expose`

Declares which ports an instance exposes to the network. The attr
name is looked up in `/etc/services` for default port and protocol,
so common services need minimal configuration:

```nix
seed.expose.https.enable = true;       # 443/tcp from /etc/services
seed.expose.postgresql.enable = true;  # 5432/tcp
seed.expose.ssh.enable = true;         # 22/tcp
seed.expose.domain.enable = true;      # 53/udp (dns protocol handling)
```

Override defaults when needed:

```nix
seed.expose.https = {
  enable = true;
  port = 8443;         # override the /etc/services default
};

seed.expose.myapp = {  # not in /etc/services — must specify
  port = 9090;
  protocol = "tcp";
};
```

Each expose entry generates a k8s Service and DNS record for the
instance.

## DNS

Each instance with `seed.expose` entries gets DNS records:

```
<instance>.<namespace>.seed.loom.farm → instance LoadBalancer IP(s)
```

For example: `web.s-gaydazldmnsg.seed.loom.farm`

The controller creates AAAA records in PowerDNS during reconciliation,
derived from the same metadata that generates LoadBalancer services.
No user configuration beyond `seed.expose`. A records are added
post-alpha alongside IPv4 gateway generation.

The `seed.loom.farm` subdomain scopes all tenant traffic, keeping
`loom.farm` clean for the product surface. Per-cluster subdomains
(e.g. `atl1.seed.loom.farm`) are possible later.

Custom domains are deferred to post-alpha.

## TLS

### Architecture

The controller embeds an ACME endpoint alongside its existing HTTP
server (webhook handler). It speaks standard ACME protocol to
instances, and performs DNS-01 challenges against Let's Encrypt via
the PowerDNS API on their behalf.

Instances use their web server's built-in ACME client pointed at
the controller's ACME endpoint. No DNS API keys, challenge logic,
or cert management is needed from the instance author. The issued
certificates are real LE-signed certs, browser-trusted via the
standard LE chain.

### Authorization

No instance-facing ACME challenge is needed. The platform assigned
the domain — challenging the instance to prove it controls something
the platform gave it is circular. Instead, the controller validates
that the requested domain matches the caller's namespace. Network
policy enforces namespace identity at the network level.

### Certificate Scope

Per-instance single-name certificates:
`<instance>.<namespace>.seed.loom.farm`. Each instance owns its own
certificate and private key. No wildcard certs, no shared keys, no
edge decryption — TLS terminates inside the instance that owns the
traffic.

### ACME Configuration

When `seed.acme = true`, the platform injects the controller's ACME
directory URL into the instance at a well-known path
(`/seed/acme/directory`).

`seed.acme` defaults to `true` when any expose entry matches a
platform-managed whitelist of TLS-expecting services (initially
just `https`; expanded over time to `imaps`, `smtps`, etc.).
Set it explicitly for services not on the whitelist, or `false`
to opt out if bringing your own certs.

### Instance Author Experience

```nix
{ ... }: {
  seed.expose.https.enable = true;

  # seed.acme is automatically true because of seed.expose.https

  services.caddy.virtualHosts."myapp.s-xyz.seed.loom.farm" = {
    extraConfig = ''
      tls {
        ca {$SEED_ACME_URL}
      }
      reverse_proxy localhost:8080
    '';
  };
}
```

Non-HTTP example:

```nix
{ ... }: {
  seed.expose.postgresql.enable = true;
  seed.acme = true;  # explicit — no https expose to trigger it

  # Instance uses ACME cert for postgres TLS
  services.postgresql.settings.ssl_cert_file = "/var/lib/acme/cert.pem";
}
```

### Why ACME

- Standard protocol — every web server already speaks it
- Renewal is built-in (Caddy, certbot, lego all handle it)
- Debuggable with standard tools
- An agent helping a user debug cert issues can rely on existing
  ACME knowledge rather than custom platform docs
- No custom cert delivery protocol to build or document

### Controller ACME Endpoint Responsibilities

1. Receive certificate orders from instances
2. Validate that the requested domain matches the caller's namespace
3. Perform DNS-01 challenge against Let's Encrypt using pdns API
4. Return the LE-signed certificate chain
5. Handle renewals (standard ACME renewal — client-driven)

The controller holds the LE account key and pdns API key. Instances
need neither.

## Private Key Security: TPM Integration

### Baseline

Instance private keys are the instance's concern. By default,
keys are file-based — standard ACME client behavior. This works
and is simple.

### Hardware-Bound Keys via vTPM

Each seed instance already has a vTPM (`/dev/tpm0`) backed by
swtpm on the host. Instances can generate TLS private keys inside
the TPM so the key never exists in memory outside the TPM.

The TLS server uses PKCS#11 or the tpm2-tss OpenSSL engine to
perform signing operations via the TPM. From the ACME protocol's
perspective, nothing changes — the CSR is generated using the
TPM-held key, and the ACME flow proceeds normally.

This is a per-instance choice, not a platform requirement. The
ACME endpoint doesn't care whether the key is file-based or
TPM-resident.

### Enforcing TPM Keys via Attestation

The controller's ACME endpoint can optionally require TPM attestation
as part of the certificate issuance flow:

1. Instance submits a CSR to the ACME endpoint
2. Endpoint challenges: "prove this key is TPM-resident"
3. Instance provides a TPM attestation quote, signed by the TPM's
   endorsement key (EK)
4. Endpoint verifies the attestation chain back to the swtpm EK
5. Only if attestation passes: proceed with DNS-01 and sign the cert

Since the platform controls all swtpm instances, we know every EK.
The controller maintains an allowlist — only certs for CSRs where
the attesting TPM matches an instance we deployed.

**Security property**: even with code execution in a pod, an
attacker cannot get a cert signed for a key that isn't in the
vTPM we provisioned. The private key is born in the TPM and
never leaves.

**Implementation**: ACME supports extension points for custom
challenge types. The attestation challenge would be specific to
our endpoint — external ACME clients wouldn't need modification
since the challenge-response flow is standard ACME machinery.

**Rollout**: attestation is additive. Start without it, add as
a policy knob later. The ACME interface stays the same from the
client's perspective.

## Phasing

1. **DNS auto-registration** — controller creates AAAA records
   from `seed.expose` metadata during reconciliation
2. **ACME endpoint in controller** — LE DNS-01 via pdns,
   namespace authorization, standard ACME protocol
3. **Instance integration** — inject ACME directory URL, document
   Caddy/nginx config patterns
4. **TPM key generation** — optional PKCS#11 key generation in
   instance-base, documented as best practice
5. **Attestation enforcement** — optional policy requiring
   TPM-resident keys for cert issuance

## Post-Alpha: IPv4 Gateway Generation

### Constraint

One IPv4 address maximum per seed flake. IPv6 is the primary path —
each instance gets direct LoadBalancer addresses. IPv4 is an optional
add-on for flakes that need legacy reachability.

### Auto-Generated Gateway Instance

When a flake declares `ipv4.routes`, the module generates a gateway
seed instance from the sibling instances' `seed.expose` metadata.
No hand-authored gateway needed.

```nix
ipv4 = {
  enable = true;
  routes = {
    dns  = { port = 53;  protocol = "dns"; instance = "dns"; };
    https = { port = 443; protocol = "tcp"; instance = "web"; };
    ssh  = { port = 22;  protocol = "tcp"; instance = "silo"; };
  };
};
```

The module (`lib/mkGateway.nix`) reads `ipv4.routes` and the target
instances' expose declarations, then emits a NixOS module with:

- socat L4 proxies for TCP/UDP/DNS routes
- Caddy reverse proxy for HTTP/HTTPS routes (with TLS via the
  platform ACME endpoint)
- Firewall rules matching the declared ports

The generated gateway is a real seed instance — same build, deploy,
and lifecycle as any other. The controller sees it as just another
instance in the namespace.

### Extensibility

Since the gateway is a NixOS module, flake operators can extend it:

```nix
# Override or extend the auto-generated gateway
ipv4.gateway.extraConfig = { ... }: {
  services.caddy.virtualHosts."custom.example.com" = { ... };
};
```

### Cross-Namespace IPv4 Routing

A single IPv4 address can route to instances across multiple seed
namespaces. The route table gains a `namespace` field:

```nix
ipv4.routes.other-app = {
  port = 8080;
  protocol = "tcp";
  instance = "api";
  namespace = "s-othernamesp";
};
```

The generated gateway proxies to ClusterIP services in the target
namespaces. Network policy must explicitly allow this cross-namespace
traffic.

## Network Policy (Related)

Network policy is a prerequisite for trusting the ACME namespace
authorization. Without it, any pod can impersonate any namespace.

See separate network policy design for:
- Default deny all ingress/egress per namespace
- Allow intra-namespace communication
- Allow DNS (kube-dns)
- Allow controller API access (shell auth, ACME)
- Allow explicit `seed.connect` cross-namespace traffic
- Allow internet egress
