/**
 * One-shot Composer 2.5 (Fast off) passes over Apple Health history.
 * Not scheduled. Do not run unless Yan asks.
 *
 *   node --env-file=.env health-history-agent.js --patterns
 *   node --env-file=.env health-history-agent.js --summer
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  briefingNow,
} from "./daily-briefing-agent.js";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import {
  SUMMER_START,
  writeHealthDigests,
} from "./health-history-digest.js";
import { HEALTH_TAKEAWAYS_MODEL_SPEC } from "./health-takeaways-agent.js";
import { HEALTH_REL, HEALTH_TIMEZONE, YAN_EMAIL, healthDir } from "./phone-health.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const META_PATH = join(
  REPO_ROOT,
  "education",
  YAN_EMAIL,
  "daily-briefing",
  "meta.json"
);

function modelSelection(spec) {
  return {
    id: String(spec.id),
    params: (spec.params || []).map((p) => ({
      id: String(p.id),
      value: String(p.value),
    })),
  };
}

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
  } catch {
    return fallback;
  }
}

async function readMeta() {
  const raw = await readFile(META_PATH, "utf8");
  const meta = JSON.parse(raw);
  if (!meta || typeof meta !== "object") {
    throw new Error("daily-briefing meta.json missing");
  }
  return meta;
}

export function healthHistoryModelSpec() {
  return modelSelection(HEALTH_TAKEAWAYS_MODEL_SPEC);
}

export function buildHistoryPatternsPrompt({ timezone }) {
  const hist = HEALTH_REL;
  return [
    "Follow the health-history skill (.cursor/skills/health-history/SKILL.md).",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    `Timezone ${timezone}.`,
    `Health folder: ${hist}/.`,
    "Read digest-history.md and workouts.md. Do not open raw/apple-export-*.json.",
    "Write history-patterns.md: standing patterns across 2022–2026. Training mix, sleep timing, swim vs strength seasons, recovery tells that repeat.",
    "Inferences, not diagnoses. No sample dumps. No gym machine weights unless a Watch workout name clearly matches.",
  ].join("\n");
}

export function buildSummerTakeawaysPrompt({ dateKey, timezone, start, end }) {
  const hist = HEALTH_REL;
  return [
    "Follow the health-takeaways skill (.cursor/skills/health-takeaways/SKILL.md), including the summer backfill section.",
    "Turn Yan's Apple Health into natural-language takeaways. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent.",
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    `Health folder: ${hist}/.`,
    `Backfill every local day from ${start} through ${end}. Same paragraph length and granularity as the nightly 01:00 job.`,
    "Read digest-summer-shortcut.md, workouts.md, and the existing takeaways.md.",
    "That digest is already filtered to shortcut types. Do not use Time in Daylight, Physical Effort, UV Index, State of Mind, cycling speed, cycling cadence, or Workout Effort Score.",
    "Do not open raw/apple-export-*.json.",
    "Write takeaways.md: short prose per day, newest day on top. Call out workouts by name, duration, and effort. Sleep as hours plus quality tells. Mention RHR/HRV/steps only when they moved.",
    "Keep days that are already in takeaways.md if they still look right. Fill the gap back to the start date.",
    "Do not dump tables of every sample. Do not invent diagnoses. This is lifestyle context, not a medical chart.",
    "Gym machine weights live under fitness/ and are a different log. Do not mix them in unless a workout name clearly matches.",
    "Update state.json lastTakeawaysAt when you finish.",
  ].join("\n");
}

async function runPrompt(kind, prompt) {
  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const model = await resolveModelSelection(apiKey, HEALTH_TAKEAWAYS_MODEL_SPEC);
  console.log(`[health-history] ${kind} model=${model.id} fast=false`);
  const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
    await promptWithAuthRetry({
      prefix: `health-history-${kind}`,
      prompt,
      model,
      cwd: REPO_ROOT,
    });
  if (usedFallback) {
    console.warn("[health-history] used auto after preferred-model retries");
  }
  if (transientFailed) {
    return {
      ok: false,
      kind,
      status: result?.status || "error",
      reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
    };
  }
  await gitAddCommitPush({
    paths: [HEALTH_REL],
    message:
      kind === "patterns"
        ? "health: history patterns"
        : "health: summer takeaways backfill",
  });
  return { ok: true, kind, status: result?.status || "finished" };
}

export async function runHealthHistoryPatterns() {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const timezone = HEALTH_TIMEZONE;
  await writeHealthDigests({ timezone, today: now.dateKey });
  return runPrompt("patterns", buildHistoryPatternsPrompt({ timezone }));
}

export async function runHealthSummerTakeaways() {
  const meta = await readMeta();
  const now = briefingNow(meta);
  const timezone = HEALTH_TIMEZONE;
  await writeHealthDigests({ timezone, today: now.dateKey });
  return runPrompt(
    "summer",
    buildSummerTakeawaysPrompt({
      dateKey: now.dateKey,
      timezone,
      start: SUMMER_START,
      end: now.dateKey,
    })
  );
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
  const patterns = process.argv.includes("--patterns");
  const summer = process.argv.includes("--summer");
  if (!patterns && !summer) {
    console.log("usage: node health-history-agent.js --patterns | --summer");
    console.log("Do not run until Yan says so.");
    process.exit(0);
  }
  const jobs = [];
  if (patterns) jobs.push(() => runHealthHistoryPatterns());
  if (summer) jobs.push(() => runHealthSummerTakeaways());
  try {
    for (const job of jobs) {
      const result = await job();
      console.log("[health-history]", result);
      if (!result?.ok) process.exitCode = 1;
    }
  } catch (err) {
    console.error("[health-history] failed", err);
    process.exitCode = 1;
  }
}

void healthDir;
