const {
  getAuthSecret,
  getGoogleConfig,
  redirectUri,
  parseCookies,
  setCookie,
  clearCookie,
  mintSessionToken,
  mintMobileSessionToken,
  sanitizeReturnPath,
  oauthReturnLocation,
  accessForEmail,
  canonicalizeEmail,
  STATE_COOKIE,
  RETURN_COOKIE,
  MOBILE_COOKIE,
  MOBILE_APP_CALLBACK,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  siteOrigin,
} = require("../../_auth");
const { mintHs256Jwt } = require("../../_jwt");

const DEFAULT_MAC_API = "https://api.yanylevin.com";

function macApiBase() {
  const raw =
    process.env.MAC_API_BASE || process.env.YANYLEVIN_API_BASE || DEFAULT_MAC_API;
  return String(raw).replace(/\/$/, "");
}

/** Append this login to Mac Studio login-log (awaited so serverless doesn't drop it). */
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
    const upstream = await fetch(`${macApiBase()}/api/login-log`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ email }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.error(
        "[auth/callback] login-log",
        upstream.status,
        text.slice(0, 180)
      );
    }
  } catch (err) {
    console.error("[auth/callback] login-log", err);
  }
}

async function exchangeCode(code, req) {
  const { clientId, clientSecret } = getGoogleConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri(req),
    grant_type: "authorization_code",
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenJson.access_token) {
    const err = new Error(tokenJson.error || "token exchange failed");
    err.detail = tokenJson;
    throw err;
  }
  return tokenJson;
}

async function fetchGoogleUser(accessToken) {
  const userRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const user = await userRes.json().catch(() => ({}));
  if (!userRes.ok || !user.email) {
    const err = new Error(user.error || "userinfo failed");
    err.detail = user;
    throw err;
  }
  return user;
}

module.exports = async function handler(req, res) {
  const cookiesEarly = parseCookies(req);
  const returnPath = sanitizeReturnPath(cookiesEarly[RETURN_COOKIE]);
  const home = `${siteOrigin(req)}${returnPath === "/" ? "/" : returnPath}`;
  const isMobile = cookiesEarly[MOBILE_COOKIE] === "1";
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      res.status(405).json({ ok: false, error: "method not allowed" });
      return;
    }

    const secret = getAuthSecret();
    const { clientId, clientSecret } = getGoogleConfig();
    if (!secret || !clientId || !clientSecret) {
      clearCookie(res, RETURN_COOKIE);
      clearCookie(res, MOBILE_COOKIE);
      if (isMobile) {
        res.statusCode = 302;
        res.setHeader(
          "Location",
          `${MOBILE_APP_CALLBACK}?error=${encodeURIComponent("config")}`
        );
        res.end();
        return;
      }
      res.statusCode = 302;
      res.setHeader("Location", oauthReturnLocation(home, "config"));
      res.end();
      return;
    }

    const url = new URL(req.url, siteOrigin(req));
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const oauthError = url.searchParams.get("error");

    if (oauthError) {
      clearCookie(res, RETURN_COOKIE);
      clearCookie(res, MOBILE_COOKIE);
      if (isMobile) {
        res.statusCode = 302;
        res.setHeader(
          "Location",
          `${MOBILE_APP_CALLBACK}?error=${encodeURIComponent(oauthError)}`
        );
        res.end();
        return;
      }
      res.statusCode = 302;
      res.setHeader("Location", oauthReturnLocation(home, oauthError));
      res.end();
      return;
    }

    const cookies = parseCookies(req);
    const expectedState = cookies[STATE_COOKIE];
    clearCookie(res, STATE_COOKIE);
    clearCookie(res, RETURN_COOKIE);
    clearCookie(res, MOBILE_COOKIE);

    if (!code || !state || !expectedState || state !== expectedState) {
      if (isMobile) {
        res.statusCode = 302;
        res.setHeader(
          "Location",
          `${MOBILE_APP_CALLBACK}?error=${encodeURIComponent("state")}`
        );
        res.end();
        return;
      }
      res.statusCode = 302;
      res.setHeader("Location", oauthReturnLocation(home, "state"));
      res.end();
      return;
    }

    const tokens = await exchangeCode(code, req);
    const user = await fetchGoogleUser(tokens.access_token);
    const email = canonicalizeEmail(user.email);
    const name = user.name || email;
    await recordLogin(email, name, secret);

    if (isMobile) {
      const token = mintMobileSessionToken(email, name);
      const access = accessForEmail(email) || "denied";
      const params = new URLSearchParams({
        token,
        email,
        name,
        access,
      });
      res.statusCode = 302;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Location", `${MOBILE_APP_CALLBACK}?${params.toString()}`);
      res.end();
      return;
    }

    const session = mintSessionToken(email, name);
    setCookie(res, SESSION_COOKIE, session, { maxAgeSec: SESSION_TTL_SEC });

    let dest = home;
    if (returnPath === "/") {
      dest = `${siteOrigin(req)}/`;
      if (accessForEmail(email) === "full") {
        dest = `${dest}#apps`;
      }
    }

    res.statusCode = 302;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Location", dest);
    res.end();
  } catch (err) {
    console.error("[auth/callback/google]", err);
    clearCookie(res, RETURN_COOKIE);
    clearCookie(res, MOBILE_COOKIE);
    if (isMobile) {
      res.statusCode = 302;
      res.setHeader(
        "Location",
        `${MOBILE_APP_CALLBACK}?error=${encodeURIComponent("callback")}`
      );
      res.end();
      return;
    }
    res.statusCode = 302;
    res.setHeader("Location", oauthReturnLocation(home, "callback"));
    res.end();
  }
};
