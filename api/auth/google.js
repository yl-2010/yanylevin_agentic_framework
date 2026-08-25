const {
  getAuthSecret,
  getGoogleConfig,
  redirectUri,
  randomToken,
  setCookie,
  clearCookie,
  sanitizeReturnPath,
  STATE_COOKIE,
  RETURN_COOKIE,
  MOBILE_COOKIE,
  STATE_TTL_SEC,
} = require("../_auth");

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    const secret = getAuthSecret();
    const { clientId } = getGoogleConfig();
    if (!secret || !clientId) {
      res.status(503).json({
        ok: false,
        error: "Google OAuth is not configured",
      });
      return;
    }

    const url = new URL(req.url, "http://localhost");
    const returnTo = sanitizeReturnPath(url.searchParams.get("next"));
    const mobile = url.searchParams.get("mobile") === "1";

    const state = randomToken(24);
    setCookie(res, STATE_COOKIE, state, { maxAgeSec: STATE_TTL_SEC });
    setCookie(res, RETURN_COOKIE, returnTo, { maxAgeSec: STATE_TTL_SEC });
    if (mobile) {
      setCookie(res, MOBILE_COOKIE, "1", { maxAgeSec: STATE_TTL_SEC });
    } else {
      clearCookie(res, MOBILE_COOKIE);
    }

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri(req),
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "select_account",
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    res.statusCode = 302;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", authUrl);
    res.end();
  } catch (err) {
    console.error("[auth/google]", err);
    res.status(500).json({
      ok: false,
      error: err instanceof Error ? err.message : "oauth start failed",
    });
  }
};
