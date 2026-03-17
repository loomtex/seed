# TLS and Ingress Design

## Overview

Every seed instance gets L3 routing, automatic DNS, and access to a
platform ACME endpoint for TLS certificates. The platform handles
infrastructure; instances handle their own L7 (Caddy, nginx, etc.).

## DNS

Each instance with `seed.expose` entries gets DNS records:

```
<instance>.<namespace>.seed.loom.farm → instance LoadBalancer IP(s)
```

For example: `web.s-gaydazldmnsg.seed.loom.farm`

The controller creates A/AAAA records in PowerDNS during reconciliation,
derived from the same metadata that generates LoadBalancer services.
No user configuration beyond `seed.expose`.

The `seed.loom.farm` subdomain scopes all tenant traffic, keeping
`loom.farm` clean for the product surface. Per-cluster subdomains
(e.g. `atl1.seed.loom.farm`) are possible later.

Custom domains are deferred to post-alpha.

## TLS

### Architecture

An internal ACME endpoint runs as a platform service (step-ca or
similar). It speaks standard ACME protocol and handles DNS-01
challenges against Let's Encrypt via the PowerDNS API.

Instances use their web server's built-in ACME client pointed at
the internal endpoint. No ACME configuration, DNS API keys, or
cert management is needed from the instance author.

### Certificate Scope

Per-namespace wildcard certificates: `*.<namespace>.seed.loom.farm`.
This covers all instances within a tenant's namespace with a single
cert. Wildcard certs only match one subdomain level deep, which
aligns with our `<instance>.<namespace>.seed.loom.farm` naming.

### Instance Author Experience

```nix
{ ... }: {
  seed.expose.https = 443;

  services.caddy.virtualHosts."myapp.s-xyz.seed.loom.farm" = {
    # Caddy's built-in ACME talks to the platform endpoint.
    # TLS just works.
    extraConfig = "reverse_proxy localhost:8080";
  };
}
```

The platform could inject the ACME directory URL via environment
variable or a well-known config path (`/seed/acme/directory`), so
instance authors don't hardcode the internal endpoint.

### Why ACME

- Standard protocol — every web server already speaks it
- Renewal is built-in (Caddy, certbot, lego all handle it)
- Debuggable with standard tools
- An agent helping a user debug cert issues can rely on existing
  ACME knowledge rather than custom platform docs
- No custom cert delivery protocol to build or document

### Internal ACME Endpoint Responsibilities

1. Receive certificate orders from instances
2. Validate that the requesting instance is authorized for the
   requested domain (namespace ownership check)
3. Perform DNS-01 challenge against Let's Encrypt using pdns API
4. Return the signed certificate chain
5. Handle renewals (standard ACME renewal — client-driven)

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

The internal ACME endpoint can optionally require TPM attestation
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
our internal endpoint — external ACME clients wouldn't need
modification since the challenge-response flow is standard ACME
machinery.

**Rollout**: attestation is additive. Start without it, add as
a policy knob later. The ACME interface stays the same from the
client's perspective.

## Phasing

1. **DNS auto-registration** — controller creates A/AAAA records
   from `seed.expose` metadata during reconciliation
2. **Internal ACME endpoint** — step-ca deployment, pdns DNS-01
   solver, namespace authorization
3. **Instance integration** — inject ACME directory URL, document
   Caddy/nginx config patterns
4. **TPM key generation** — optional PKCS#11 key generation in
   instance-base, documented as best practice
5. **Attestation enforcement** — optional policy requiring
   TPM-resident keys for cert issuance

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
