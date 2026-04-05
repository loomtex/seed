# Silo Architecture

Silo is a git forge built for agent-driven development. Code hosting,
issue tracking, gated merge, and project management — all stored as git
objects, all operated with git primitives.

## Core Principle: Everything is Git

Silo has no database, no API server, no server-side state beyond git
repositories. Every feature is built on git's object model:

- **Code** — commits, trees, blobs on branches. Standard git.
- **Issues** — empty-tree commits on `refs/dit/` ref chains.
- **Gates** — branches under `refs/heads/gate/*` awaiting owner push to main.
- **Identity** — SSH key signatures on commits.
- **Authorization** — CODEOWNERS checked against transport key at push time.

The server is nginx + git smart HTTP/SSH + pre-receive hooks + static
files for the browser UI. No application server, no process to crash or
restart. The "backend" is git.

## Identity Model

### One Key, Three Roles

Every participant (human or agent) has one SSH key that serves three
purposes:

| Role | Mechanism | Checked by |
|------|-----------|------------|
| Transport | SSH or HTTP-over-websocket push | `authorized_keys` |
| Attribution | SSH commit signature | `allowed_signers` |
| Authorization | Transport key fingerprint vs CODEOWNERS | pre-receive hook |

**Transport** gates who can push at all. Silo is public-facing — without
transport auth, anyone could send garbage for the hooks to evaluate.

**Attribution** identifies who authored a commit. Git supports signing
commits with SSH keys natively (since git 2.34, `gpg.format=ssh`). The
signature is cryptographic proof of authorship, independent of the
self-reported `author` field.

**Authorization** determines what a push is allowed to do. The
pre-receive hook maps the transport key to an identity and checks it
against CODEOWNERS rules.

### Decoupled Transport and Identity

Transport and attribution are independent. Any authorized key can deliver
commits signed by any identity:

- Josh pushes a commit Ada signed — Josh's key opens the transport,
  Ada's signature is on the commit. Attribution is Ada's. Authorization
  is Josh's.
- Ada pushes a commit she signed — both attribution and transport are
  Ada's. If the commit touches protected paths, it goes to a gate.
- Josh pushes his own commit — both are Josh's. Lands directly if he
  owns the paths.

This matches how human-agent collaboration actually works. The human
often delivers code the agent wrote, or vice versa. The push is "I'm
putting this on the server." The signature is "I wrote this."

### Key Files

```
authorized_keys   — transport auth (who can push)
allowed_signers   — identity registry (who can sign)
CODEOWNERS        — authorization rules (who owns what paths)
```

All three are flat files. All three can live in the repository itself
(CODEOWNERS already does by convention). All three are declarative and
auditable via git history.

`allowed_signers` uses git's native format:

```
ada@6bit.com ssh-ed25519 AAAA...
josh@6bit.com ssh-ed25519 AAAA...
josh-browser@6bit.com ssh-ed25519 AAAA...
```

CODEOWNERS entries reference the same email identities:

```
*.nix           josh@6bit.com
secrets/        josh@6bit.com
CODEOWNERS      josh@6bit.com
```

## Gated Merge

### How It Works

Agents push freely. Changes that touch paths listed in CODEOWNERS are
held at a gate until the path owner pushes them to main.

There is no gate metadata, no status field, no approval API. A gate
branch exists = pending. It's on main = approved. It's deleted = rejected.

### Pre-receive Hook Logic

The pre-receive hook runs on every push:

1. **`refs/heads/gate/*`** — always accept. That's what gates are for.
2. **`refs/dit/*`** — always accept. Issue operations.
3. **Not the default branch** — accept. Feature branches are ungated.
4. **Push to default branch:**
   a. Identify transport key (SSH fingerprint of the pushing key).
   b. Map key to identity via `allowed_signers`.
   c. Read CODEOWNERS from current HEAD.
   d. Compute changed files: `git diff-tree -r --name-only <old> <new>`.
   e. Match changed paths against CODEOWNERS patterns.
   f. If any matched path's owner is not the pusher → reject with:
      ```
      remote: Gated paths detected:
      remote:   flake.nix (owner: josh@6bit.com)
      remote: Push to a gate branch instead:
      remote:   git push origin HEAD:gate/<branch-name>
      ```
   g. If no matches, or all matched owners are the pusher → accept.

### Gate Approval

Approval is the owner pushing the gate branch to main:

```bash
git push origin refs/heads/gate/fix-auth:refs/heads/main
```

This is a fast-forward. The pre-receive hook sees the owner's transport
key and allows it. No special approval endpoint — it's just a push.

From the browser UI: the "Approve" button triggers a push via the
websocket-SSH bridge using the human's browser-stored key. Same
operation, same hook validation.

### Gate Rejection

Rejection is deleting the gate branch, optionally with a comment on the
linked issue explaining why. The comment is a signed commit on the issue
ref chain — it's permanent, attributed, and visible to the agent on
next sync.

### Issue Linking

Gate branches can reference issues via commit trailers:

```
Resolves: dit:<issue-hash>
```

Or via git push options:

```bash
git push -o resolves=<issue-hash> origin HEAD:gate/fix-auth
```

The post-receive hook records the link. The gate review UI shows the
issue context alongside the diff — what was asked for, the discussion
thread, any tech debt notes the human attached.

## Issue Tracking

### Data Model

Issues are stored as git objects using the git-dit/git-bug ref chain
model. Every issue and message is a commit with an empty tree —
no files, no blobs, just commit metadata.

**Ref layout:**

```
refs/dit/<issue-hash>/head       — current accepted state
refs/dit/<issue-hash>/leaves/*   — unmerged messages from participants
```

**Why empty-tree commits:**
- No merge conflicts — ever. Multiple agents updating different issues,
  or the same issue, never conflict because there's no tree content to
  merge.
- Tiny — the entire issue history for a project is kilobytes.
- Standard git objects — travel with fetch/push, garbage collected
  normally, backed up with the repo.

**Structured operations** (borrowed from git-bug): each commit's message
contains a JSON operation rather than free text. Operations are
idempotent and commutative — concurrent updates from multiple agents
converge deterministically.

```json
{"op": "create", "title": "CephFS mount in initrd", "body": "...", "labels": ["infra"]}
{"op": "comment", "body": "blocked on kernel config, see abc123"}
{"op": "set-status", "status": "doing"}
{"op": "set-status", "status": "done"}
```

Current state is computed by replaying operations from head to initial
message.

### Agent Workflow

Agents interact with issues via a CLI tool provided by the flake:

```bash
# read assigned work
silo issues --mine

# create an issue during planning
silo new "CephFS mount in initrd" --body "need kernel module in initrd"

# update status
silo update <id> --status doing

# add a note
silo comment <id> "blocked on kernel config"

# link work to an issue via gate
git push -o resolves=<id> origin HEAD:gate/fix-initrd
```

The CLI operates directly on the repo's `refs/dit/` refs — creating
empty-tree commits and updating refs with standard git plumbing. No API
calls, no external service dependency. Works offline. Syncs with push.

### Human Workflow

Humans interact via the silo web UI:

- **Issue board** — list/kanban view of issues, drag to reorder/reprioritize
- **Inline editing** — add comments, change status, attach labels
- **Tech debt notes** — annotate issues while watching the agent work
- **Gate context** — when reviewing a gated push, see the linked issue
  with full discussion history

All UI operations create git commits pushed via the websocket-SSH bridge.
The human's edits are signed, attributed, and part of the permanent
history — same as the agent's.

### Planning and Execution Cycle

The issue system replaces ad-hoc plan documents as the coordination
surface between human and agent:

1. **Plan** — human and agent create issues together, discuss scope,
   break work into tasks.
2. **Execute** — agent reads issues at session start, picks up
   prioritized work, updates status as it progresses.
3. **Groom** — human watches progress in the UI, adds tech debt notes,
   reprioritizes, adds context the agent missed.
4. **Resync** — agent reads current issue state at the top of every
   plan/implement cycle. Human's annotations are there.

This captures decisions that would otherwise be lost — "why did we
choose X over Y", "this works but needs refactoring", "revisit after
the auth rework lands." The issue thread is the decision log.

## Browser Client

### No Server-Side Rendering

The silo web UI is a static JavaScript application that operates on git
data directly. There is no application server, no server-side rendering,
no API process.

**For issues:** The browser fetches only `refs/dit/*` via git smart HTTP.
Since issue commits have empty trees, this is kilobytes of data. The
browser replays operations to compute current state and renders the UI.
Writes create new commits and push them back.

**For code views** (tree, blob, log): The browser fetches individual
objects on demand — single blobs for file views, tree objects for
directory listings. No full clone needed.

**Client-side library:** isomorphic-git provides git operations in the
browser backed by IndexedDB for local storage.

### Offline Support

Because the UI operates on a local git clone (in IndexedDB), it works
offline by construction. You can browse code, read issues, groom tasks,
and draft comments without a connection. Changes sync when you push.

### Browser Identity

On first visit, the browser generates an Ed25519 keypair:

- Private key stored in IndexedDB (non-extractable via WebCrypto)
- Public key displayed for the user to add to `authorized_keys`

This is the same onboarding flow as setting up SSH on a new machine.
Once the key is registered:

- The browser authenticates push via websocket-to-SSH proxy
- Commits created in the browser are signed with the IndexedDB key
- The pre-receive hook validates the signature against `allowed_signers`

The browser key is conceptually identical to an agent's key — a
cryptographic identity that happens to live in a browser instead of
on disk.

### Websocket-SSH Bridge

The browser can't speak SSH natively. A lightweight websocket-to-SSH
proxy bridges the gap:

```
Browser (WebSocket) → ws-ssh-proxy → sshd → git-receive-pack
```

The proxy is stateless — it opens an SSH connection for each websocket
session using the credentials provided by the browser. The browser
sends its IndexedDB private key material over the secure websocket to
authenticate the SSH session.

This means the browser uses the same `authorized_keys` as every other
client. One auth file, one transport mechanism, one pre-receive hook.

## Cross-Repo Views

### Activity Stream

Aggregates recent commits across all repos. Data source: `git log`
across repos, filtered and sorted. Rendered client-side from fetched
log data.

### Global Issue Board

Aggregates `refs/dit/` across repos. The browser fetches issue refs from
each repo in parallel (tiny payloads), merges them client-side, and
renders a unified board. Useful for seeing what all agents are working
on across projects.

### Gate Queue

Lists all `refs/heads/gate/*` branches across repos with their diffs
and linked issues. The human's primary intervention surface.

## Deployment

Silo's server-side components:

```
nginx
├── git smart HTTP (read + write, for browser pushes)
├── sshd (agent + CLI pushes)
├── ws-ssh-proxy (browser → SSH bridge)
├── static files (JS bundle, CSS)
└── cgit (fallback for blame, raw diff, patch)
```

Pre-receive and post-receive hooks in each repo handle:
- CODEOWNERS gating
- Commit signature verification
- Issue ref validation
- Gate-to-issue linking

No application server. No database. No background processes beyond
sshd and nginx.

## Relationship to Existing Docs

- **silo-frontend.md** — UI views and layout (agent profiles, human
  profiles, metrics). Still relevant for the rendering layer; the data
  access model changes from server-side git shelling to client-side
  isomorphic-git.
- **auth-and-identity.md** — Seed platform auth (TPM, mTLS, OIDC).
  Separate from silo's git-native identity model. Silo instances on
  Seed get their transport keys from the TPM identity; the models
  compose but don't overlap.
