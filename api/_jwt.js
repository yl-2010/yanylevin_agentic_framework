/**
 * Minimal HS256 JWT helpers for Vercel serverless (no jose dependency).
 */

const crypto = require("crypto");

function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString("base64url");
}

/**
 * @param {object} opts
 * @param {string} opts.secret
 * @param {string} opts.email
 * @param {string} [opts.name]
 * @param {string} [opts.issuer]
 * @param {string} [opts.audience]
 * @param {number} [opts.expiresInSec]
 */
function mintHs256Jwt({
  secret,
  email,
  name = "Site visitor",
  issuer = "yanylevin-next",
  audience = "yanylevin-mac-api",
  expiresInSec = 600,
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    email,
    name,
    sub: email,
    iss: issuer,
    aud: audience,
    iat: now,
    exp: now + expiresInSec,
  };
  const h = b64url(JSON.stringify(header));
  const p = b64url(JSON.stringify(payload));
  const data = `${h}.${p}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
}

/**
 * @param {string} token
 * @param {object} opts
 * @param {string} opts.secret
 * @param {string} [opts.issuer]
 * @param {string} [opts.audience]
 * @returns {object|null}
 */
function verifyHs256Jwt(token, { secret, issuer, audience }) {
  if (!token || typeof token !== "string" || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const data = `${h}.${p}`;
  const expected = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  const a = Buffer.from(s);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === "number" && now >= payload.exp) return null;
  if (issuer && payload.iss !== issuer) return null;
  if (audience && payload.aud !== audience) return null;
  return payload;
}

module.exports = { mintHs256Jwt, verifyHs256Jwt };
