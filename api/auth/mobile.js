/**
 * POST /api/auth/mobile
 * Exchange Google or Apple identity token → mobile session JWT (Bearer).
 */

const crypto = require("crypto");
const {
  getAuthSecret,
  getGoogleConfig,
  accessForEmail,
  canonicalizeEmail,
  mintMobileSessionToken,
} = require("../_auth");
const { mintHs256Jwt } = require("../_jwt");

const DEFAULT_MAC_API = "https://api.yanylevin.com";
const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";

function macApiBase() {
  const raw =
    process.env.MAC_API_BASE || process.env.YANYLEVIN_API_BASE || DEFAULT_MAC_API;
  return String(raw).replace(/\/$/, "");
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") {
      resolve(req.body);
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

async function verifyGoogleIdToken(idToken) {
  const { clientId } = getGoogleConfig();
  const iosClientId = process.env.GOOGLE_IOS_CLIENT_ID || "";
  const allowedAud = new Set(
    [clientId, iosClientId].map((s) => String(s || "").trim()).filter(Boolean)
  );

  const res = await fetch(
    `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    { signal: AbortSignal.timeout(10_000) }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.email) {
    throw new Error(data.error_description || data.error || "google token invalid");
  }
  if (allowedAud.size && data.aud && !allowedAud.has(String(data.aud))) {
    // Also accept aud matching web client when only one is configured.
    if (!allowedAud.has(String(data.azp || ""))) {
      throw new Error("google token audience mismatch");
    }
  }
  if (String(data.email_verified) !== "true" && data.email_verified !== true) {
    throw new Error("google email not verified");
  }
  return {
    email: String(data.email).trim().toLowerCase(),
    name: data.name || data.email,
  };
}

let appleJwksCache = { at: 0, keys: [] };

async function getAppleJwks() {
  if (Date.now() - appleJwksCache.at < 60 * 60 * 1000 && appleJwksCache.keys.length) {
    return appleJwksCache.keys;
  }
  const res = await fetch(APPLE_JWKS_URL, { signal: AbortSignal.timeout(10_000) });
  const data = await res.json();
  if (!res.ok || !Array.isArray(data.keys)) {
    throw new Error("apple jwks fetch failed");
  }
  appleJwksCache = { at: Date.now(), keys: data.keys };
  return data.keys;
}

function jwkToPem(jwk) {
  // RSA public key from JWK (n, e) → SPKI PEM via Node createPublicKey
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

async function verifyAppleIdToken(idToken) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("apple token malformed");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  const keys = await getAppleJwks();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("apple kid not found");

  const key = jwkToPem(jwk);
  const data = `${parts[0]}.${parts[1]}`;
  const sig = Buffer.from(parts[2], "base64url");
  const ok = crypto.verify(
    "RSA-SHA256",
    Buffer.from(data),
    key,
    sig
  );
  if (!ok) throw new Error("apple signature invalid");

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== APPLE_ISSUER) throw new Error("apple iss invalid");
  if (typeof payload.exp === "number" && now >= payload.exp) {
    throw new Error("apple token expired");
  }

  const bundleId =
    process.env.APPLE_BUNDLE_ID ||
    process.env.IOS_BUNDLE_ID ||
    "com.example.personalagent";
  const aud = payload.aud;
  const audOk = Array.isArray(aud)
    ? aud.includes(bundleId)
    : String(aud) === bundleId;
  if (!audOk) throw new Error("apple aud mismatch");

  const email = payload.email
    ? String(payload.email).trim().toLowerCase()
    : "";
  if (!email) {
    // Private relay may omit email on subsequent sign-ins; require email claim for allowlist.
    throw new Error("apple email missing — use Google or share email with Apple Sign In");
  }

  return {
    email,
    name: email,
  };
}

async function recordLogin(email, name, secret) {
  if (!secret || !email) return;
  try {
    const token = mintHs256Jwt({
      secret,
      email,
      name: name || email,
      issuer: "yanylevin-next",
      audience: "yanylevin-mac-api",
      expiresInSec: 120,
    });
    await fetch(`${macApiBase()}/api/login-log`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    console.error("[auth/mobile] login-log", err);
  }
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");
    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({ ok: false, error: "AUTH_SECRET not configured" });
      return;
    }

    const body = await readJsonBody(req);
    const provider = String(body.provider || "").trim().toLowerCase();
    const idToken = String(body.idToken || "").trim();
    if (!idToken || (provider !== "google" && provider !== "apple")) {
      res.status(400).json({
        ok: false,
        error: "provider (google|apple) and idToken required",
      });
      return;
    }

    const identity =
      provider === "google"
        ? await verifyGoogleIdToken(idToken)
        : await verifyAppleIdToken(idToken);

    const email = canonicalizeEmail(identity.email);
    const name = body.name || identity.name || email;
    const access = accessForEmail(email);
    const token = mintMobileSessionToken(email, name);

    await recordLogin(email, name, secret);

    res.status(200).json({
      ok: true,
      token,
      email,
      name,
      access,
    });
  } catch (err) {
    console.error("[auth/mobile]", err);
    res.status(401).json({
      ok: false,
      error: err instanceof Error ? err.message : "mobile auth failed",
    });
  }
};
