/**
 * Authorized (full-access) Google sessions: top-left YL logo → /education/.
 * Everyone else keeps the page's default href (main site / #top).
 */
(() => {
  const el = document.querySelector("a.c-tl");

  fetch("/api/auth/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then((res) => res.json().catch(() => ({})))
    .then((data) => {
      if (el && data && data.authenticated && data.access === "full") {
        el.setAttribute("href", "/education/");
      }
    })
    .catch(() => {});
})();
