import { renderActivity } from "./views/activity.js";
import { renderRepo } from "./views/repo.js";
import { renderRepoTree } from "./views/repo.js";
import { renderGates } from "./views/gates.js";
import { renderIdentity } from "./views/identity.js";

export const BASE = "/ui";

const routes = [
  { pattern: /^\/$/, render: renderActivity },
  { pattern: /^\/gate\/?$/, render: renderGates },
  { pattern: /^\/identity\/?$/, render: renderIdentity },
  { pattern: /^\/([^/]+)\/tree\/(.+)$/, render: renderRepoTree },
  { pattern: /^\/([^/]+)\/?$/, render: renderRepo },
];

// Strip base prefix before matching
function stripBase(path) {
  if (path.startsWith(BASE)) return path.slice(BASE.length) || "/";
  return path;
}

export function router(path) {
  const local = stripBase(path);
  const app = document.getElementById("app");
  for (const route of routes) {
    const match = local.match(route.pattern);
    if (match) {
      route.render(app, ...match.slice(1));
      return;
    }
  }
  app.innerHTML = `<div class="empty">Not found</div>`;
}

export function navigate(path) {
  history.pushState(null, "", path);
  router(path);
}
