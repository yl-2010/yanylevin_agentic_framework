/**
 * Thin OpenAI-compatible client for LM Studio on the Mac Studio.
 * Default model: openai/gpt-oss-20b (confirm with GET /v1/models).
 */

const DEFAULT_BASE = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

/** Products the morning briefing flags when their expected model is not loaded. */
export const BRIEFING_LM_STUDIO_TARGETS = [
  {
    id: "sockethr",
    label: "ExampleCo",
    baseUrl: DEFAULT_BASE,
    model: DEFAULT_MODEL,
  },
  {
    id: "notelms",
    label: "ExampleNotes",
    baseUrl: DEFAULT_BASE,
    model: DEFAULT_MODEL,
  },
];

export function getLmStudioConfig() {
  return {
    baseUrl: (process.env.LM_STUDIO_BASE_URL || DEFAULT_BASE).replace(/\/$/, ""),
    model: process.env.LM_STUDIO_MODEL || DEFAULT_MODEL,
  };
}

/**
 * @param {string[]} ids
 * @param {string} model
 */
export function lmStudioModelLoaded(ids, model) {
  const list = Array.isArray(ids) ? ids.filter(Boolean).map(String) : [];
  const want = String(model || "").trim();
  if (!want) return false;
  if (list.includes(want)) return true;
  const tail = want.split("/").pop();
  if (!tail) return false;
  return list.some(
    (id) => id === tail || id.endsWith(`/${tail}`) || id.includes(tail)
  );
}

/**
 * @param {object} opts
 * @param {Array<{role: string, content: string}>} opts.messages
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxTokens]
 * @returns {Promise<{ content: string, model: string, usage: object|null, raw: object }>}
 */
export async function chatCompletions({
  messages,
  temperature = 0.4,
  maxTokens = 2048,
} = {}) {
  const { baseUrl, model } = getLmStudioConfig();
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `LM Studio returned non-JSON (${res.status}): ${text.slice(0, 240)}`
    );
  }

  if (!res.ok) {
    const msg =
      data?.error?.message || data?.error || text.slice(0, 240) || res.statusText;
    throw new Error(`LM Studio error ${res.status}: ${msg}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new Error("LM Studio response missing choices[0].message.content");
  }

  return {
    content,
    model: data.model || model,
    usage: data.usage ?? null,
    raw: data,
  };
}

/**
 * Lightweight reachability check for /health and the daily briefing.
 * @param {{ baseUrl?: string, model?: string }} [opts]
 */
export async function probeLmStudio(opts = {}) {
  const defaults = getLmStudioConfig();
  const baseUrl = String(opts.baseUrl || defaults.baseUrl).replace(/\/$/, "");
  const model = opts.model || defaults.model;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      return { ok: false, baseUrl, model, status: res.status };
    }
    const data = await res.json();
    const ids = Array.isArray(data?.data)
      ? data.data.map((m) => m.id).filter(Boolean)
      : [];
    return {
      ok: true,
      baseUrl,
      model,
      models: ids,
      modelLoaded: lmStudioModelLoaded(ids, model),
    };
  } catch (err) {
    return {
      ok: false,
      baseUrl,
      model,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Probe ExampleCo and ExampleNotes expected models. Shares one GET when they use
 * the same local server.
 */
export async function probeBriefingLmStudios() {
  /** @type {Map<string, Awaited<ReturnType<typeof probeLmStudio>>>} */
  const byBase = new Map();
  const targets = [];
  for (const spec of BRIEFING_LM_STUDIO_TARGETS) {
    const baseUrl = spec.baseUrl.replace(/\/$/, "");
    let probe = byBase.get(baseUrl);
    if (!probe) {
      probe = await probeLmStudio({ baseUrl, model: spec.model });
      byBase.set(baseUrl, probe);
    }
    const loadedModels = probe.models || [];
    const modelLoaded = probe.ok
      ? lmStudioModelLoaded(loadedModels, spec.model)
      : false;
    const error =
      probe.error ||
      (probe.status ? `HTTP ${probe.status}` : null);
    targets.push({
      id: spec.id,
      label: spec.label,
      ok: probe.ok === true,
      modelLoaded,
      model: spec.model,
      baseUrl,
      loadedModels,
      error: error ? String(error).slice(0, 200) : null,
    });
  }
  return {
    at: new Date().toISOString(),
    targets,
    down: targets.filter((t) => !t.ok || !t.modelLoaded).map((t) => t.label),
  };
}
