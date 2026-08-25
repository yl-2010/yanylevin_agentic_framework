/**
 * POST /api/auth/delete-account
 * App Store 5.1.1(v): authenticated user can request deletion of account-linked log data.
 */

const { readSession, getAuthSecret } = require("../_auth");
const { mintHs256Jwt } = require("../_jwt");

const DEFAULT_MAC_API = "https://api.yanylevin.com";

function macApiBase() {
  const raw =
    process.env.MAC_API_BASE || process.env.YANYLEVIN_API_BASE || DEFAULT_MAC_API;
  return String(raw).replace(/\/$/, "");
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

    const session = readSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    const token = mintHs256Jwt({
      secret,
      email: session.email,
      name: session.name || session.email,
      issuer: "yanylevin-next",
      audience: "yanylevin-mac-api",
      expiresInSec: 120,
    });

    const upstream = await fetch(`${macApiBase()}/api/account-delete`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email: session.email }),
      signal: AbortSignal.timeout(15_000),
    });

    const text = await upstream.text();
    let data = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { ok: upstream.ok, raw: text.slice(0, 200) };
    }

    if (!upstream.ok) {
      res.status(upstream.status || 502).json({
        ok: false,
        error: data.error || "account delete failed on Mac API",
      });
      return;
    }

    res.status(200).json({
      ok: true,
      email: session.email,
      ...data,
    });
  } catch (err) {
    console.error("[auth/delete-account]", err);
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "delete-account failed",
    });
  }
};
