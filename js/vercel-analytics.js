// Vercel Web Analytics for the public homepage only.
// Query strings are removed so an auth code in the URL is not stored.
(function () {
  if (window.__ylVa) return;
  var host = location.hostname;
  if (host !== "yanylevin.com" && host !== "www.yanylevin.com") return;
  var path = location.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  if (path !== "/" && path !== "/index.html") return;
  window.__ylVa = true;

  window.va =
    window.va ||
    function () {
      (window.vaq = window.vaq || []).push(arguments);
    };

  window.va("beforeSend", function (event) {
    if (!event || typeof event.url !== "string") return event;
    try {
      var url = new URL(event.url, location.origin);
      url.search = "";
      url.hash = "";
      event.url = url.toString();
    } catch (err) {}
    return event;
  });

  if (document.querySelector('script[src="/_vercel/insights/script.js"]')) return;
  var script = document.createElement("script");
  script.defer = true;
  script.src = "/_vercel/insights/script.js";
  document.head.appendChild(script);
})();
