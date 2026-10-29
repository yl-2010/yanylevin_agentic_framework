// Vercel Web Analytics. The queue has to exist before the hosted script loads.
// Query strings are removed so an auth code in the URL is not stored.
(function () {
  if (window.__ylVa) return;
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
