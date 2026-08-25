/**
 * Pull client identity signals from an Express request.
 * Prefers X-Yan-Client-* headers forwarded by the Vercel /api/chat proxy
 * so logs see the real browser, not the serverless egress hop.
 */

function firstHeader(headers, names) {
  for (const name of names) {
    const raw = headers[name] ?? headers[name.toLowerCase()];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (Array.isArray(raw) && raw[0]) return String(raw[0]).trim();
  }
  return "";
}

function firstForwardedIp(value) {
  if (!value) return "";
  return String(value).split(",")[0].trim();
}

/**
 * @param {import('express').Request} req
 */
export function extractClientSignals(req) {
  const headers = req.headers || {};

  const forwarded =
    firstHeader(headers, ["x-yan-client-ip"]) ||
    firstForwardedIp(firstHeader(headers, ["x-forwarded-for"])) ||
    firstHeader(headers, ["cf-connecting-ip", "x-real-ip"]);

  const ip =
    forwarded ||
    (typeof req.ip === "string" ? req.ip : "") ||
    req.socket?.remoteAddress ||
    "";

  const userAgent = firstHeader(headers, [
    "x-yan-client-ua",
    "user-agent",
  ]);

  const acceptLanguage = firstHeader(headers, [
    "x-yan-client-lang",
    "accept-language",
  ]);

  const country = firstHeader(headers, [
    "x-yan-client-country",
    "cf-ipcountry",
    "x-vercel-ip-country",
  ]).toUpperCase();

  const referer = firstHeader(headers, [
    "x-yan-client-referer",
    "referer",
    "referrer",
  ]);

  const sessionId =
    (typeof req.body?.sessionId === "string" && req.body.sessionId) ||
    (typeof req.body?.session_id === "string" && req.body.session_id) ||
    "";

  return {
    ip,
    userAgent,
    acceptLanguage,
    country,
    referer,
    sessionId,
  };
}
