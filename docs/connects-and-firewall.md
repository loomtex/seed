# Connects & Firewall

Service connectivity and network access control for the Seed platform.

This document specifies how Seed instances discover, connect to, and
authorize communication with other instances — both within a flake
(intra-namespace) and across flakes (cross-namespace). It replaces
earlier designs based on a bidirectional connect graph abstraction.

## Design principles

1. **Agents are the primary operators.** Every abstraction must be
   evaluated against whether it helps or hinders an agent reasoning
   about the system. Hidden state and opaque graphs inhibit agent
   effectiveness. Inspectable primitives enable it.

2. **Build-time verification over runtime surprises.** If a
   connectivity problem can be caught at `nix build`, it must be.
   Runtime webhook bounces are a fallback, not a design target.

3. **DNS for discovery, SPIFFE for identity, firewall for access.**
   Three orthogonal systems, each visible and debuggable independently.
   No unified "connect" abstraction that merges them into a single
   opaque surface.

4. **Wrapped modules for common cases, primitives for everything
   else.** `seed.services.postgresql` handles SPIFFE plumbing
   automatically. Uncommon services use the same primitives directly.

## Why not a connect graph

Earlier designs explored a `seed.connect` abstraction where instances
declared bidirectional relationships:

```nix
# Earlier design (rejected)
seed.connect.db = "postgresql";  # on the API instance
```

The platform would derive the full connectivity graph, configure mTLS,
generate firewall rules, and resolve DNS — all from these declarations.

This was rejected for three reasons:

### Fetch depth

Cross-namespace connects require knowledge of the remote flake's
interface. Using real flake inputs creates a transitive fetch problem:
if A connects to B and B connects to C, evaluating A fetches B and C.
At scale this becomes unmanageable. Stub flakes served by the platform
break the cycle but introduce chicken-and-egg problems (the platform
needs the evaluated config to generate stubs, but evaluation needs the
stubs).

### Hidden state

The connect graph merges identity, discovery, and access control into a
single declaration. When something fails, the agent must reverse-engineer
which layer broke. A `seed.connect.db = "postgresql"` that stops working
could be a DNS issue, a certificate issue, a firewall issue, or a
schema issue — but the abstraction hides which.

### Agent effectiveness

Agents work best with explicit, inspectable primitives. An agent can
read a firewall rule and understand what traffic is allowed. An agent
can inspect a SPIFFE SVID and verify identity. An agent can query DNS
and confirm resolution. A connect graph that does all three implicitly
gives the agent less to work with when debugging or extending behavior.

## Architecture

### Identity: SPIFFE via vTPM

Each Seed instance has a vTPM-backed identity (see `auth-and-identity.md`).
The platform runs a SPIRE server; each instance's SPIRE agent attests
via vTPM and receives an SVID (SPIFFE Verifiable Identity Document):

```
spiffe://seeds.loom.farm/<namespace>/<instance>
```

Where `<namespace>` is derived from the seed flake's IPNS CID:

```
base32(hash(ipns-cid))
```

This provides stable, self-sovereign namespace identity — the user can
change their flake's hosting URL without changing their namespace name,
by updating the IPNS record with their private key.

### Discovery: DNS

Instances are discoverable via deterministic DNS names:

```
<instance>.<namespace>.seeds.loom.farm
```

For intra-namespace (same flake), instances resolve each other using
the same pattern, with the namespace derived from their own flake CID.

For cross-namespace, the DNS name of the remote instance is derived
from the remote flake's CID — the same CID that appears in the SPIFFE
identity, so name and identity are cryptographically bound.

### Identity in DNS: DANE/TLSA

SPIFFE certificate fingerprints are published as TLSA records:

```
_5432._tcp.postgres.abc123.seeds.loom.farm. IN TLSA 3 1 1 <sha256>
```

This allows any party to verify that a certificate presented by a
service matches the identity published in DNS, without trusting the
platform's CA chain. Useful for cross-cluster verification and external
tooling.

### Access control: Firewall DSL

Network access is defined explicitly in the seed flake using a firewall
DSL that references identities and service names:

```nix
seed.firewall = {
  # Intra-namespace: allow API to reach PostgreSQL
  allow.api-to-db = {
    from = "api";
    to = "postgres";
    port = 5432;
  };

  # Cross-namespace: allow friend's Plex to reach my media store
  allow.friend-media = {
    from = connects.friend.plex;  # resolves to SPIFFE identity
    to = "media-store";
    port = 8080;
  };

  # Outbound: allow Immich to reach S3-compatible storage
  allow.immich-s3 = {
    from = "immich";
    to = "*.s3.loom.farm";
    port = 443;
  };
};
```

Each rule compiles to a Kubernetes NetworkPolicy applied to the
instance's pod. The platform's network policy controller handles:

- Intra-cluster rules: standard NetworkPolicy with pod selectors
- Cross-cluster rules: NetworkPolicy with IP-based selectors, resolved
  from DNS at reconciliation time (primary IPv6)
- Ingress rules: derived from `seed.expose` configuration (see
  `tls-and-ingress.md`)

The firewall DSL does not hide what it produces. An agent can inspect
the generated NetworkPolicy resources directly. The DSL is sugar over
primitives, not a replacement for them.

## mkConnects: cross-namespace resolution

Cross-namespace connectivity requires knowing the remote instance's
DNS name and SPIFFE identity. The `mkConnects` function derives both
from a flake reference:

```nix
let
  connects = seed.mkConnects {
    friend = "github:friend/their-seed";
    alice = "github:alice/her-seed";
  };
in {
  # connects.friend.plex yields:
  # {
  #   dns = "plex.<base32(hash(friend-ipns-cid))>.seeds.loom.farm";
  #   spiffe = "spiffe://seeds.loom.farm/<base32(hash(friend-ipns-cid))>/plex";
  # }

  seed.firewall.allow.friend-plex = {
    from = connects.friend.plex;
    to = "media-store";
    port = 8080;
  };

  # Use the DNS name in service configuration
  services.myapp.upstreamUrl = "https://${connects.friend.plex.dns}:443";
}
```

### How mkConnects works

1. Takes a set of `name = flake-reference` pairs
2. For each reference, fetches only the flake metadata (not the full
   closure) to extract the IPNS CID
3. Derives the namespace from `base32(hash(ipns-cid))`
4. Returns an attribute set where each instance name yields `{ dns; spiffe; }`

The fetch is lightweight — only flake metadata, not the full evaluation.
Results are cached in the flake lock. This avoids the transitive fetch
depth problem because mkConnects never evaluates the remote flake's
NixOS configuration.

### connect.to and connect.from

At the seed metadata level, instances declare what they offer and what
they consume:

```nix
seed.connect.from = {
  # Services this instance offers to others
  postgres = { port = 5432; protocol = "postgresql"; };
};

seed.connect.to = {
  # Services this instance consumes (intra-namespace)
  media.postgres = { port = 5432; };
  # Cross-namespace via mkConnects
  media.friend-plex = { target = connects.friend.plex; port = 443; };
};
```

`connect.from` declarations are visible to the platform controller
and used to:
- Validate that firewall rules reference real services
- Generate DANE/TLSA records for the service
- Inform the network policy controller about expected ingress

`connect.to` declarations are used to:
- Generate firewall rules (if not explicitly defined in `seed.firewall`)
- Provide connection strings to consuming services
- Validate at build time that the target exists (intra-namespace) or
  that the remote namespace is reachable (cross-namespace)

For intra-namespace connects, `connect.to` can reference instances
directly by name — the full flake definition is available at eval time,
so the platform validates that the target instance exists and exposes
the declared service.

## Wrapped NixOS modules

Common services get `seed.services.*` modules that handle SPIFFE
plumbing without hiding state:

```nix
# seed.services.postgresql wraps services.postgresql with:
# - SPIFFE SVID as server certificate
# - Client certificate auth via platform CA
# - pg_hba entries mapping SPIFFE CNs to database roles
# - DANE/TLSA record generation
# - connect.from declaration

seed.services.postgresql = {
  enable = true;
  databases.myapp = {
    # Clients with SPIFFE ID matching "api" instance get this role
    clients.api = { role = "myapp_rw"; };
  };
};
```

The module is a convenience layer. Everything it configures is visible
in the evaluated NixOS config. An agent can read the generated pg_hba
entries, inspect the certificate paths, and understand exactly what
authentication is in effect.

If the wrapped module doesn't fit a use case, the user (or agent) drops
down to the primitives: configure `services.postgresql` directly, use
`seed.spiffe` to get certificates, and write `seed.firewall` rules
explicitly.

## Interaction with existing specs

### auth-and-identity.md

This spec refines the instance-to-instance auth section. The vTPM →
SPIRE → SVID flow described there is the identity foundation. This
document adds:
- Namespace derivation from IPNS CID
- DANE/TLSA publication of SPIFFE identities
- mkConnects for cross-namespace identity resolution

### tls-and-ingress.md

The `seed.expose` system handles external (internet-facing) ingress.
This document handles internal (instance-to-instance) connectivity.
The network policy controller serves both:
- Ingress rules from `seed.expose` (external traffic)
- Firewall rules from `seed.firewall` (internal traffic)

## Phasing

### Phase 1: Intra-namespace

- SPIFFE identity via vTPM attestation
- DNS resolution within namespace
- `seed.firewall` DSL compiling to NetworkPolicy
- `seed.services.postgresql` as first wrapped module
- Build-time validation of intra-namespace connects

### Phase 2: Cross-namespace

- mkConnects function with flake metadata fetch
- DANE/TLSA record publication
- Cross-cluster NetworkPolicy via IP resolution
- Network policy controller cluster-awareness (for multi-cluster)

### Phase 3: Ecosystem

- Community-contributed `seed.services.*` modules
- L7 connect: per-tenant service mesh speaking application protocols
- Agent tooling for connect graph exploration and debugging
