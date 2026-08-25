/**
 * Browser helper: mint a short Mac JWT via Vercel, then call api.yanylevin.com
 * for education/fitness (data, SSE, agent) so Vercel Fluid is not held open.
 */
(() => {
  const DEFAULT_API_BASE = "https://api.yanylevin.com";
  const TOKEN_URL = "/api/mac-user-token";

  /** @type {Promise<{ apiBase: string }>|null} */
  let configPromise = null;
  /** @type {{ token: string, expiresAt: number }|null} */
  let tokenCache = null;
  /** @type {Promise<string>|null} */
  let tokenInflight = null;

  function isLocalHost() {
    const host = window.location.hostname;
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host.endsWith(".local")
    );
  }

  async function loadConfig() {
    if (configPromise) return configPromise;
    configPromise = (async () => {
      if (isLocalHost()) {
        /** @type {any} */ (window).__yanMacApiBase = "http://127.0.0.1:3004";
        return { apiBase: "http://127.0.0.1:3004" };
      }
      let apiBase = DEFAULT_API_BASE;
      try {
        const res = await fetch("/runtime-config.json", { cache: "no-store" });
        if (res.ok) {
          const runtime = await res.json();
          if (runtime?.apiBase) apiBase = String(runtime.apiBase);
        }
      } catch {
        /* keep default */
      }
      const resolved = apiBase.replace(/\/$/, "");
      /** @type {any} */ (window).__yanMacApiBase = resolved;
      return { apiBase: resolved };
    })();
    return configPromise;
  }

  async function getMacToken() {
    const now = Date.now();
    if (tokenCache?.token && tokenCache.expiresAt > now + 30_000) {
      return tokenCache.token;
    }
    if (tokenInflight) return tokenInflight;

    tokenInflight = (async () => {
      const res = await fetch(TOKEN_URL, {
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.token) {
        const err = new Error(data.error || `mac-user-token ${res.status}`);
        /** @type {any} */ (err).status = res.status;
        throw err;
      }
      const ttlMs = (Number(data.expiresIn) || 600) * 1000;
      tokenCache = { token: data.token, expiresAt: now + ttlMs };
      return tokenCache.token;
    })().finally(() => {
      tokenInflight = null;
    });

    return tokenInflight;
  }

  function clearMacToken() {
    tokenCache = null;
  }

  /** Sync peek for beforeunload keepalive (may be null). */
  function peekMacToken() {
    const now = Date.now();
    if (tokenCache?.token && tokenCache.expiresAt > now + 5_000) {
      return tokenCache.token;
    }
    return null;
  }

  /**
   * Fire-and-forget POST for page unload (Authorization + keepalive).
   * @param {string} path
   * @param {unknown} body
   */
  function macKeepalivePost(path, body) {
    const token = peekMacToken();
    if (!token) return;
    const base =
      (isLocalHost() ? "http://127.0.0.1:3004" : null) ||
      DEFAULT_API_BASE;
    // Prefer last resolved apiBase from cache if loadConfig already ran
    const apiBase = /** @type {any} */ (window).__yanMacApiBase || base;
    const url = `${String(apiBase).replace(/\/$/, "")}${
      path.startsWith("/") ? path : `/${path}`
    }`;
    try {
      fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body ?? {}),
        keepalive: true,
      }).catch(() => {});
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {string} path e.g. "/api/education/data"
   * @param {RequestInit & { json?: unknown, timeoutMs?: number }} [opts]
   */
  async function macFetch(path, opts = {}) {
    const { apiBase } = await loadConfig();
    const token = await getMacToken();
    const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;

    /** @type {Record<string, string>} */
    const headers = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers && typeof opts.headers === "object" && !(opts.headers instanceof Headers)
        ? /** @type {Record<string, string>} */ (opts.headers)
        : {}),
    };

    /** @type {RequestInit} */
    const init = {
      method: opts.method || "GET",
      headers,
      signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 120_000),
    };

    if (opts.json !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.json);
    } else if (opts.body != null) {
      init.body = opts.body;
    }

    let res = await fetch(url, init);
    if (res.status === 401) {
      clearMacToken();
      const retryToken = await getMacToken();
      headers.Authorization = `Bearer ${retryToken}`;
      res = await fetch(url, { ...init, headers });
    }
    return res;
  }

  /**
   * Fetch-based SSE (EventSource cannot set Authorization).
   * @param {string} path e.g. "/api/education/events"
   * @param {{ onEvent?: (name: string, data: string) => void, onChange?: () => void, onError?: (err: unknown) => void }} handlers
   * @returns {{ close: () => void }}
   */
  function subscribeEvents(path, handlers = {}) {
    let closed = false;
    let retry = 0;
    /** @type {AbortController|null} */
    let ac = null;

    const close = () => {
      closed = true;
      try {
        ac?.abort();
      } catch {
        /* ignore */
      }
    };

    const connect = async () => {
      if (closed) return;
      ac = new AbortController();
      try {
        const { apiBase } = await loadConfig();
        const token = await getMacToken();
        const url = `${apiBase}${path.startsWith("/") ? path : `/${path}`}`;
        const res = await fetch(url, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            Authorization: `Bearer ${token}`,
          },
          signal: ac.signal,
        });
        if (!res.ok || !res.body) {
          throw new Error(`SSE ${res.status}`);
        }
        retry = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!closed) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() || "";
          for (const block of parts) {
            let eventName = "message";
            const dataLines = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) {
                eventName = line.slice(6).trim();
              } else if (line.startsWith("data:")) {
                dataLines.push(line.slice(5).trim());
              }
            }
            const data = dataLines.join("\n");
            handlers.onEvent?.(eventName, data);
            if (eventName === "change") {
              handlers.onChange?.();
            }
          }
        }
      } catch (err) {
        if (closed) return;
        if (/** @type {any} */ (err)?.name === "AbortError") return;
        handlers.onError?.(err);
      }
      if (closed) return;
      retry = Math.min(retry + 1, 6);
      window.setTimeout(connect, 1500 * retry);
    };

    connect();
    return { close };
  }

  window.YanMacApi = {
    loadConfig,
    getMacToken,
    peekMacToken,
    clearMacToken,
    macFetch,
    macKeepalivePost,
    subscribeEvents,
  };
})();
