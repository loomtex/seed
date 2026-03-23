# Auth & Identity

Seed instances run in hardware-isolated VMs with TPM-backed identities.
This document specifies how those identities are used for authentication
between instances, between users and instances, and for secret management
at the platform boundary.

## Principles

1. **No passwords between instances.** Inter-instance auth uses mutual TLS
   with TPM-backed certificates. No shared secrets, no env var injection.

2. **The platform never owns user identity.** Users authenticate via an
   OIDC provider they control. The platform may host a managed provider
   for convenience, but realm export and migration to self-hosted must
   always be possible.

3. **Secrets are generated as close to their consumer as possible** and
   never travel further than necessary. Platform secrets stay in the
   platform. Instance secrets stay in the instance. User credentials go
   directly into the user's security context.

4. **Apps that lack proper auth get patched.** Seed ships nix overlays
   that add OIDC or certificate auth to applications that only support
   passwords. Same model as the Kata and nix-snapshotter patches.

## TPM as identity root

Every Seed instance has a vTPM device (`/dev/tpm0`) backed by swtpm on
the host, with persistent state on CephFS. This TPM serves as the root
of trust for all instance-level cryptographic operations:

- **age decryption** — sops-nix decrypts secrets using a TPM-backed age
  identity generated on first boot (`age-plugin-tpm`).
- **X.509 key material** — the TPM generates a non-extractable private
  key used for certificate signing requests. The private key never
  leaves the TPM.
- **Proof of identity** — an instance can prove it is who it claims to
  be without any shared secret existing anywhere.

## Secret classes

Secrets in Seed fall into five classes, each with a different
provisioning model:

### Platform-internal

Secrets that exist only within the platform's control plane: webhook
HMAC keys, controller auth tokens, inter-component credentials.

**Provisioning:** Fully automatic. The controller generates, distributes,
and rotates these. No user involvement.

**Target state:** Users never see or manage these.

### Instance identity

TPM age keys, X.509 certificates, instance-specific credentials derived
from the TPM.

**Provisioning:** Auto-generated on first boot. cert-manager handles
certificate lifecycle (issuance, renewal, revocation). The TPM provides
key material; cert-manager signs it.

**Target state:** Fully automatic after initial TPM enrollment.

### Instance-to-instance

Authentication credentials between instances in the same flake — for
example, an API server connecting to its database.

**Provisioning:** Mutual TLS via cert-manager. When an instance declares
`seed.connect.db = "postgres"`, the platform:

1. Issues a client certificate for the connecting instance via
   cert-manager, using TPM-backed key material.
2. Configures the target service to accept client certificates signed
   by the platform CA.
3. Maps the certificate CN to the appropriate service role/user.

No passwords are generated, transmitted, or stored.

**Target state:** `seed.connect` configures mTLS automatically. The
instance author never thinks about credentials.

### User authentication

How a human user authenticates to services running on their instances —
logging into GoToSocial, Grafana, Vaultwarden, etc.

**Provisioning:** OIDC via a standards-compliant identity provider.

The platform may host a managed multi-tenant Keycloak instance for
convenience. Each user gets a realm with self-serve metadata export.
Users can migrate to a self-hosted provider at any time by:

1. Exporting their realm metadata from the managed instance.
2. Importing into their own Keycloak (or any OIDC provider), running
   on Seed or elsewhere.
3. Updating their instances' OIDC issuer URL.

The `seed.services.*` modules configure OIDC client registration
automatically. The instance author specifies their issuer URL:

```nix
seed.auth.oidc.issuer = "https://id.loom.farm/realms/josh";
```

User enrollment:

```
seed activate
```

This enrolls a FIDO2/passkey credential with the IdP. The user gets SSO
across all their OIDC-capable instances. No per-service passwords.

**Target state:** One enrollment, SSO everywhere. No passwords to
manage, no credentials to communicate.

### External secrets

API keys and credentials from third-party services: Stripe, DNS
providers, mail relay credentials. These originate outside the platform
and must be provided by the user.

**Provisioning:** `seed encrypt` with git as the transport.

```
seed encrypt social < secrets.yaml
```

This command:

1. Fetches the target instance's TPM public key from the platform.
2. Encrypts stdin with that key (age).
3. Creates a commit on a platform change branch in the user's repo.
4. Pushes to silo.

On next push, silo indicates pending platform branches. The user
reviews and merges. The webhook fires, the controller reconciles, and
the instance receives the encrypted secrets via sops-nix.

**Target state:** The only secrets users manually handle are the ones
that genuinely originate outside the platform.

## Instance-to-instance auth in detail

### cert-manager integration

The controller deploys a cert-manager Issuer backed by a platform CA.
Each instance that participates in mTLS gets a cert-manager Certificate
resource:

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: social-mtls
  namespace: s-gaydazldmnsg
spec:
  secretName: social-mtls-tls
  issuerRef:
    name: seed-ca
    kind: ClusterIssuer
  commonName: social.s-gaydazldmnsg.seed.loom.farm
  privateKey:
    algorithm: ECDSA
    size: 256
```

The private key is generated inside the instance using TPM key material.
cert-manager signs the CSR and delivers the certificate.

### Service configuration

The `seed.services.*` modules configure services to use mTLS
automatically. For example, a PostgreSQL module:

```nix
# Instance author writes:
seed.services.postgresql.enable = true;
seed.connect.api = "postgresql";  # on the API instance

# The platform configures:
# - PostgreSQL: ssl=on, clientcert=verify-full, pg_hba uses cert CN
# - API instance: ssl client cert from cert-manager, connection string
#   with sslmode=verify-full
```

No connection string passwords. The database trusts certificates signed
by the platform CA. The connecting instance proves identity with its
TPM-backed certificate.

### Services without native TLS

For services that don't support TLS natively (e.g., Redis without TLS,
memcached), the platform can inject a TLS sidecar or configure stunnel.
The instance author doesn't need to know — `seed.connect` handles it.

## Application auth overlays

Applications that lack OIDC or certificate auth support are patched via
nix overlays, following the same model as the Kata container runtime
patches:

```nix
# In seed's overlay
gotosocial = prev.gotosocial.overrideAttrs (old: {
  patches = (old.patches or []) ++ [
    ./patches/gotosocial-oidc.patch
  ];
});
```

The patch is a discrete, reviewable diff. When upstream releases, the
patch is rebased. If upstream adopts the feature, the patch is dropped.

For applications where patching is impractical, an auth proxy (similar
to oauth2-proxy) can sit in front of the service, handling OIDC and
translating to whatever the app requires internally.

Applications that cannot be made to work with proper auth are not
offered as first-class `seed.services.*` modules. They can still run on
Seed as plain NixOS services — the user just manages auth manually.

## The continuation model

Runtime state generated inside an instance sometimes needs to cross the
platform boundary. This is modeled as a **continuation**: the instance
completes its half of an operation and writes the intermediate result to
a shared surface. The platform picks up where the instance left off.

### Shared state surface

Each instance has a CephFS directory shared between the host and the
guest VM, currently used for TPM state at
`/var/lib/seed-controller/tpm/<ns>-<instance>/`. This surface is
extended for general-purpose state exchange:

```
/var/lib/seed-controller/state/<ns>-<instance>/
├── identity/          # TPM public key, certificates
├── exports/           # Instance-generated outputs
└── imports/           # Platform-delivered inputs
```

Inside the instance, this is mounted at `/seed/state/`.

### Git as continuation transport

For operations that modify the user's repository (sops enrollment,
secret encryption), the platform uses git branches:

1. Instance boots, generates TPM identity.
2. Controller detects new public key on the shared state surface.
3. Controller creates a branch (`seed/social-enroll`) on the user's
   repo via silo.
4. Branch updates `.sops.yaml` with the new age recipient.
5. User pushes to silo; silo reports pending platform branches.
6. User merges.
7. Webhook fires; controller reconciles with updated sops config.

The merge step is the user's approval of the continuation. The platform
did the mechanical work; the user does the trust step.

For fully automated continuations (platform-internal secrets,
service-to-service cert enrollment), the controller merges its own
branches — no human in the loop because no human trust is required.

### Seed shell continuations

The seed shell exposes continuations as commands with platform state
curried in:

```
seed encrypt <instance>     # knows TPM key, encrypts stdin
seed state <instance>       # reads shared state surface
seed activate               # enrolls user with IdP
```

Each command is a partially applied function. The platform filled in
what it knows (keys, addresses, endpoints). The user provides what
requires human judgment or trust.

## seed.services.* module contract

A `seed.services.*` module provides turnkey deployment of an application
with auth and identity handled by the platform. Each module:

1. **Configures the upstream NixOS service** with appropriate settings.
2. **Applies auth overlays** if the upstream package needs patching.
3. **Declares cert-manager Certificates** for mTLS where applicable.
4. **Configures OIDC client registration** with the user's IdP.
5. **Declares storage and expose options** via `seed.storage` and
   `seed.expose`.
6. **Implements an activation flow** for initial user enrollment.

Example — a GoToSocial module:

```nix
# The user writes:
{ ... }: {
  seed.services.gotosocial = {
    enable = true;
    domain = "social.example.com";
  };
  seed.auth.oidc.issuer = "https://id.example.com/realms/me";
}

# The module handles:
# - GoToSocial package with OIDC patch applied
# - Caddy reverse proxy with platform ACME
# - OIDC client auto-registration
# - SQLite on persistent storage
# - cert-manager certificate for federation TLS
# - Activation: `seed activate social` enrolls user
```

The long-term goal is a contribution ecosystem where the community
submits `seed.services.*` modules — similar to nixpkgs, but with a
higher bar: services must work with the platform's auth and identity
model out of the box.
