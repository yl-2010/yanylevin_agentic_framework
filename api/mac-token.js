/**
 * Same-origin Mac API JWT mint (Hobby-safe: one function for visitor + user).
 * - GET /api/mac-token           → visitor JWT (chatbot)
 * - GET /api/mac-user-token      → rewrite → ?kind=user (education/fitness session)
 */

const { mintHs256Jwt } = require("./_jwt");
const { readSession, getAuthSecret } = require("./_auth");

const ISSUER = "yanylevin-next";
const AUDIENCE = "yanylevin-mac-api";
const VISITOR_EMAIL = "visitor@yanylevin.com";
const EXPIRES_IN_SEC = 600;

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    const kind = String(req.query.kind || "visitor").toLowerCase();

    if (kind === "user") {
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
      if (session.access !== "full") {
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }

      const token = mintHs256Jwt({
        secret,
        email: session.email,
        name: session.name || session.email,
        issuer: ISSUER,
        audience: AUDIENCE,
        expiresInSec: EXPIRES_IN_SEC,
      });

      res.status(200).json({
        ok: true,
        token,
        expiresIn: EXPIRES_IN_SEC,
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      return;
    }

    if (kind !== "visitor") {
      res.status(400).json({ ok: false, error: "invalid kind" });
      return;
    }

    const secret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (!secret) {
      res.status(503).json({ ok: false, error: "AUTH_SECRET not configured" });
      return;
    }

    const token = mintHs256Jwt({
      secret,
      email: VISITOR_EMAIL,
      issuer: ISSUER,
      audience: AUDIENCE,
      expiresInSec: EXPIRES_IN_SEC,
    });

    res.status(200).json({
      ok: true,
      token,
      expiresIn: EXPIRES_IN_SEC,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  } catch (err) {
    console.error("[mac-token]", err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "token mint failed",
    });
  }
};
