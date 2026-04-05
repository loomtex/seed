const BASE = "/ui";

export function renderNav(el) {
  el.innerHTML = `
    <a href="${BASE}/" class="logo">silo</a>
    <a href="${BASE}/">activity</a>
    <a href="${BASE}/gate">gates</a>
    <a href="${BASE}/identity">identity</a>
  `;
}
