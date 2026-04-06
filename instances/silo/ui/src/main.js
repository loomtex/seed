import { router, navigate } from "./router.js";
import { renderNav } from "./nav.js";

renderNav(document.getElementById("nav"));

window.addEventListener("popstate", () => router(location.pathname));
document.addEventListener("click", (e) => {
  const a = e.target.closest("a[href]");
  if (!a || a.origin !== location.origin) return;
  // Let git smart HTTP and static asset links pass through
  if (a.pathname.match(/\.git(\/|$)/)) return;
  e.preventDefault();
  navigate(a.pathname);
});

router(location.pathname);
