/**
 * Shared Google OAuth / education session helpers for Vercel serverless.
 */

const crypto = require("crypto");
const { mintHs256Jwt, verifyHs256Jwt } = require("./_jwt");

function loadOwnerEmail() {
  return String(process.env.OWNER_EMAIL || "you@example.com").trim().toLowerCase();
}
function loadOwnerAliases() {
  const owner = loadOwnerEmail();
  const out = {};
  const raw = process.env.OWNER_EMAIL_ALIASES || "you@icloud.com";
  for (const part of raw.split(",")) {
    const a = part.trim().toLowerCase();
    if (a && a !== owner) out[a] = owner;
  }
  return Object.freeze(out);
}
const FULL_ACCESS_EMAILS = new Set([loadOwnerEmail()]);
const EMAIL_ALIASES = loadOwnerAliases();

const SESSION_COOKIE = "yl_education_session";
const STATE_COOKIE = "yl_oauth_state";
const RETURN_COOKIE = "yl_oauth_return";
/** When set, Google OAuth callback redirects into the iOS app with a mobile JWT. */
const MOBILE_COOKIE = "yl_oauth_mobile";
const MOBILE_APP_CALLBACK = "personalagent://oauth";
const SESSION_ISSUER = "yanylevin-education";
const SESSION_AUDIENCE = "yanylevin-education";
/** Mobile / iOS Bearer JWTs (same claims, distinct iss). */
const MOBILE_SESSION_ISSUER = "yanylevin-ios";
const MOBILE_SESSION_AUDIENCE = "yanylevin-education";
const SESSION_TTL_SEC = 60 * 60 * 24 * 14; // 14 days
const STATE_TTL_SEC = 600;

/** Allowed post-OAuth landing paths (gated sites + silent main-site unlock). */
const ALLOWED_RETURN_PATHS = new Set(["/", "/education/", "/fitness/", "/dashboard/"]);

function getAuthSecret() {
  return process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "";
}

function getGoogleConfig() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || "",
  };
}

/** @param {string|null|undefined} email */
function canonicalizeEmail(email) {
  if (!email) return "";
  const normalized = String(email).trim().toLowerCase();
  return EMAIL_ALIASES[normalized] || normalized;
}

function accessForEmail(email) {
  if (!email) return null;
  const normalized = canonicalizeEmail(email);
  if (FULL_ACCESS_EMAILS.has(normalized)) return "full";
  return "denied";
}

function parseCookies(req) {
  const header = req.headers.cookie || req.headers.Cookie || "";
  const out = {};
  if (!header) return out;
  String(header)
    .split(";")
    .forEach((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) return;
      const key = part.slice(0, idx).trim();
      const val = part.slice(idx + 1).trim();
      if (!key) return;
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    });
  return out;
}

function cookieBase({ maxAgeSec, httpOnly = true }) {
  const parts = [
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, maxAgeSec | 0)}`,
  ];
  if (httpOnly) parts.push("HttpOnly");
  if (process.env.VERCEL || process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function setCookie(res, name, value, { maxAgeSec, httpOnly = true } = {}) {
  const encoded = encodeURIComponent(value);
  const line = `${name}=${encoded}; ${cookieBase({ maxAgeSec, httpOnly })}`;
  const prev = res.getHeader?.("Set-Cookie");
  if (!prev) {
    res.setHeader("Set-Cookie", line);
    return;
  }
  const list = Array.isArray(prev) ? prev.slice() : [String(prev)];
  list.push(line);
  res.setHeader("Set-Cookie", list);
}

function clearCookie(res, name) {
  setCookie(res, name, "", { maxAgeSec: 0 });
}

function siteOrigin(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers.host || "yanylevin.com")
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

function redirectUri(req) {
  return `${siteOrigin(req)}/api/auth/callback/google`;
}

/**
 * Normalize a post-login path. Only allow known gated sites + main `/`.
 * @param {string|null|undefined} raw
 * @param {string} [fallback]
 */
function sanitizeReturnPath(raw, fallback = "/education/") {
  const value = String(raw || "").trim();
  if (!value) return fallback;
  let path = value.split("?")[0].split("#")[0];
  if (!path.startsWith("/")) return fallback;
  // Main site is exactly "/"; everything else gets a trailing slash.
  if (path === "/") return "/";
  if (!path.endsWith("/")) path = `${path}/`;
  if (ALLOWED_RETURN_PATHS.has(path)) return path;
  return fallback;
}

/** True when OAuth should land on the marketing homepage (no error UI). */
function isSilentHomeReturn(pathOrUrl) {
  const raw = String(pathOrUrl || "");
  try {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      const u = new URL(raw);
      return u.pathname === "/" || u.pathname === "";
    }
  } catch {
    /* fall through */
  }
  return raw === "/" || raw === "";
}

/**
 * Build Location for post-OAuth redirect.
 * Main-site returns are always clean (no ?error=); gated sites may surface errors.
 */
function oauthReturnLocation(home, error) {
  if (isSilentHomeReturn(home)) {
    try {
      return `${new URL(home).origin}/`;
    } catch {
      return "/";
    }
  }
  if (!error) return home;
  const join = home.includes("?") ? "&" : "?";
  return `${home}${join}error=${encodeURIComponent(error)}`;
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function mintSessionToken(email, name) {
  const secret = getAuthSecret();
  const canonical = canonicalizeEmail(email);
  return mintHs256Jwt({
    secret,
    email: canonical,
    name: name || canonical,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
    expiresInSec: SESSION_TTL_SEC,
  });
}

function mintMobileSessionToken(email, name) {
  const secret = getAuthSecret();
  const canonical = canonicalizeEmail(email);
  return mintHs256Jwt({
    secret,
    email: canonical,
    name: name || canonical,
    issuer: MOBILE_SESSION_ISSUER,
    audience: MOBILE_SESSION_AUDIENCE,
    expiresInSec: SESSION_TTL_SEC,
  });
}

function bearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  const raw = Array.isArray(header) ? header[0] : String(header || "");
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

function sessionFromPayload(payload) {
  if (!payload?.email) return null;
  const email = canonicalizeEmail(payload.email);
  return {
    email,
    name: payload.name || email,
    access: accessForEmail(email),
  };
}

/**
 * Cookie session (web) or Bearer mobile/web JWT (iOS + optional web).
 */
function readSession(req) {
  const secret = getAuthSecret();
  if (!secret) return null;

  const bearer = bearerToken(req);
  if (bearer) {
    const mobile = verifyHs256Jwt(bearer, {
      secret,
      issuer: MOBILE_SESSION_ISSUER,
      audience: MOBILE_SESSION_AUDIENCE,
    });
    if (mobile) return sessionFromPayload(mobile);

    const web = verifyHs256Jwt(bearer, {
      secret,
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
    });
    if (web) return sessionFromPayload(web);
  }

  const cookies = parseCookies(req);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyHs256Jwt(token, {
    secret,
    issuer: SESSION_ISSUER,
    audience: SESSION_AUDIENCE,
  });
  return sessionFromPayload(payload);
}

module.exports = {
  FULL_ACCESS_EMAILS,
  EMAIL_ALIASES,
  SESSION_COOKIE,
  STATE_COOKIE,
  RETURN_COOKIE,
  MOBILE_COOKIE,
  MOBILE_APP_CALLBACK,
  SESSION_TTL_SEC,
  STATE_TTL_SEC,
  ALLOWED_RETURN_PATHS,
  SESSION_ISSUER,
  SESSION_AUDIENCE,
  MOBILE_SESSION_ISSUER,
  MOBILE_SESSION_AUDIENCE,
  getAuthSecret,
  getGoogleConfig,
  canonicalizeEmail,
  accessForEmail,
  parseCookies,
  setCookie,
  clearCookie,
  siteOrigin,
  redirectUri,
  sanitizeReturnPath,
  isSilentHomeReturn,
  oauthReturnLocation,
  randomToken,
  mintSessionToken,
  mintMobileSessionToken,
  bearerToken,
  readSession,
};
