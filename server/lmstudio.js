/**
 * Thin OpenAI-compatible client for LM Studio on the Mac Studio.
 * Default model: openai/gpt-oss-20b (confirm with GET /v1/models).
 */

const DEFAULT_BASE = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL = "openai/gpt-oss-20b";

export function getLmStudioConfig() {
  return {
    baseUrl: (process.env.LM_STUDIO_BASE_URL || DEFAULT_BASE).replace(/\/$/, ""),
    model: process.env.LM_STUDIO_MODEL || DEFAULT_MODEL,
  };
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

/** Lightweight reachability check for /health. */
export async function probeLmStudio() {
  const { baseUrl, model } = getLmStudioConfig();
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
      modelLoaded: ids.includes(model) || ids.some((id) => id.includes("gpt-oss")),
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
