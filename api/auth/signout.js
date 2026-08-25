const { clearCookie, SESSION_COOKIE, STATE_COOKIE } = require("../_auth");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST" && req.method !== "GET") {
      res.setHeader("Allow", "GET, POST");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    clearCookie(res, SESSION_COOKIE);
    clearCookie(res, STATE_COOKIE);
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "GET") {
      res.statusCode = 302;
      res.setHeader("Location", "/education/");
      res.end();
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error("[auth/signout]", err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "signout failed",
    });
  }
};
