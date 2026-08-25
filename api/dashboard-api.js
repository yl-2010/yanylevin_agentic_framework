/**
 * Single Hobby-plan-safe proxy for /dashboard Mac API calls.
 * Rewritten from /api/dashboard/* via vercel.json (one Serverless Function).
 */

const { mintHs256Jwt } = require("./_jwt");
const { readSession, getAuthSecret } = require("./_auth");

const ISSUER = "yanylevin-next";
const AUDIENCE = "yanylevin-mac-api";
const DEFAULT_MAC_API = "https://api.yanylevin.com";

const ALLOWED = new Set(["chat-log", "login-log"]);

function macApiBase() {
  const raw =
    process.env.MAC_API_BASE || process.env.YANYLEVIN_API_BASE || DEFAULT_MAC_API;
  return String(raw).replace(/\/$/, "");
}

function mintMacToken(secret, session) {
  return mintHs256Jwt({
    secret,
    email: session.email,
    name: session.name || session.email,
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresInSec: 120,
  });
}

async function proxyMac(path, method, token) {
  const upstream = await fetch(`${macApiBase()}/api/${path}`, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: method === "POST" ? "{}" : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return {
      status: 502,
      data: {
        ok: false,
        error: `Mac API returned non-JSON (${upstream.status}): ${text.slice(0, 180)}`,
      },
    };
  }
  return { status: upstream.status, data };
}

module.exports = async function handler(req, res) {
  try {
    const path = String(req.query.p || "")
      .replace(/^\/+|\/+$/g, "")
      .split("/")[0];

    if (!ALLOWED.has(path)) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }

    if (path === "chat-log") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
    } else if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({
        ok: false,
        error: "AUTH_SECRET not configured",
      });
      return;
    }

    const session = readSession(req);
    if (!session) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }

    if (
      (path === "chat-log" || req.method === "GET") &&
      session.access !== "full"
    ) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }

    const token = mintMacToken(secret, session);
    const { status, data } = await proxyMac(path, req.method, token);
    res.status(status).json(data);
  } catch (err) {
    console.error("[api/dashboard-api]", err);
    res.status(502).json({
      ok: false,
      error: err instanceof Error ? err.message : "dashboard proxy failed",
    });
  }
};
