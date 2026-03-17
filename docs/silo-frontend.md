# Silo Frontend Design

## Philosophy

GitHub's social model assumes the committer is the creative agent. Profiles,
contribution graphs, follower counts — all built around individual human
authorship. This model is already breaking.

When agents write most of the commits, two things happen: humans disappear
(the orchestrator's contribution graph goes dark despite driving all the work),
and agents inflate (500 commits/day makes every human look inactive). GitHub
will patch this — suppress bot accounts, fold agent commits into human graphs —
but these are bandaids on a model that doesn't distinguish authorship from
orchestration.

Silo doesn't carry that baggage. It can model the actual relationship:

- **Agents are authors.** They wrote the code. Their identity, their commits,
  their signatures.
- **Humans are orchestrators.** They defined the boundaries (CODEOWNERS),
  approved the escalations (gates), steered the direction (feedback loops),
  and shaped the agent's environment (nuketown configs).
- **Both are real contributions.** Tracked differently, displayed differently,
  valued differently.

The shift from "agents can't really do anything useful" to "agents as primary
committers" happened fast. One day you're skeptical, the next you've shipped
multiple real projects without writing a line of code — and your contribution
graph is empty because the platform has no way to represent what you did.

GitHub will eventually push back against agent identities being primary
identities on their platform — the economics of their social features depend
on human vanity metrics. Silo is built for the world where that tension
doesn't exist, because orchestration is a first-class concept, not a hack
stuffed into a Co-Authored-By trailer.

## Problem

Silo's current web UI is cgit — a C application with hardcoded HTML, no
templating, and a layout designed for human developers browsing code. Seed's
primary users are agents. Humans visit to observe progress, check velocity,
and intervene when needed. The UI should reflect this.

## Goals

1. **File-forward landing page**: repo root shows the file tree with last
   commit message per entry, README rendered below (like GitHub)
2. **Activity-first cross-repo view**: what's happening across all repos, who's
   pushing what
3. **Gated merge**: the primary human intervention point — review and
   approve/reject changes to protected paths before they land on the default
   branch
4. **Dark mode**: GitHub-dark aesthetic
5. **Keep cgit**: for long-tail views (blame, raw diff, patch) that don't need
   a custom UI. Deep-link to cgit from the new frontend.

## Non-goals

- Pull requests, issues, wikis, CI integration, release management
- User accounts or authentication (read-only web, push is SSH-only)
- Replacing cgit entirely

## Gated Merge

### Concept

Agents push freely. Most changes land on the default branch immediately. Changes
that touch protected paths (defined by CODEOWNERS) are held at a gate until a
human approves.

This is the nuketown sudo model applied to code: agents operate autonomously
within boundaries, humans approve escalations.

### CODEOWNERS

Standard CODEOWNERS file in each repo defines protected paths:

```
# Infrastructure
*.nix           @josh
flake.lock      @josh
flake.nix       @josh

# Secrets and access control
secrets/        @josh
.authorized_keys @josh

# The gate rules themselves
CODEOWNERS      @josh
```

Paths without an owner are ungated — changes land immediately.

### Flow

**Push to main (ungated paths only):**

1. Agent pushes to default branch
2. Pre-receive hook checks the diff against CODEOWNERS
3. If no changed paths have owners → push accepted. Done.
4. If any changed paths have owners → **push rejected** with message:
   ```
   remote: Gated paths detected:
   remote:   flake.nix (owner: @josh)
   remote:   secrets/api-key.yaml (owner: @josh)
   remote: Push to a gate branch instead:
   remote:   git push origin HEAD:gate/<branch-name>
   ```

**Gated merge flow:**

1. Agent pushes to `gate/<name>` branch (any name — feature description, etc.)
2. Post-receive hook:
   - Parses CODEOWNERS, records which rules triggered
   - Creates gate metadata (agent identity, triggered rules, timestamp)
   - Notifies owner
3. Gate appears in the web UI queue
4. Owner reviews: approve (fast-forward main) or reject (with reason)
5. Agent is notified of the outcome

**Agent waiting patterns:**

- **Local agent** (e.g. ada on signi, working with user): polls a status
  endpoint. Short feedback loop — user approves in the web UI, agent sees
  it within seconds.
  ```
  GET /gate/<id>/status → {"status": "pending|approved|rejected", "reason": "..."}
  ```
- **Remote agent**: pushes branch, sends XMPP message to owner with the
  review URL, then registers a webhook callback. Silo POSTs to the callback
  URL when the gate resolves. Agent doesn't need to hold a connection open.

### Open questions

- **CODEOWNERS parsing**: Use GitHub's format exactly? Or simplified subset?
  GitHub format supports team owners, inline comments, and last-match-wins
  ordering. We probably only need glob patterns + individual owners.
- **Multiple owners**: If a path matches multiple owners, require all or any?
- **Pre-receive vs update hook**: Pre-receive runs once per push (all refs).
  Update hook runs per-ref. Pre-receive is simpler since we reject the
  whole push atomically.
- **Gate branch cleanup**: auto-delete after merge/rejection? Or keep for
  audit trail?
- **Stacking**: Can an agent push updates to an existing gate branch while
  it's pending review? Probably yes — just update the gate metadata.

## Gate Storage

Gate state needs to survive restarts and be queryable by the web frontend.
Options considered:

- **Git refs + flat files**: gate branches are already git refs. Metadata
  (triggered rules, agent identity, status, timestamps) stored as flat JSON
  files alongside the repo. E.g. `<repo>.git/gates/<id>.json`. Simple,
  no dependencies, survives in the existing PVC.
- **SQLite**: more queryable, but adds a dependency and another thing to back up.

Recommendation: **flat JSON files**. The gate queue will never be large (tens of
items, not thousands). The web frontend reads them with `fs.readdir` + `JSON.parse`.

```
<repo>.git/gates/
  abc123.json    # {"id":"abc123","branch":"gate/fix-nix","agent":"ada",
                 #  "status":"pending","rules":[{"path":"flake.nix","owner":"josh"}],
                 #  "created":"2026-03-16T...","resolved":null,"reason":null,
                 #  "webhook":null}
```

Status transitions: `pending` → `approved` | `rejected`

## Pre-receive Hook

The existing post-receive hook handles webhook notifications to the controller.
The gating logic lives in a **pre-receive** hook — it runs before refs are
updated, so rejected pushes never touch the repo.

```
stdin: <old-sha> <new-sha> <ref-name>
```

Logic:

1. If ref is `refs/heads/gate/*` → always accept (that's the whole point)
2. If ref is not the default branch → accept (feature branches are ungated)
3. For pushes to the default branch:
   a. Read CODEOWNERS from the repo (current HEAD, not the incoming push)
   b. Compute changed files: `git diff-tree -r --name-only <old> <new>`
   c. Match each path against CODEOWNERS patterns
   d. If any match → reject with message listing gated paths and instructions
   e. If none match → accept

Edge cases:
- **New repo (first push)**: no CODEOWNERS exists yet → accept everything
- **CODEOWNERS in the push itself**: read from current HEAD, not incoming.
  Otherwise an agent could remove CODEOWNERS in the same push. CODEOWNERS
  itself should be listed in CODEOWNERS.
- **Force push to main**: treat same as normal push — diff the old and new
  trees, check CODEOWNERS

## API

Minimal HTTP API served by the frontend process. No auth — silo runs in a
private network, same as cgit.

### Gate endpoints

```
GET  /api/gates                → list all pending gates (across repos)
GET  /api/gates/<id>           → gate detail (metadata + diff)
GET  /api/gates/<id>/status    → {"status":"pending|approved|rejected","reason":"..."}
POST /api/gates/<id>/approve   → fast-forward main, update metadata, notify agent
POST /api/gates/<id>/reject    → {"reason":"..."} → update metadata, notify agent, optionally delete branch
```

### Webhook callback

Agents include a callback URL as a git push option:

```
git push -o webhook=https://agent.example.com/callback origin HEAD:gate/my-feature
```

The post-receive hook stores it in the gate metadata. When the gate resolves,
silo POSTs to the URL:

```json
{"gate_id":"abc123","status":"approved|rejected","reason":"...","repo":"myrepo","branch":"gate/my-feature"}
```

### Git data endpoints (for frontend views)

```
GET  /api/<repo>/tree/<ref>/<path>  → directory listing with last commit per entry
GET  /api/<repo>/blob/<ref>/<path>  → file contents (highlighted)
GET  /api/<repo>/readme/<ref>       → rendered README
GET  /api/activity                  → cross-repo activity feed (paginated)
```

## Views

### 1. Activity Stream (index page)

Cross-repo reverse-chronological feed:
- Agent avatar/identity, repo name, timestamp
- Commit message + short stat (files changed, insertions, deletions)
- Gated commits highlighted with pending/approved/rejected status

Data source: `git log --all --format=...` across all repos, sorted by
author-date.

### 2. Repo Landing

Top section: repo name, description, clone URL, last activity timestamp.

File tree table:
| Name | Last commit message | Age |
|------|-------------------|-----|
| src/ | refactor auth middleware | 2 hours ago |
| README.md | update install instructions | 1 day ago |
| flake.nix | add new dependency | 3 hours ago |

Data source: `git ls-tree HEAD` for entries, `git log -1 --format='%s|%ar' -- <path>` per entry.

Below the table: rendered README (reuse existing cmark pipeline).

### 3. Blob View

Syntax-highlighted file view. Reuse tree-sitter pipeline from current cgit
source-filter, or use web-tree-sitter client-side.

### 4. Gate Queue

List of pending gated commits across all repos:
- Agent identity, repo, timestamp
- Which CODEOWNERS rules triggered
- Diff stat summary
- Expand to see full diff
- Approve / Reject buttons

### 5. Agent Profile

Agent-maintained living document + computed metrics.

**Self-authored content** (agent pushes to `profiles` repo):
- `<agent>.md` — free-form markdown the agent maintains: what they're working
  on, recent accomplishments, capabilities, current status
- Git history of the profile shows how the agent's focus has evolved
- Agent updates this as part of their workflow (e.g. "finished auth refactor,
  starting on gate hook implementation")

**Computed from git history** (displayed alongside):
- Repos touched (with recency)
- Commit velocity graph (daily/weekly)
- Gate stats: submitted, approved, rejected, approval rate
- Recent commit feed (filtered to this agent)
- Languages/files most frequently touched

**Why agent-maintained**: Metrics alone lack narrative. A human landing on
the profile sees "I'm blocked on gate approval for the flake.nix change"
alongside "47 commits this week" — context that makes the numbers useful.

**Coordination surface**: Multiple agents' profiles make overlapping work
visible. If two agents are touching the same subsystem, their profiles
reveal it before a merge conflict does.

### 6. Human Profile

The human's profile answers a different question than GitHub's. Not "what do
you build by commits" but "what do you build by orchestrating commits."

**Orchestration metrics:**

Metric selection matters — numbers on a profile are powerful motivators that
can incentivize behavior we don't intend. "Agents coordinated" as a count
encourages splitting work across agents for the number, not because it helps.
Metrics should reflect quality of orchestration, not scale of it.

Candidates (needs careful curation):
- Throughput — commits landed, not how many agents produced them
- Gate velocity — how fast you unblock agents (time-to-approval)
- Rejection signal quality — do agents resubmit successfully after rejection?
  (measures whether your feedback is actionable)
- CODEOWNERS scope — what paths you protect, across which repos

Deliberately excluded:
- Agent count (Goodhart's law — incentivizes fragmentation)
- Raw approval count (incentivizes rubber-stamping)
- Lines of code / files changed (meaningless for orchestration)

**Gate intervention feed:**
The centerpiece. Reverse-chronological list of gate approvals and rejections.
Approvals are noted but not the interesting part. Rejections with reasons are
the real content — that's where the human's judgment is visible.

Each rejection shows:
- The diff that was rejected
- Which CODEOWNERS rules triggered
- The human's reason ("changes auth model without updating threat doc",
  "introduces new dependency we discussed dropping", etc.)
- Which agent submitted it and whether they resubmitted successfully

This feed *is* the human's contribution graph. It shows taste, priorities,
and technical judgment — the things that don't show up in `git log`.

**Rejection annotations as RL data:**
Every rejection with a reason is a labeled training example: (diff, context,
"no, because..."). This dataset builds itself as a natural byproduct of the
gating workflow. Over time it becomes:
- Fine-tuning data for the agent (learn what this human rejects)
- Input to a classifier that could pre-screen gate submissions
- A searchable knowledge base of architectural decisions and constraints
  ("why can't I change X?" → look at past rejections touching X)

The human never has to do extra work to produce this data. The rejection
reason they write for the agent *is* the label. The diff *is* the input.
The gate metadata provides the structured context. It's RL from human
feedback happening in the natural flow of work.

**Portfolio view:**
- Repos grouped by agent ("ada works on mynix and seed, vox works on docs")
- Cross-agent coordination highlights ("ada and vox both touched auth this week")
- CODEOWNERS evolution — git history of CODEOWNERS files shows how the human's
  trust boundaries have shifted over time

### 7. Metrics (future)

Global dashboard across all agents and humans:
- Commits per agent per day/week
- Files most frequently changed
- Gate approval/rejection rates per owner
- Time-to-approval distribution
- Rejection-then-resubmit success rate (are agents learning?)

## Tech Stack

- **Runtime**: Node.js / TypeScript (seed already has TS infrastructure)
- **Git access**: shell out to `git` (simple, reliable, same as cgit)
- **Templates**: JSX or template literals (no heavy framework needed)
- **Styling**: hand-written CSS, GitHub-dark palette
- **Deployment**: runs alongside cgit in the silo instance, nginx routes
  between them
- **Server**: minimal HTTP server (node:http or Hono), served behind nginx

## Routing

```
/                       → activity stream
/<repo>                 → repo landing (tree + readme)
/<repo>/tree/<path>     → subtree or blob view
/<repo>/log             → commit log (or link to cgit)
/@<agent>               → agent profile
/<repo>/commit/<sha>    → commit detail (or link to cgit)
/gate                   → gate queue (pending approvals)
/gate/<id>              → single gated commit review

# cgit fallback
/cgit/                  → proxied to cgit for blame, diff, patch, etc.
```

## Migration Path

1. Build repo landing + blob view + activity stream
2. Add gate queue UI + post-receive gating logic
3. Dark mode CSS
4. Redirect silo.loom.farm root to new frontend, cgit at /cgit/
5. Incrementally replace cgit views as needed
