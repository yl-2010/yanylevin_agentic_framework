/**
 * Mint short-lived visitor JWTs for the public FAQ chatbot.
 */

import { SignJWT } from "jose";
import { getAuthConfig } from "./auth.js";

const VISITOR_EMAIL = "visitor@yanylevin.com";

/**
 * @param {object} [opts]
 * @param {string} [opts.email]
 * @param {string} [opts.expiresIn] jose duration string
 */
export async function mintVisitorToken({
  email = VISITOR_EMAIL,
  expiresIn = "10m",
} = {}) {
  const { secret, issuer, audience } = getAuthConfig();
  if (!secret) {
    const err = new Error("AUTH_SECRET not configured");
    err.status = 503;
    throw err;
  }

  const normalized = email.trim().toLowerCase();
  return new SignJWT({
    email: normalized,
    name: "Site visitor",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(normalized)
    .setIssuer(issuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(new TextEncoder().encode(secret));
}

export { VISITOR_EMAIL };
