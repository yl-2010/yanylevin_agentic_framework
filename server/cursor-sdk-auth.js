/**
 * Cursor SDK recovery without restarting Express.
 *
 * Auth / stale executor: the SDK caches one local executor per cwd+apiKey.
 * Recreating the Agent handle is not enough while any other session still
 * holds a lease. Interactive retries dispose every live Agent so the
 * executor refcount hits 0, then create a new one and replay the UI
 * transcript into the prompt.
 *
 * App/web: first Grok send, then reconnect Grok twice (executor evict),
 * then Auto twice (assume Grok high demand). If Auto also fails, surface
 * the usual error so the user can resend. Nightly Grok jobs: try Grok
 * eight times, then Auto twice. If Auto is still overloaded, wait 5 min
 * three times, then back off (10 / 20 / 40 / 60) until the load clears.
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), ".env");

/**
 * App/web: first preferred-model send, then two reconnects (0s, 2s, 2s).
 * Reconnects evict the shared local executor.
 */
export const INTERACTIVE_MODEL_DELAYS_MS = [0, 2000, 2000];

/** @deprecated alias — interactive agents now use INTERACTIVE_MODEL_DELAYS_MS. */
export const INTERACTIVE_AUTH_DELAYS_MS = INTERACTIVE_MODEL_DELAYS_MS;

/** Composer / non-Grok scheduled jobs: first attempt, then 3s / 15s / 45s. */
export const BRIEFING_AUTH_DELAYS_MS = [0, 3000, 15000, 45000];

/** Nightly Grok jobs: eight preferred-model attempts. */
export const NIGHTLY_GROK_DELAYS_MS = [
  0, 3000, 8000, 15000, 30000, 60000, 120000, 180000,
];

/** After preferred-model attempts are exhausted, try Auto. */
export const AUTO_MODEL_SELECTION = { id: "auto", params: [] };

export const INTERACTIVE_FALLBACK_DELAYS_MS = [0, 2000];
export const NIGHTLY_FALLBACK_DELAYS_MS = [0, 3000];

/** Chat Working bubble copy while a user-facing turn is in flight. */
export const WORKING_LABEL_DEFAULT = "Working…";
export const WORKING_LABEL_GROK = "Reconnecting to Grok 4.6...";
export const WORKING_LABEL_AUTO = "Reconnecting to auto model...";

/**
 * @param {{ model?: { id?: string }, isFallback?: boolean, recreate?: boolean }} opts
 */
export function workingLabelForAttempt({ model, isFallback, recreate }) {
  const id = String(model?.id || "").toLowerCase();
  if (isFallback || id === "auto") return WORKING_LABEL_AUTO;
  if (recreate) return WORKING_LABEL_GROK;
  return WORKING_LABEL_DEFAULT;
}

/** After Auto has failed twice, wait 5 min three times, then escalate. */
export const CAPACITY_LATER_RETRY_MS = [
  5 * 60 * 1000,
  5 * 60 * 1000,
  5 * 60 * 1000,
  10 * 60 * 1000,
  20 * 60 * 1000,
  40 * 60 * 1000,
  60 * 60 * 1000,
];

/** Same-day follow-ups if a scheduled job still failed after in-process waits. */
export const BRIEFING_LATER_RETRY_MS = CAPACITY_LATER_RETRY_MS;

const AUTH_RE = /authentication error|not logged in|logging out and back in|invalid api key|unauthori[sz]ed|\b401\b/i;

const CAPACITY_RE =
  /high load|high demand|experiencing high demand|try again in a few moments|resource.?exhausted|overloaded|too many requests|\b429\b|model unavailable|capacity/i;

/**
 * @param {unknown} value
 * @param {string[]} out
 */
function collectText(value, out) {
  if (value == null) return;
  if (typeof value === "string") {
    if (value) out.push(value);
    return;
  }
  if (typeof value !== "object") return;
  const o = /** @type {Record<string, unknown>} */ (value);
  for (const key of [
    "message",
    "code",
    "error",
    "error_code",
    "errorCode",
    "result",
    "status",
    "name",
  ]) {
    const v = o[key];
    if (typeof v === "string" && v) out.push(v);
  }
}

/**
 * Grok 4.6 (and other) capacity / high-load failures. Not auth.
 * @param {unknown} err
 * @param {unknown} [result]
 */
export function isCursorCapacityFailure(err, result) {
  if (
    err &&
    typeof err === "object" &&
    (/** @type {{ status?: number }} */ (err).status === 429 ||
      /** @type {{ code?: unknown }} */ (err).code === 429 ||
      String(/** @type {{ code?: unknown }} */ (err).code || "")
        .toLowerCase()
        .includes("resource_exhausted") ||
      String(/** @type {{ code?: unknown }} */ (err).code || "")
        .toLowerCase()
        .includes("unavailable"))
  ) {
    return true;
  }

  /** @type {string[]} */
  const texts = [];
  collectText(err, texts);
  collectText(result, texts);
  return CAPACITY_RE.test(texts.join("\n"));
}

/**
 * @param {unknown} err
 * @param {unknown} [result]
 * @param {number} [elapsedMs]
 */
export function isCursorAuthFailure(err, result, elapsedMs) {
  if (isCursorCapacityFailure(err, result)) return false;

  if (
    err &&
    typeof err === "object" &&
    (/** @type {{ name?: string }} */ (err).name === "AuthenticationError" ||
      /** @type {{ status?: number }} */ (err).status === 401 ||
      /** @type {{ code?: string }} */ (err).code === "unauthenticated")
  ) {
    return true;
  }

  /** @type {string[]} */
  const texts = [];
  collectText(err, texts);
  collectText(result, texts);
  if (AUTH_RE.test(texts.join("\n"))) return true;

  const status = String(
    result && typeof result === "object"
      ? /** @type {{ status?: unknown }} */ (result).status || ""
      : ""
  ).toLowerCase();
  const body = String(
    result && typeof result === "object"
      ? /** @type {{ result?: unknown }} */ (result).result || ""
      : ""
  ).trim();
  // Auth failures die in ~100–300ms with status=error and no assistant text.
  // wait() often omits error_code, so treat a fast empty error as the same bug.
  if (
    status === "error" &&
    !body &&
    typeof elapsedMs === "number" &&
    elapsedMs >= 0 &&
    elapsedMs < 5000
  ) {
    return true;
  }
  return false;
}

/**
 * Auth, high-load, SDK isRetryable, or a finished run with status=error.
 * @param {unknown} err
 * @param {unknown} [result]
 * @param {number} [elapsedMs]
 */
export function isCursorRetryableFailure(err, result, elapsedMs) {
  if (
    err instanceof Error &&
    /CURSOR_API_KEY missing|@cursor\/sdk not installed/i.test(err.message)
  ) {
    return false;
  }
  if (isCursorCapacityFailure(err, result)) return true;
  if (isCursorAuthFailure(err, result, elapsedMs)) return true;
  if (
    err &&
    typeof err === "object" &&
    /** @type {{ isRetryable?: boolean }} */ (err).isRetryable === true
  ) {
    return true;
  }
  if (err && typeof err === "object") {
    const st = /** @type {{ status?: number }} */ (err).status;
    if (st === 429 || st === 502 || st === 503) return true;
  }
  const status = String(
    result && typeof result === "object"
      ? /** @type {{ status?: unknown }} */ (result).status || ""
      : ""
  ).toLowerCase();
  return status === "error";
}

/**
 * @param {{ id?: string }|null|undefined} model
 */
export function isGrokModel(model) {
  return String(model?.id || "")
    .toLowerCase()
    .startsWith("grok");
}

/**
 * Nightly one-shot jobs: Grok gets 8 attempts, others keep the shorter auth ladder.
 * @param {{ id?: string }|null|undefined} model
 */
export function scheduledPreferredDelaysMs(model) {
  return isGrokModel(model) ? NIGHTLY_GROK_DELAYS_MS : BRIEFING_AUTH_DELAYS_MS;
}

/**
 * Re-read CURSOR_API_KEY from server/.env into process.env.
 * Node --env-file only loads at boot; a rotated key would otherwise need a restart.
 * @param {string} [envPath]
 * @returns {Promise<boolean>} whether a non-empty key is now set
 */
export async function reloadCursorApiKeyFromEnv(envPath = DEFAULT_ENV_PATH) {
  try {
    const raw = await readFile(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      if (name !== "CURSOR_API_KEY") continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) process.env.CURSOR_API_KEY = value;
      break;
    }
  } catch {
    /* keep whatever is already in process.env */
  }
  return Boolean(String(process.env.CURSOR_API_KEY || "").trim());
}

export function requireCursorApiKey() {
  const apiKey = String(process.env.CURSOR_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("CURSOR_API_KEY missing");
    err.status = 503;
    throw err;
  }
  return apiKey;
}

export function sleep(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

/**
 * Sleep in 1s slices so a chat interrupt can cancel a 5–60 min high-load wait.
 * @param {number} ms
 * @param {() => boolean} [shouldAbort]
 * @returns {Promise<boolean>} true if aborted
 */
export async function sleepAbortable(ms, shouldAbort) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return Boolean(shouldAbort?.());
  const end = Date.now() + n;
  while (Date.now() < end) {
    if (shouldAbort?.()) return true;
    await sleep(Math.min(1000, end - Date.now()));
  }
  return Boolean(shouldAbort?.());
}

/**
 * Try `preferredModel` with `delaysMs`, then `fallbackModel` (Auto) twice.
 * If Auto is also overloaded, wait 5 min three times, then 10 / 20 / 40 / 60.
 *
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {{ id: string, params?: { id: string, value: string }[] }} opts.preferredModel
 * @param {number[]} opts.delaysMs
 * @param {{ id: string, params?: { id: string, value: string }[] }|null} [opts.fallbackModel]
 * @param {number[]} [opts.fallbackDelaysMs]
 * @param {number[]} [opts.laterDelaysMs]
 * @param {(ctx: { model: { id: string, params?: { id: string, value: string }[] }, attempt: number, isFallback: boolean, recreate: boolean }) => Promise<void>} [opts.onBeforeAttempt]
 * @param {(ctx: { waitMs: number, round: number, total: number }) => Promise<void>} [opts.onLaterWait]
 * @param {() => boolean} [opts.shouldAbort]
 * @param {(model: { id: string, params?: { id: string, value: string }[] }) => Promise<any>} opts.run
 */
export async function runWithModelFallback({
  prefix,
  preferredModel,
  delaysMs,
  fallbackModel = AUTO_MODEL_SELECTION,
  fallbackDelaysMs = INTERACTIVE_FALLBACK_DELAYS_MS,
  laterDelaysMs = CAPACITY_LATER_RETRY_MS,
  onBeforeAttempt,
  onLaterWait,
  shouldAbort,
  run,
}) {
  /** @type {{ model: { id: string, params?: { id: string, value: string }[] }, delays: number[], fallback: boolean }[]} */
  const stages = [{ model: preferredModel, delays: delaysMs, fallback: false }];
  if (
    fallbackModel &&
    String(fallbackModel.id) !== String(preferredModel?.id || "")
  ) {
    stages.push({
      model: fallbackModel,
      delays: fallbackDelaysMs,
      fallback: true,
    });
  }

  const laterModel = fallbackModel || preferredModel;
  const laterAttemptDelays =
    fallbackDelaysMs?.length ? fallbackDelaysMs : [0, 2000];

  /** @type {any} */
  let result = null;
  let authFailed = false;
  let capacityFailed = false;
  let elapsedMs = 0;
  let usedFallback = false;
  let model = preferredModel;

  const aborted = () => ({
    result,
    authFailed,
    capacityFailed,
    transientFailed: authFailed || capacityFailed,
    elapsedMs,
    usedFallback,
    model,
    aborted: true,
  });

  /**
   * @param {{ id: string, params?: { id: string, value: string }[] }} currentModel
   * @param {{ isFallback: boolean, recreate: boolean, attempt: number }} meta
   */
  async function tryOnce(currentModel, meta) {
    if (shouldAbort?.()) return { aborted: true };
    if (onBeforeAttempt) {
      await onBeforeAttempt({
        model: currentModel,
        attempt: meta.attempt,
        isFallback: meta.isFallback,
        recreate: meta.recreate,
      });
    }
    if (shouldAbort?.()) return { aborted: true };
    if (meta.delayMs) await sleep(meta.delayMs);
    if (shouldAbort?.()) return { aborted: true };
    await reloadCursorApiKeyFromEnv();
    const t0 = Date.now();
    try {
      const next = await run(currentModel);
      const took = Date.now() - t0;
      const status = String(next?.status || "").toLowerCase();
      console.log(
        `[${prefix}] agent status=${next?.status || "unknown"} elapsedMs=${took} model=${currentModel.id}`
      );
      if (status === "error") {
        const retryable = isCursorRetryableFailure(null, next, took);
        const capacity = isCursorCapacityFailure(null, next);
        const auth = isCursorAuthFailure(null, next, took);
        if (capacity) {
          logCursorCapacityFailure(
            prefix,
            null,
            next,
            took,
            meta.attempt,
            currentModel
          );
        } else if (auth) {
          logCursorAuthFailure(prefix, null, next, took, meta.attempt);
        }
        return {
          ok: false,
          result: next,
          elapsedMs: took,
          retryable,
          capacity,
          auth,
        };
      }
      return { ok: true, result: next, elapsedMs: took };
    } catch (err) {
      const took = Date.now() - t0;
      const retryable = isCursorRetryableFailure(err, null, took);
      const capacity = isCursorCapacityFailure(err, null);
      const auth = isCursorAuthFailure(err, null, took);
      if (capacity) {
        logCursorCapacityFailure(
          prefix,
          err,
          null,
          took,
          meta.attempt,
          currentModel
        );
      } else if (auth) {
        logCursorAuthFailure(prefix, err, null, took, meta.attempt);
      }
      return {
        ok: false,
        err,
        elapsedMs: took,
        retryable,
        capacity,
        auth,
      };
    }
  }

  function applyFlags(outcome) {
    elapsedMs = outcome.elapsedMs || elapsedMs;
    if (outcome.result !== undefined) result = outcome.result;
    if (outcome.capacity) capacityFailed = true;
    if (outcome.auth) authFailed = true;
  }

  for (let s = 0; s < stages.length; s++) {
    const stage = stages[s];
    const moreStages = s < stages.length - 1;
    for (let i = 0; i < stage.delays.length; i++) {
      if (shouldAbort?.()) return aborted();
      if (stage.fallback && i === 0) {
        usedFallback = true;
        console.warn(
          `[${prefix}] falling back to ${stage.model.id} after ${delaysMs.length} attempts on ${preferredModel.id}`
        );
      }
      model = stage.model;
      const outcome = await tryOnce(stage.model, {
        isFallback: stage.fallback,
        recreate: i > 0 || stage.fallback,
        attempt: i + 1,
        delayMs: i > 0 ? stage.delays[i] : 0,
      });
      if (outcome.aborted) return aborted();
      applyFlags(outcome);
      if (outcome.ok) {
        return {
          result: outcome.result,
          authFailed: false,
          capacityFailed: false,
          transientFailed: false,
          elapsedMs,
          usedFallback,
          model: stage.model,
          aborted: false,
        };
      }
      const moreInStage = i < stage.delays.length - 1;
      if (outcome.retryable && (moreInStage || moreStages)) continue;
      if (outcome.err && !(outcome.retryable && outcome.capacity && laterDelaysMs.length)) {
        throw outcome.err;
      }
      if (!outcome.retryable) {
        return {
          result,
          authFailed,
          capacityFailed,
          transientFailed: authFailed || capacityFailed,
          elapsedMs,
          usedFallback,
          model: stage.model,
          aborted: false,
        };
      }
    }
  }

  if (capacityFailed && laterDelaysMs.length && laterModel) {
    usedFallback = true;
    for (let r = 0; r < laterDelaysMs.length; r++) {
      const waitMs = laterDelaysMs[r];
      console.warn(
        `[${prefix}] high load on ${laterModel.id}; waiting ${Math.round(waitMs / 60000)} min before retry ${r + 1}/${laterDelaysMs.length}`
      );
      if (onLaterWait) {
        await onLaterWait({
          waitMs,
          round: r + 1,
          total: laterDelaysMs.length,
        });
      }
      if (await sleepAbortable(waitMs, shouldAbort)) return aborted();
      for (let i = 0; i < laterAttemptDelays.length; i++) {
        model = laterModel;
        const outcome = await tryOnce(laterModel, {
          isFallback: true,
          recreate: true,
          attempt: i + 1,
          delayMs: i > 0 ? laterAttemptDelays[i] : 0,
        });
        if (outcome.aborted) return aborted();
        applyFlags(outcome);
        if (outcome.ok) {
          return {
            result: outcome.result,
            authFailed: false,
            capacityFailed: false,
            transientFailed: false,
            elapsedMs,
            usedFallback: true,
            model: laterModel,
            aborted: false,
          };
        }
        const moreInRound = i < laterAttemptDelays.length - 1;
        const moreRounds = r < laterDelaysMs.length - 1;
        if (outcome.retryable && (moreInRound || moreRounds)) continue;
        if (outcome.err && !outcome.retryable) throw outcome.err;
      }
    }
  }

  if (result == null && authFailed === false && capacityFailed === false) {
    /* stages produced neither a result nor flags — should not happen */
  }

  return {
    result,
    authFailed,
    capacityFailed,
    transientFailed: authFailed || capacityFailed,
    elapsedMs,
    usedFallback,
    model,
    aborted: false,
  };
}

/**
 * Agent.prompt with scheduled-job retries, then Auto if the preferred model dies.
 * Reloads CURSOR_API_KEY from server/.env between attempts. Does not restart Express.
 *
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {string} [opts.prompt]
 * @param {{ id: string, params?: { id: string, value: string }[] }} [opts.model]
 * @param {string} [opts.cwd]
 * @param {number[]} [opts.delaysMs]
 * @param {{ id: string, params?: { id: string, value: string }[] }|null} [opts.fallbackModel]
 * @param {number[]} [opts.fallbackDelaysMs]
 * @param {number[]} [opts.laterDelaysMs]
 * @param {(apiKey: string, model?: { id: string, params?: { id: string, value: string }[] }) => Promise<any>} [opts.promptFn]
 * @returns {Promise<{
 *   result: any,
 *   authFailed: boolean,
 *   capacityFailed: boolean,
 *   transientFailed: boolean,
 *   elapsedMs: number,
 *   usedFallback: boolean,
 *   model: { id: string, params?: { id: string, value: string }[] },
 *   aborted: boolean,
 * }>}
 */
export async function promptWithAuthRetry({
  prefix,
  prompt,
  model,
  cwd,
  delaysMs,
  fallbackModel,
  fallbackDelaysMs,
  laterDelaysMs,
  promptFn,
}) {
  const preferred = model || AUTO_MODEL_SELECTION;
  const preferredDelays = delaysMs ?? scheduledPreferredDelaysMs(preferred);
  const fbModel =
    fallbackModel === undefined ? AUTO_MODEL_SELECTION : fallbackModel;
  const fbDelays =
    fallbackDelaysMs ??
    (isGrokModel(preferred)
      ? NIGHTLY_FALLBACK_DELAYS_MS
      : INTERACTIVE_FALLBACK_DELAYS_MS);

  let runPrompt = promptFn;
  if (!runPrompt) {
    let Agent;
    try {
      ({ Agent } = await import("@cursor/sdk"));
    } catch (err) {
      const e = new Error(
        `@cursor/sdk not installed: ${err instanceof Error ? err.message : String(err)}`
      );
      e.status = 503;
      throw e;
    }
    runPrompt = (apiKey, currentModel) =>
      Agent.prompt(prompt, {
        apiKey,
        model: currentModel,
        local: { cwd },
      });
  }

  return runWithModelFallback({
    prefix,
    preferredModel: preferred,
    delaysMs: preferredDelays,
    fallbackModel: fbModel,
    fallbackDelaysMs: fbDelays,
    laterDelaysMs: laterDelaysMs ?? CAPACITY_LATER_RETRY_MS,
    onBeforeAttempt: async ({ recreate }) => {
      if (recreate) await evictLocalCursorExecutor();
    },
    run: async (currentModel) =>
      runPrompt(requireCursorApiKey(), currentModel),
  });
}

/**
 * Same-day follow-ups after Cursor auth died. Does not restart Express.
 * The `run` callback should skip if the job already succeeded.
 *
 * @param {object} opts
 * @param {string} opts.prefix
 * @param {(opts: { dateKey: string }) => Promise<unknown>} opts.run
 * @param {number[]} [opts.delaysMs]
 */
export function createLaterAuthRetry({
  prefix,
  run,
  delaysMs = BRIEFING_LATER_RETRY_MS,
}) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer = null;
  let attempt = 0;

  function clear() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    attempt = 0;
  }

  /**
   * @param {string} dateKey
   */
  function schedule(dateKey) {
    if (attempt >= delaysMs.length) {
      console.error(
        `[${prefix}] giving up same-day retries for ${dateKey}`
      );
      return;
    }
    if (timer) clearTimeout(timer);
    const wait = delaysMs[attempt];
    attempt += 1;
    console.log(
      `[${prefix}] retry ${attempt}/${delaysMs.length} for ${dateKey} in ${Math.round(wait / 60000)} min`
    );
    timer = setTimeout(() => {
      timer = null;
      Promise.resolve(run({ dateKey })).catch((err) => {
        console.error(`[${prefix}] later auth retry failed`, err);
        schedule(dateKey);
      });
    }, wait);
  }

  return {
    schedule,
    clear,
    get attempt() {
      return attempt;
    },
  };
}

/**
 * wait() often returns an error object. String() becomes "[object Object]".
 * @param {unknown} value
 */
export function formatLogValue(value) {
  if (value == null || value === "") return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message || value.name || "";
  try {
    const json = JSON.stringify(value);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }
  const s = String(value);
  return s === "[object Object]" ? "" : s;
}

export function logCursorAuthFailure(prefix, err, result, elapsedMs, attempt) {
  const status =
    result && typeof result === "object"
      ? /** @type {{ status?: unknown }} */ (result).status
      : undefined;
  const errorCode =
    result && typeof result === "object"
      ? /** @type {{ error?: unknown, error_code?: unknown, errorCode?: unknown }} */ (
          result
        ).error_code ||
        /** @type {{ errorCode?: unknown }} */ (result).errorCode ||
        /** @type {{ error?: unknown }} */ (result).error
      : undefined;
  const msg = err instanceof Error ? err.message : err ? formatLogValue(err) : "";
  const errorText = formatLogValue(errorCode);
  console.warn(
    `[${prefix}] cursor auth failure attempt=${attempt ?? 1}` +
      (elapsedMs != null ? ` elapsedMs=${elapsedMs}` : "") +
      (status ? ` status=${status}` : "") +
      (errorText ? ` error=${errorText}` : "") +
      (msg ? ` thrown=${msg}` : "")
  );
}

/**
 * @param {string} prefix
 * @param {unknown} err
 * @param {unknown} [result]
 * @param {number} [elapsedMs]
 * @param {number} [attempt]
 * @param {{ id?: string }} [model]
 */
export function logCursorCapacityFailure(
  prefix,
  err,
  result,
  elapsedMs,
  attempt,
  model
) {
  const msg = err instanceof Error ? err.message : err ? formatLogValue(err) : "";
  const body =
    result && typeof result === "object"
      ? formatLogValue(
          /** @type {{ result?: unknown, error?: unknown, error_code?: unknown }} */ (
            result
          ).error_code ||
            /** @type {{ error?: unknown }} */ (result).error ||
            /** @type {{ result?: unknown }} */ (result).result ||
            ""
        )
      : "";
  console.warn(
    `[${prefix}] cursor capacity failure attempt=${attempt ?? 1}` +
      (model?.id ? ` model=${model.id}` : "") +
      (elapsedMs != null ? ` elapsedMs=${elapsedMs}` : "") +
      (body ? ` error=${body}` : "") +
      (msg ? ` thrown=${msg}` : "")
  );
}

/** @type {Set<any>} */
const liveLocalAgents = new Set();

/** @type {Set<() => void>} */
const executorEvictListeners = new Set();

/** Serialize overlapping evicts so refcount teardown stays ordered. */
let evictChain = Promise.resolve();

/**
 * Owners register so they can drop disposed Agent handles (session.agent = null).
 * @param {() => void} fn
 * @returns {() => void} unsubscribe
 */
export function onLocalCursorExecutorEvict(fn) {
  executorEvictListeners.add(fn);
  return () => executorEvictListeners.delete(fn);
}

/**
 * @param {unknown} agent
 */
async function disposeAgentHandle(agent) {
  if (!agent || typeof agent !== "object") return;
  const a = /** @type {{ [key: symbol]: unknown, close?: Function }} */ (agent);
  try {
    if (typeof a[Symbol.asyncDispose] === "function") {
      await a[Symbol.asyncDispose]();
    } else if (typeof a.close === "function") {
      await a.close();
    }
  } catch {
    /* ignore */
  }
}

async function evictLocalCursorExecutorUnlocked() {
  const agents = [...liveLocalAgents];
  liveLocalAgents.clear();
  await Promise.all(agents.map((agent) => disposeAgentHandle(agent)));
  for (const fn of [...executorEvictListeners]) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Drop every live Agent so the SDK executor cache refcount hits 0 and the
 * stale gRPC client is actually torn down. Next create()+send() is a cache miss.
 */
export async function evictLocalCursorExecutor() {
  const run = evictChain.then(() => evictLocalCursorExecutorUnlocked());
  evictChain = run.catch(() => {});
  await run;
}

/**
 * @param {unknown} agent
 */
export async function disposeCursorAgent(agent) {
  liveLocalAgents.delete(agent);
  await disposeAgentHandle(agent);
}

/**
 * @param {{ model: { id: string, params?: { id: string, value: string }[] }, cwd: string }} opts
 */
export async function createLocalCursorAgent({ model, cwd }) {
  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const { Agent } = await import("@cursor/sdk");
  const agent = await Agent.create({
    apiKey,
    model,
    local: { cwd },
  });
  liveLocalAgents.add(agent);
  return agent;
}

/**
 * Evict the shared executor, then create a fresh Agent.
 * `attach` runs in the same lock as create so the owner pointer is never a
 * handle that another evict already disposed.
 * @param {{
 *   model: { id: string, params?: { id: string, value: string }[] },
 *   cwd: string,
 *   attach?: (agent: any) => void,
 * }} opts
 */
export async function recreateLocalCursorAgent({ model, cwd, attach }) {
  const run = evictChain.then(async () => {
    await evictLocalCursorExecutorUnlocked();
    const agent = await createLocalCursorAgent({ model, cwd });
    if (typeof attach === "function") attach(agent);
    return agent;
  });
  evictChain = run.catch(() => {});
  return run;
}
