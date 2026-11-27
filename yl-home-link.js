/**
 * Authorized (full-access) Google sessions: top-left YL logo → /home/.
 * On home, shift-click goes to /dashboard/ instead.
 * Everyone else keeps the page's default href (main site / #top).
 */
(() => {
  const el = document.querySelector("a.c-tl");
  const onHome =
    location.pathname === "/home" || location.pathname.startsWith("/home/");

  fetch("/api/auth/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  })
    .then((res) => res.json().catch(() => ({})))
    .then((data) => {
      if (el && data && data.authenticated && data.access === "full") {
        el.setAttribute("href", "/home/");
        if (onHome) {
          el.addEventListener("click", (event) => {
            if (
              !event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              event.button !== 0
            ) {
              return;
            }
            event.preventDefault();
            location.assign("/dashboard/");
          });
        }
      }
    })
    .catch(() => {});
})();
