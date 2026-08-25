/**
 * Vercel proxy for /api/fitness/* → Mac Express (api.yanylevin.com).
 * Mirrors education-api.js; Hobby-plan single function via vercel rewrite.
 */

const { mintHs256Jwt } = require("./_jwt");
const { readSession, getAuthSecret } = require("./_auth");

const ISSUER = "yanylevin-next";
const AUDIENCE = "yanylevin-mac-api";
const DEFAULT_MAC_API = "https://api.yanylevin.com";

function macApiBase() {
  const raw =
    process.env.MAC_API_BASE || process.env.YANYLEVIN_API_BASE || DEFAULT_MAC_API;
  return String(raw).replace(/\/$/, "");
}

const MAX_JSON_BODY = 1_000_000;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      resolve(req.body);
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
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

/**
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {{ method: string, path: string, body?: object|null, timeoutMs?: number, sse?: boolean }} opts
 */
async function forwardFitness(req, res, opts) {
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
    expiresInSec: 120,
  });

  const url = `${macApiBase()}${opts.path}`;
  /** @type {Record<string, string>} */
  const headers = {
    Accept: opts.sse ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${token}`,
  };

  /** @type {RequestInit} */
  const init = {
    method: opts.method,
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs || 120_000),
  };

  if (opts.body != null) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }

  if (opts.sse) {
    const upstream = await fetch(url, init);
    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      res.status(upstream.status || 502).json({
        ok: false,
        error: text.slice(0, 240) || `Mac SSE failed (${upstream.status})`,
      });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-store, no-cache");
    res.setHeader("Connection", "keep-alive");
    res.status(200);

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } catch (err) {
      console.error("[fitness-api sse]", err);
    } finally {
      res.end();
    }
    return;
  }

  const upstream = await fetch(url, init);
  const text = await upstream.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    res.status(502).json({
      ok: false,
      error: `Mac API returned non-JSON (${upstream.status}): ${text.slice(0, 180)}`,
    });
    return;
  }
  res.status(upstream.status).json(data);
}

function routePath(req) {
  const raw = req.query?.p;
  if (Array.isArray(raw)) return String(raw[0] || "").replace(/^\/+|\/+$/g, "");
  if (typeof raw === "string") return raw.replace(/^\/+|\/+$/g, "");
  return "";
}

module.exports = async function handler(req, res) {
  try {
    const route = routePath(req);
    const method = req.method || "GET";

    if (route === "data") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      await forwardFitness(req, res, {
        method: "GET",
        path: "/api/fitness/data",
        timeoutMs: 30_000,
      });
      return;
    }

    if (route === "events") {
      if (method !== "GET") {
        res.setHeader("Allow", "GET");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      await forwardFitness(req, res, {
        method: "GET",
        path: "/api/fitness/events",
        timeoutMs: 290_000,
        sse: true,
      });
      return;
    }

    if (route === "entries") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      await forwardFitness(req, res, {
        method: "POST",
        path: "/api/fitness/entries",
        body,
        timeoutMs: 30_000,
      });
      return;
    }

    if (route === "agent/start") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      await forwardFitness(req, res, {
        method: "POST",
        path: "/api/fitness/agent/start",
        body: {},
        timeoutMs: 120_000,
      });
      return;
    }

    if (route === "agent/message") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      await forwardFitness(req, res, {
        method: "POST",
        path: "/api/fitness/agent/message",
        body: {
          sessionId: body?.sessionId,
          message: body?.message,
          machineId: body?.machineId,
          machineName: body?.machineName,
        },
        timeoutMs: 300_000,
      });
      return;
    }

    if (route === "agent/stop") {
      if (method !== "POST") {
        res.setHeader("Allow", "POST");
        res.status(405).json({ ok: false, error: "method not allowed" });
        return;
      }
      const body = await readJsonBody(req);
      await forwardFitness(req, res, {
        method: "POST",
        path: "/api/fitness/agent/stop",
        body: { sessionId: body?.sessionId },
        timeoutMs: 30_000,
      });
      return;
    }

    res.status(404).json({ ok: false, error: "not found" });
  } catch (err) {
    console.error("[api/fitness-api]", err);
    if (!res.headersSent) {
      res.status(502).json({
        ok: false,
        error: err instanceof Error ? err.message : "fitness proxy failed",
      });
    }
  }
};

module.exports.config = {
  api: {
    responseLimit: false,
    bodyParser: false,
  },
  maxDuration: 300,
};
