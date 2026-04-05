import { renderActivity } from "./views/activity.js";
import { renderRepo } from "./views/repo.js";
import { renderGates } from "./views/gates.js";

const routes = [
  { pattern: /^\/$/, render: renderActivity },
  { pattern: /^\/gate\/?$/, render: renderGates },
  { pattern: /^\/([^/]+)\/?$/, render: renderRepo },
];

export function router(path) {
  const app = document.getElementById("app");
  for (const route of routes) {
    const match = path.match(route.pattern);
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
