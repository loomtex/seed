// Repo landing page — file tree, README, clone URL, gates, cgit links.
import { readTree, readReadme, headCommit, listGates, listIssueRefs } from "../git.js";
import { Marked } from "marked";
import { drawChart } from "../chart.js";

const marked = new Marked({ breaks: true, gfm: true });

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
  return `${Math.floor(s / 604800)}w ago`;
}

function fileIcon(type) {
  return type === "tree"
    ? `<span class="icon icon-dir" aria-label="directory"></span>`
    : `<span class="icon icon-file" aria-label="file"></span>`;
}

export async function renderRepo(el, name) {
  el.innerHTML = `
    <div class="repo-header">
      <h2>${esc(name)}</h2>
      <div class="repo-meta">
        <code class="clone-url">ssh://git@silo.loom.farm/${esc(name)}.git</code>
        <span class="repo-links">
          <a href="/${esc(name)}/log" title="Commit log">log</a>
          <a href="/${esc(name)}/tree/" title="File tree">tree</a>
          <a href="/${esc(name)}/diff/" title="Diffs">diff</a>
        </span>
      </div>
      <div id="repo-commit" class="repo-commit"></div>
    </div>
    <div id="repo-gates"></div>
    <div id="repo-chart-wrap" class="repo-chart-wrap">
      <canvas id="repo-chart"></canvas>
    </div>
    <div id="repo-tree" class="loading">Loading...</div>
    <div id="repo-readme"></div>
  `;

  // Fetch all data in parallel
  const [treeP, readmeP, headP, gatesP, issuesP] = [
    readTree(name).catch(() => null),
    readReadme(name).catch(() => null),
    headCommit(name).catch(() => null),
    listGates(name),
    listIssueRefs(name),
  ];

  // Render tree
  treeP.then((entries) => {
    const treeEl = document.getElementById("repo-tree");
    if (!entries || entries.length === 0) {
      treeEl.innerHTML = `<div class="empty">Empty repository</div>`;
      return;
    }
    const rows = entries.map((e) => {
      const href = e.type === "tree"
        ? `/ui/${esc(name)}/tree/${esc(e.path)}`
        : `/${esc(name)}/tree/${esc(e.path)}`;
      return `<tr>
        <td>${fileIcon(e.type)} <a href="${href}">${esc(e.path)}</a></td>
      </tr>`;
    }).join("");
    treeEl.innerHTML = `<table class="tree-table"><tbody>${rows}</tbody></table>`;
  });

  // Render README
  readmeP.then((readme) => {
    if (!readme) return;
    const readmeEl = document.getElementById("repo-readme");
    const isMarkdown = /\.md$/i.test(readme.filename);
    const html = isMarkdown ? marked.parse(readme.content) : `<pre>${esc(readme.content)}</pre>`;
    readmeEl.innerHTML = `
      <div class="readme-card">
        <div class="readme-header">${esc(readme.filename)}</div>
        <div class="markdown-body">${html}</div>
      </div>
    `;
  });

  // Render HEAD commit
  headP.then((commit) => {
    if (!commit) return;
    const el = document.getElementById("repo-commit");
    el.innerHTML = `
      <span class="text-muted">${esc(commit.author)}</span>
      <span class="text-muted">${esc(commit.message)}</span>
      <span class="time-ago">${timeAgo(commit.timestamp)}</span>
    `;
  });

  // Render gates
  gatesP.then((gates) => {
    if (!gates.length) return;
    const gatesEl = document.getElementById("repo-gates");
    const items = gates.map((g) => `
      <div class="gate-item">
        <span class="badge badge-pending">gate</span>
        <a href="/${esc(name)}/log/?h=gate/${esc(g.name)}">${esc(g.name)}</a>
        <code class="text-muted">${g.oid.slice(0, 8)}</code>
      </div>
    `).join("");
    gatesEl.innerHTML = `
      <div class="gates-section">
        <h3>Open gates</h3>
        ${items}
      </div>
    `;
  });

  // Render issue count
  issuesP.then((issues) => {
    if (!issues.count) return;
    const metaEl = el.querySelector(".repo-links");
    if (metaEl) {
      const link = document.createElement("a");
      link.href = `/ui/${name}`;
      link.textContent = `${issues.count} issue${issues.count !== 1 ? "s" : ""}`;
      link.title = "Issues";
      metaEl.appendChild(link);
    }
  });

  // Activity chart — build daily buckets from recent commits.
  // With depth=1 we only get one commit, so the chart will be sparse.
  // Still render it — it fills out as more data is available.
  headP.then((commit) => {
    if (!commit) return;
    const days = 30;
    const now = Math.floor(Date.now() / 1000);
    const buckets = new Array(days).fill(0);
    // Place the head commit in its bucket
    const age = Math.floor((now - commit.timestamp) / 86400);
    if (age >= 0 && age < days) buckets[days - 1 - age] = 1;

    const canvas = document.getElementById("repo-chart");
    if (canvas) {
      drawChart(canvas, buckets);
      window.addEventListener("resize", () => drawChart(canvas, buckets));
    }
  });
}

// Subtree view — navigating into a directory within a repo.
export async function renderRepoTree(el, name, subpath) {
  const crumbs = subpath.split("/").filter(Boolean);
  const breadcrumb = [
    `<a href="/ui/${esc(name)}">${esc(name)}</a>`,
    ...crumbs.map((part, i) => {
      const path = crumbs.slice(0, i + 1).join("/");
      return i === crumbs.length - 1
        ? `<span>${esc(part)}</span>`
        : `<a href="/ui/${esc(name)}/tree/${esc(path)}">${esc(part)}</a>`;
    }),
  ].join(" / ");

  el.innerHTML = `
    <div class="repo-header">
      <h2>${breadcrumb}</h2>
      <div class="repo-meta">
        <span class="repo-links">
          <a href="/${esc(name)}/tree/${esc(subpath)}">view in cgit</a>
        </span>
      </div>
    </div>
    <div id="repo-tree" class="loading">Loading...</div>
  `;

  try {
    const entries = await readTree(name, subpath);
    const treeEl = document.getElementById("repo-tree");
    if (!entries || entries.length === 0) {
      treeEl.innerHTML = `<div class="empty">Empty directory</div>`;
      return;
    }
    const rows = entries.map((e) => {
      const fullPath = subpath + "/" + e.path;
      const href = e.type === "tree"
        ? `/ui/${esc(name)}/tree/${esc(fullPath)}`
        : `/${esc(name)}/tree/${esc(fullPath)}`;
      return `<tr>
        <td>${fileIcon(e.type)} <a href="${href}">${esc(e.path)}</a></td>
      </tr>`;
    }).join("");
    treeEl.innerHTML = `<table class="tree-table"><tbody>${rows}</tbody></table>`;
  } catch (err) {
    document.getElementById("repo-tree").innerHTML =
      `<div class="error">Failed to load: ${esc(err.message)}</div>`;
  }
}
