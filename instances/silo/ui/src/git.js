// Git data access via isomorphic-git + smart HTTP.
//
// Repos are shallow-cloned into IndexedDB on first visit.
// Subsequent visits fetch to check for updates.
import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import LightningFS from "@isomorphic-git/lightning-fs";

const fs = new LightningFS("silo");

function repoUrl(name) {
  return `${location.origin}/${name}.git`;
}

// Ensure a shallow clone exists in IndexedDB. Returns the dir path.
async function ensureClone(name) {
  const dir = `/${name}`;
  try {
    await fs.promises.stat(`${dir}/.git`);
    // Already cloned — fetch latest
    await git.fetch({ fs, http, dir, singleBranch: true, depth: 1 });
    // Fast-forward local branch to match remote
    const remote = await git.resolveRef({ fs, dir, ref: "refs/remotes/origin/HEAD" })
      .catch(() => git.resolveRef({ fs, dir, ref: "remotes/origin/HEAD" }))
      .catch(async () => {
        // Find default branch from remote refs
        const branches = await git.listBranches({ fs, dir, remote: "origin" });
        const main = branches.includes("main") ? "main" : branches[0] || "master";
        return git.resolveRef({ fs, dir, ref: `refs/remotes/origin/${main}` });
      });
    await git.writeRef({ fs, dir, ref: "HEAD", value: remote, force: true });
  } catch {
    await git.clone({
      fs, http, dir,
      url: repoUrl(name),
      depth: 1,
      singleBranch: true,
    });
  }
  return dir;
}

// Read tree entries at HEAD. Returns array of { path, type, oid }.
// Directories sorted first, then files.
export async function readTree(name, subpath) {
  const dir = await ensureClone(name);
  const head = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const commit = await git.readCommit({ fs, dir, oid: head });
  let treeOid = commit.commit.tree;

  // Walk into subdirectory if path given
  if (subpath) {
    const parts = subpath.split("/").filter(Boolean);
    for (const part of parts) {
      const tree = await git.readTree({ fs, dir, oid: treeOid });
      const entry = tree.tree.find((e) => e.path === part && e.type === "tree");
      if (!entry) throw new Error(`Path not found: ${subpath}`);
      treeOid = entry.oid;
    }
  }

  const tree = await git.readTree({ fs, dir, oid: treeOid });
  const dirs = tree.tree.filter((e) => e.type === "tree").sort((a, b) => a.path.localeCompare(b.path));
  const files = tree.tree.filter((e) => e.type === "blob").sort((a, b) => a.path.localeCompare(b.path));
  return [...dirs, ...files];
}

// Read a blob as text.
export async function readBlob(name, oid) {
  const dir = await ensureClone(name);
  const { blob } = await git.readBlob({ fs, dir, oid });
  return new TextDecoder().decode(blob);
}

// Read the README from the tree root. Returns { content, filename } or null.
export async function readReadme(name) {
  const entries = await readTree(name);
  const readme = entries.find((e) =>
    e.type === "blob" && /^readme(\.(md|txt|rst))?$/i.test(e.path)
  );
  if (!readme) return null;
  const content = await readBlob(name, readme.oid);
  return { content, filename: readme.path };
}

// Get HEAD commit info.
export async function headCommit(name) {
  const dir = await ensureClone(name);
  const oid = await git.resolveRef({ fs, dir, ref: "HEAD" });
  const { commit } = await git.readCommit({ fs, dir, oid });
  return {
    oid,
    message: commit.message.split("\n")[0],
    author: commit.author.name,
    timestamp: commit.author.timestamp,
  };
}

// List gate branches from the remote (no clone needed).
export async function listGates(name) {
  try {
    const refs = await git.listServerRefs({
      http,
      url: repoUrl(name),
      prefix: "refs/heads/gate/",
    });
    return refs.map((r) => ({
      name: r.ref.replace("refs/heads/gate/", ""),
      oid: r.oid,
    }));
  } catch {
    return [];
  }
}

// List issue refs from the remote (no clone needed).
// Returns count + most recent issues (by ref discovery — no content fetched).
export async function listIssueRefs(name) {
  try {
    const refs = await git.listServerRefs({
      http,
      url: repoUrl(name),
      prefix: "refs/dit/",
    });
    // Each issue has refs/dit/<id>/head
    const ids = new Set();
    for (const r of refs) {
      const parts = r.ref.split("/");
      if (parts.length >= 4) ids.add(parts[2]);
    }
    return { count: ids.size, ids: [...ids] };
  } catch {
    return { count: 0, ids: [] };
  }
}

// Get recent commit log (requires deeper history).
// Falls back gracefully if depth=1 clone only has one commit.
export async function recentCommits(name, count = 10) {
  const dir = await ensureClone(name);
  try {
    const log = await git.log({ fs, dir, depth: count });
    return log.map((entry) => ({
      oid: entry.oid.slice(0, 8),
      message: entry.commit.message.split("\n")[0],
      author: entry.commit.author.name,
      timestamp: entry.commit.author.timestamp,
    }));
  } catch {
    return [];
  }
}
