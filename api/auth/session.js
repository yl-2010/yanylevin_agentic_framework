const { readSession, getAuthSecret } = require("../_auth");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    res.setHeader("Cache-Control", "no-store");

    if (!getAuthSecret()) {
      res.status(503).json({
        ok: false,
        authenticated: false,
        email: null,
        access: null,
        error: "AUTH_SECRET not configured",
      });
      return;
    }

    const session = readSession(req);
    if (!session) {
      res.status(200).json({
        ok: true,
        authenticated: false,
        email: null,
        access: null,
      });
      return;
    }

    const payload = {
      ok: true,
      authenticated: true,
      email: session.email,
      name: session.name || session.email,
      access: session.access,
    };
    res.status(200).json(payload);
  } catch (err) {
    console.error("[auth/session]", err);
    res.status(500).json({
      ok: false,
      authenticated: false,
      email: null,
      access: null,
      error: err instanceof Error ? err.message : "session failed",
    });
  }
};
