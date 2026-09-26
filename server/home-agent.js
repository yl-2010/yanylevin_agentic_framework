/**
 * Hourly home vacuum check. Cheap gates first. Composer 2.5 only when a
 * vacuum might be due. Local Cursor SDK one-shot. Yan only.
 * Does not run on server boot. Does not git-commit.
 */

import { mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { briefingNow, resolveBriefingTimezone } from "./daily-briefing-agent.js";
import {
  createLaterAuthRetry,
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { runHome } from "./home-cli.js";
import { haversineMeters, KNOWN_PLACES } from "./life-state-snapshot.js";
import { readPhoneLocation, YAN_EMAIL } from "./phone-location.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = "/tmp/yanylevin-home-agent.lock";
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);
const TZ = "America/Los_Angeles";

export const HOME_AGENT_INTERVAL_MS = 60 * 60 * 1000;
export const VACUUM_DUE_MS = 72 * 60 * 60 * 1000;
export const VACUUM_SCENE = "Vacuum Yan";
export const VACUUM_SCENE_FORBIDDEN = "Vacuum Yan's Rooms";
const LOCK_STALE_MS = 15 * 60 * 1000;

const HOME_PLACE = KNOWN_PLACES.find((p) => p.slug === "kirkland-home");

export const HOME_AGENT_MODEL_SPEC = {
  id: process.env.CURSOR_HOME_AGENT_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

/** @type {Promise<unknown>|null} */
let inFlight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

const laterAuthRetry = createLaterAuthRetry({
  prefix: "home-agent",
  run: () => runHomeAgent({ force: true }),
});

/**
 * @param {string} [root]
 */
export function vacuumStatePath(root = REPO_ROOT) {
  return join(root, "education", YAN_EMAIL, "home", "vacuum.json");
}

/**
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
 */
function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

export function homeAgentModelSpec() {
  return modelSelection(HOME_AGENT_MODEL_SPEC);
}

/**
 * Wait until the next Pacific clock hour. On the hour, wait a full hour.
 * @param {number} [nowMs]
 * @param {string} [timeZone]
 */
export function msUntilNextHomeAgentTick(nowMs = Date.now(), timeZone = TZ) {
  const n = Number(nowMs);
  const t = Number.isFinite(n) ? n : Date.now();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt
      .formatToParts(new Date(t))
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );
  const minute = Number(parts.minute) || 0;
  const second = Number(parts.second) || 0;
  const into = (minute * 60 + second) * 1000 + (t % 1000);
  if (into === 0) return HOME_AGENT_INTERVAL_MS;
  return HOME_AGENT_INTERVAL_MS - into;
}

/**
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 */
export function vacuumIsDue(iso, nowMs) {
  if (!iso) return true;
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return true;
  return nowMs - started >= VACUUM_DUE_MS;
}

/**
 * @param {string|null|undefined} iso
 * @param {number} nowMs
 */
export function nextCheckStillOpen(iso, nowMs) {
  if (!iso) return false;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  return at > nowMs;
}

/**
 * @param {{ latitude?: number, longitude?: number, accuracyMeters?: number }|null|undefined} location
 */
export function classifyVacuumLocation(location) {
  const lat = location?.latitude;
  const lng = location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !HOME_PLACE) {
    return { kind: "missing" };
  }
  const meters = haversineMeters(lat, lng, HOME_PLACE.lat, HOME_PLACE.lng);
  const accuracy = Number(location.accuracyMeters);
  const pad = Number.isFinite(accuracy) && accuracy > 0 ? accuracy : 0;
  if (meters <= HOME_PLACE.radiusM) return { kind: "home", meters };
  if (meters - pad > HOME_PLACE.radiusM) return { kind: "away", meters };
  return { kind: "unclear", meters };
}

/**
 * HomeClaw often lists action_count 0 for Vacuum Yan. That scene still
 * starts the Roomba. A trigger that returns without an error is a real start.
 * @param {{
 *   nowMs?: number,
 *   force?: boolean,
 *   lastStartedAt?: string|null,
 *   nextCheckAt?: string|null,
 *   location?: { latitude?: number, longitude?: number, accuracyMeters?: number }|null,
 * }} opts
 */
export function homeVacuumGate(opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  if (opts.force) return { run: true, reason: "force" };
  if (nextCheckStillOpen(opts.nextCheckAt, nowMs)) {
    return { run: false, reason: "next-check" };
  }
  if (!vacuumIsDue(opts.lastStartedAt, nowMs)) {
    return { run: false, reason: "recent-vacuum" };
  }
  const where = classifyVacuumLocation(opts.location);
  if (where.kind === "home") return { run: false, reason: "at-home" };
  if (where.kind === "missing") return { run: false, reason: "no-pin" };
  if (where.kind === "unclear") return { run: false, reason: "not-clearly-away" };
  return { run: true, reason: "due" };
}

/**
 * @param {{ dateKey: string, timezone: string, vacuumPath: string, location?: object|null }} opts
 */
export function buildHomeAgentPrompt(opts) {
  const pin = opts.location;
  const pinAt = pin?.timestamp || pin?.receivedAt || "unknown";
  const pinLine = pin
    ? `Phone pin: ${pin.latitude}, ${pin.longitude} at ${pinAt}${
        pin.accuracyMeters != null ? `, accuracy ${pin.accuracyMeters}m` : ""
      }.`
    : "Phone pin: missing.";
  return [
    "Follow the home-agent skill (.cursor/skills/home-agent/SKILL.md).",
    "Decide whether to start the Roomba. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${opts.dateKey} (timezone ${opts.timezone}).`,
    `Vacuum state file: ${opts.vacuumPath}`,
    pinLine,
    `The only scene you may trigger is ${JSON.stringify(VACUUM_SCENE)}.`,
    `Never trigger ${JSON.stringify(VACUUM_SCENE_FORBIDDEN)}.`,
    "Parents live in the house. Yan being out does not mean the house is empty.",
    "Start the vacuum only if he is unlikely to be home within 2 hours and the house will not be asleep during those 2 hours.",
    "Early morning, and an evening where people will be in bed within 2 hours, are no. A long absence does not override that.",
    "Read the vacuum file, Apple Calendar for the next several hours (node server/calendar-cli.js events), life-state now and recent samples (node server/life-state.js now, node server/life-state.js recent 6), and today's class schedule when it is a school day (education/you@example.com/schedule.json).",
    `If yes: node server/home-agent.js trigger --reason "<one line>"`,
    `That runs home-cli trigger ${JSON.stringify(VACUUM_SCENE)} and then record-start.`,
    "HomeClaw listing action_count 0 is normal for this scene. The Roomba still starts. Record the start unless the trigger command itself fails.",
    "If the trigger fails, do not record a start.",
    "If no: node server/home-agent.js record-skip --reason \"<one line>\" --next-check <ISO time>",
    "A skip must not change lastStartedAt.",
    "Do not git commit. Do not edit any other file.",
  ].join("\n");
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

/**
 * @param {string} [path]
 */
export async function readVacuumState(path = vacuumStatePath()) {
  try {
    const raw = JSON.parse(await readFile(path, "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} patch
 * @param {{ clear?: string[] }} [opts]
 */
async function writeVacuumPatch(path, patch, opts = {}) {
  const prev = await readVacuumState(path);
  const next = { ...prev, ...patch };
  for (const key of opts.clear || []) delete next[key];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/**
 * @param {{ path?: string, at?: string, reason?: string }} opts
 */
export async function recordVacuumStart(opts = {}) {
  const path = opts.path || vacuumStatePath();
  const at = opts.at || new Date().toISOString();
  return writeVacuumPatch(
    path,
    {
      lastStartedAt: at,
      scene: VACUUM_SCENE,
      reason: String(opts.reason || "").trim().slice(0, 240),
    },
    { clear: ["nextCheckAt", "lastSkippedAt", "skipReason"] }
  );
}

/**
 * @param {{ path?: string, at?: string, reason?: string, nextCheckAt?: string }} opts
 */
export async function recordVacuumSkip(opts = {}) {
  const path = opts.path || vacuumStatePath();
  const at = opts.at || new Date().toISOString();
  const nextCheckAt = opts.nextCheckAt ? String(opts.nextCheckAt) : "";
  if (!nextCheckAt || Number.isNaN(Date.parse(nextCheckAt))) {
    throw new Error("record-skip needs --next-check as an ISO time");
  }
  return writeVacuumPatch(path, {
    lastSkippedAt: at,
    skipReason: String(opts.reason || "").trim().slice(0, 240),
    nextCheckAt: new Date(nextCheckAt).toISOString(),
  });
}

/**
 * @param {string} apiKey
 * @param {{ id: string, params: { id: string, value: string }[] }} spec
 */
async function resolveModelSelection(apiKey, spec) {
  const fallback = modelSelection(spec);
  try {
    const { Cursor } = await import("@cursor/sdk");
    const models = await Cursor.models.list({ apiKey });
    const listed = models?.find((m) => m?.id === fallback.id);
    if (!listed) return fallback;
    const wanted = fallback.params;
    const variant = (listed.variants || []).find((v) => {
      const params = v?.params || [];
      if (wanted.length === 0) return !params.length;
      return wanted.every((w) =>
        params.some((p) => p.id === w.id && p.value === w.value)
      );
    });
    if (variant?.params?.length) {
      return modelSelection({ id: listed.id, params: variant.params });
    }
    return fallback;
  } catch (err) {
    console.warn(
      "[home-agent] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

export async function isHomeAgentBusy() {
  if (inFlight) return true;
  try {
    await stat(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock() {
  try {
    const handle = await open(LOCK_PATH, "wx");
    await handle.writeFile(String(process.pid));
    return handle;
  } catch (err) {
    if (!err || err.code !== "EEXIST") throw err;
    try {
      const st = await stat(LOCK_PATH);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        await rm(LOCK_PATH, { force: true });
        const handle = await open(LOCK_PATH, "wx");
        await handle.writeFile(String(process.pid));
        return handle;
      }
    } catch {
      /* still locked */
    }
    return null;
  }
}

async function releaseLock(handle) {
  try {
    await handle.close();
  } catch {
    /* ignore */
  }
  await rm(LOCK_PATH, { force: true });
}

/**
 * @param {{ force?: boolean }} [opts]
 */
export async function runHomeAgent(opts = {}) {
  if (inFlight) {
    return { ok: true, skipped: true, reason: "in-flight" };
  }
  inFlight = runHomeAgentOnce(opts).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * @param {{ force?: boolean }} [opts]
 */
async function runHomeAgentOnce({ force = false } = {}) {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const dateKey = now.dateKey;
  const timezone = resolveBriefingTimezone(meta, dateKey);
  const nowMs = Date.now();
  const state = await readVacuumState();
  const location = await readPhoneLocation();
  const gate = homeVacuumGate({
    nowMs,
    force,
    lastStartedAt: state.lastStartedAt,
    nextCheckAt: state.nextCheckAt,
    location,
  });

  if (!gate.run) {
    console.log(`[home-agent] skip ${dateKey}: ${gate.reason}`);
    return { ok: true, skipped: true, reason: gate.reason, dateKey };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log(`[home-agent] skip ${dateKey}: in-flight lock`);
    return { ok: true, skipped: true, reason: "in-flight", dateKey };
  }

  try {
    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, HOME_AGENT_MODEL_SPEC);
    console.log(
      `[home-agent] deciding ${dateKey} tz=${timezone} model=${model.id} force=${Boolean(force)}`
    );
    const prompt = buildHomeAgentPrompt({
      dateKey,
      timezone,
      vacuumPath: vacuumStatePath(),
      location,
    });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "home-agent",
        prompt,
        model,
        cwd: REPO_ROOT,
      });

    if (usedFallback) {
      console.warn("[home-agent] used auto after preferred-model retries");
    }
    if (transientFailed) {
      laterAuthRetry.schedule(dateKey);
      return {
        ok: false,
        dateKey,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }

    laterAuthRetry.clear();
    return {
      ok: true,
      dateKey,
      status: result?.status || "finished",
    };
  } finally {
    await releaseLock(handle);
  }
}

function armTimer() {
  if (timer) clearTimeout(timer);
  const delay = msUntilNextHomeAgentTick();
  const when = new Date(Date.now() + delay);
  console.log(
    `[home-agent] next check ${when.toISOString()} (in ${Math.round(delay / 1000)}s)`
  );
  timer = setTimeout(() => {
    runHomeAgent()
      .catch((err) => console.error("[home-agent] scheduled run failed", err))
      .finally(() => {
        try {
          armTimer();
        } catch (err) {
          console.error("[home-agent] reschedule failed", err);
          timer = setTimeout(() => startHomeAgentScheduler(), 60 * 1000);
        }
      });
  }, delay);
}

export function startHomeAgentScheduler() {
  armTimer();
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1) return "";
  return process.argv[i + 1] || "";
}

const isMain = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return pathToFileURL(arg).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  const cmd = process.argv[2];
  const force = process.argv.includes("--force");
  const run = async () => {
    if (cmd === "trigger") {
      await runHome(["trigger", VACUUM_SCENE]);
      const state = await recordVacuumStart({ reason: argValue("--reason") });
      console.log("[home-agent] recorded start", state.lastStartedAt);
      return;
    }
    if (cmd === "record-start") {
      const state = await recordVacuumStart({ reason: argValue("--reason") });
      console.log("[home-agent] recorded start", state.lastStartedAt);
      return;
    }
    if (cmd === "record-skip") {
      const state = await recordVacuumSkip({
        reason: argValue("--reason"),
        nextCheckAt: argValue("--next-check"),
      });
      console.log("[home-agent] recorded skip until", state.nextCheckAt);
      return;
    }
    const result = await runHomeAgent({ force });
    console.log("[home-agent]", result);
    if (!result?.ok && !result?.skipped) process.exitCode = 1;
  };
  run().catch((err) => {
    console.error("[home-agent] failed", err);
    process.exitCode = 1;
  });
}
