import { router, navigate } from "./router.js";
import { renderNav } from "./nav.js";

renderNav(document.getElementById("nav"));

window.addEventListener("popstate", () => router(location.pathname));
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.origin !== location.origin) return;
  // Only intercept links within the SPA — let cgit/git links pass through
  if (!a.pathname.startsWith("/ui")) return;
  e.preventDefault();
  navigate(a.pathname);
});

router(location.pathname);
