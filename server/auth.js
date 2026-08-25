/**
 * JWT verification for tokens minted by Vercel (/api/mac-token, /api/mac-user-token)
 * and for long-lived iOS / web session JWTs (same AUTH_SECRET).
 */

import { jwtVerify } from "jose";
import { canonicalizeEmail } from "./identity.js";

/** @type {ReadonlyArray<{ issuer: string, audience: string }>} */
const ACCEPTED_JWT_PAIRS = [
  // Short Mac API tokens (web mint + Vercel proxies)
  { issuer: "yanylevin-next", audience: "yanylevin-mac-api" },
  // iOS mobile session (Keychain)
  { issuer: "yanylevin-ios", audience: "yanylevin-education" },
  // Web education/fitness session cookie as Bearer (if presented)
  { issuer: "yanylevin-education", audience: "yanylevin-education" },
];

export function getAuthConfig() {
  return {
    secret: process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET || "",
    issuer: process.env.JWT_ISSUER || "yanylevin-next",
    audience: process.env.JWT_AUDIENCE || "yanylevin-mac-api",
  };
}

export function authConfigured() {
  return Boolean(getAuthConfig().secret);
}

/**
 * @param {unknown} payload
 * @returns {{ email: string, name: string|null, sub: string }|null}
 */
function userFromPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const p = /** @type {Record<string, unknown>} */ (payload);

  const emailRaw =
    (typeof p.email === "string" && p.email) ||
    (typeof p.sub === "string" && p.sub.includes("@") ? p.sub : null);

  if (!emailRaw || typeof emailRaw !== "string") {
    return null;
  }

  const email = canonicalizeEmail(emailRaw);
  if (!email.includes("@")) return null;

  return {
    email,
    name: typeof p.name === "string" ? p.name : null,
    sub: typeof p.sub === "string" ? p.sub : email,
  };
}

/**
 * @returns {Promise<{ email: string, name: string|null, sub: string }|null>}
 */
export async function getAuthFromRequest(req) {
  const header = req.headers.authorization || req.headers.Authorization;
  if (!header || typeof header !== "string") return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;

  const { secret, issuer, audience } = getAuthConfig();
  if (!secret) {
    const err = new Error("AUTH_SECRET not configured");
    err.status = 503;
    throw err;
  }

  const key = new TextEncoder().encode(secret);
  const token = match[1];

  /** Prefer env-configured pair, then known session pairs. */
  const pairs = [
    { issuer, audience },
    ...ACCEPTED_JWT_PAIRS.filter(
      (p) => !(p.issuer === issuer && p.audience === audience)
    ),
  ];

  for (const pair of pairs) {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: pair.issuer,
        audience: pair.audience,
        algorithms: ["HS256"],
      });
      const user = userFromPayload(payload);
      if (user) return user;
    } catch {
      /* try next pair */
    }
  }

  return null;
}

/** Express middleware: require valid Bearer JWT; attach req.user. */
export function requireAuth(req, res, next) {
  getAuthFromRequest(req)
    .then((user) => {
      if (!user) {
        res.status(401).json({ ok: false, error: "unauthorized" });
        return;
      }
      req.user = user;
      next();
    })
    .catch((err) => {
      const status = err.status || 500;
      res.status(status).json({
        ok: false,
        error: err.message || "auth failed",
      });
    });
}
