/**
 * File-link query values that survive a drag into a new tab.
 * A decoded URL treats # as a fragment, so "QA #1" was cut off and the
 * tab came back file not found. Safe tokens stay plain. Anything else
 * (spaces, #, accents) is ylb64. plus base64url.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.YLFileQuery = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const SAFE = /^[A-Za-z0-9._~-]+$/;

  function encodeEducationFileQueryValue(value) {
    const s = String(value ?? "");
    if (!s || SAFE.test(s)) return s;
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    return `ylb64.${b64}`;
  }

  function decodeEducationFileQueryValue(raw) {
    const s = String(raw ?? "");
    if (!s.startsWith("ylb64.")) return s;
    const body = s.slice(6).replace(/-/g, "+").replace(/_/g, "/");
    if (!body || /[^A-Za-z0-9+/]/.test(body)) return s;
    const pad = body + "=".repeat((4 - (body.length % 4)) % 4);
    let bin;
    try {
      bin = atob(pad);
    } catch {
      return s;
    }
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const text = new TextDecoder().decode(bytes);
    if (!text || text.includes("\0")) return s;
    return text;
  }

  return { encodeEducationFileQueryValue, decodeEducationFileQueryValue };
});
