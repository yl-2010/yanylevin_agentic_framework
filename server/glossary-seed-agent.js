/**
 * One-shot Composer 2.5 (Fast off) seed of brain/glossary.
 * Not on the nightly clock. Yan only.
 *
 *   node --env-file=server/.env server/glossary-seed-agent.js --force
 */

import { open, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { listGlossary } from "./brain-glossary.js";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { BRAIN_DIR as BRAIN_REL } from "./onedrive-projects.js";
const LOCK_PATH = "/tmp/yanylevin-glossary-seed.lock";
const LOCK_STALE_MS = 90 * 60 * 1000;

export const GLOSSARY_SEED_MODEL_SPEC = {
  id: process.env.CURSOR_GLOSSARY_SEED_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

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

export function glossarySeedModelSpec() {
  return modelSelection(GLOSSARY_SEED_MODEL_SPEC);
}

export function buildGlossarySeedPrompt({ dateKey, timezone }) {
  const brain = BRAIN_REL;
  return [
    "You are seeding Yan's glossary once. Yan only (you@example.com).",
    "Local only. Never spawn a Cursor cloud agent. ",
    `Follow the glossary contract in ${brain}/schema.md.`,
    `Today's date key: ${dateKey} (timezone ${timezone}).`,
    "Write terms only through node server/brain-glossary.js add --term \"...\" --gloss \"...\" [--aliases \"a, b\"] [--see orgs/slug].",
    "Do not hand-edit glossary files or glossary/index.md. The add command regenerates the index and sets last_touched.",
    "Do not git commit. Education-sync publishes glossary markdown.",
    `Read ${brain}/identity.md, ${brain}/identity-school.md, ${brain}/identity-accounts.md, ${brain}/identity-logistics.md, ${brain}/patterns.md, and ${brain}/threads/.`,
    `Read the newest 14 files in ${brain}/journal/.`,
    `Read frontmatter only of ${brain}/orgs/, ${brain}/groups/, and ${brain}/places/. When an abbreviation is that entity's shorthand, add a pointer with --see. Do not copy the card into the gloss.`,
    "Read class short names from /Users/you/Library/CloudStorage/OneDrive-Personal/Projects/.education/classes/*/class.json (the name field) and .cursor/skills/class-schedule/SKILL.md for schedule words.",
    "Skip people aliases. Those stay on person cards. Do not glob brain/people/.",
    "Skip full chat history and OneNote.",
    "Skip secrets, passwords, and diagnoses. Skip a term when the meaning is not clear. A wrong expansion is worse than a miss.",
    "Prefer a smaller accurate set. Gloss is one paragraph under 400 characters.",
    "If the term or an alias already exists, add updates that file. Do not create a second file.",
    "When you finish, run node server/brain-glossary.js --check and fix what it reports.",
    "Reply with how many terms you added or updated.",
  ].join("\n");
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
      return wanted.every((w) => params.some((p) => p.id === w.id && p.value === w.value));
    });
    if (variant?.params?.length) {
      return modelSelection({ id: listed.id, params: variant.params });
    }
    return fallback;
  } catch (err) {
    console.warn(
      "[glossary-seed] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err,
    );
    return fallback;
  }
}

/**
 * @param {{ force?: boolean, dateKey?: string, timezone?: string }} [opts]
 */
export async function runGlossarySeed(opts = {}) {
  const { force = false, dateKey = "", timezone = "America/Los_Angeles" } = opts;
  const { entries } = listGlossary();
  if (!force && entries.length > 0) {
    console.log(`[glossary-seed] skip: ${entries.length} terms already`);
    return { ok: true, skipped: true, reason: "already-seeded", count: entries.length };
  }

  const handle = await acquireLock();
  if (!handle) {
    console.log("[glossary-seed] skip: in-flight lock");
    return { ok: true, skipped: true, reason: "in-flight" };
  }

  try {
    await reloadCursorApiKeyFromEnv();
    const apiKey = requireCursorApiKey();
    const model = await resolveModelSelection(apiKey, GLOSSARY_SEED_MODEL_SPEC);
    const today = dateKey || new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    console.log(`[glossary-seed] ${today} tz=${timezone} model=${model.id}`);
    const prompt = buildGlossarySeedPrompt({ dateKey: today, timezone });
    const { result, authFailed, capacityFailed, transientFailed, usedFallback } =
      await promptWithAuthRetry({
        prefix: "glossary-seed",
        prompt,
        model,
        cwd: REPO_ROOT,
      });
    if (usedFallback) console.warn("[glossary-seed] used auto after preferred-model retries");
    if (transientFailed) {
      return {
        ok: false,
        dateKey: today,
        status: result?.status || "error",
        reason: authFailed ? "auth" : capacityFailed ? "capacity" : "error",
      };
    }
    const after = listGlossary();
    return {
      ok: true,
      dateKey: today,
      status: result?.status || "finished",
      count: after.entries.length,
      problems: after.problems,
    };
  } finally {
    await releaseLock(handle);
  }
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
  const force = process.argv.includes("--force");
  runGlossarySeed({ force })
    .then((result) => {
      console.log("[glossary-seed]", result);
      if (!result?.ok && !result?.skipped) process.exitCode = 1;
    })
    .catch((err) => {
      console.error("[glossary-seed] failed", err);
      process.exitCode = 1;
    });
}
