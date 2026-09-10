/**
 * One-shot Composer 2.5 (Fast off): dump EPS Teams chat + channel history
 * (owner@school.example), fill brain from every month, then delete the dump.
 *
 *   node --env-file=.env school-teams-fill.js
 *   node --env-file=.env school-teams-fill.js --skip-export --keep-dump
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { BATCH_BYTES, chunkDumpText, filesFromMonth } from "./school-mail-fill.js";
import { defaultDumpDir, dumpSchoolTeams } from "./school-teams.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN_REL = "education/you@example.com/brain";

export const SCHOOL_TEAMS_FILL_MODEL_SPEC = {
  id: process.env.CURSOR_SCHOOL_TEAMS_FILL_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

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

export function buildSchoolTeamsFillPrompt({ outDir, file, batchIndex, batchCount }) {
  const month = file.month || file.file;
  return [
    "Follow .cursor/skills/brain-school-teams/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md first and follow it exactly.`,
    `This is month ${batchIndex}/${batchCount} (${month}) of a full EPS Teams fill for owner@school.example.`,
    "Read EVERY message in the dump file. Do not skim. Call/join noise is skippable; classmates, teachers, groups, class channels, and school logistics are not.",
    "Dump file (absolute, /tmp, not in the repo):",
    `${outDir}/${file.file}`,
    "",
    `Also read ${BRAIN_REL}/people/index.md (names and aliases only) and ${BRAIN_REL}/people/skipped.md.`,
    "Update existing person/group/org cards when this month states a fact about them.",
    "Create a new person folder only for a real EPS teacher, counselor, classmate, or family-school contact Yan clearly knows. Never card a group-chat title, meeting title, bot, or mailing list.",
    "Group chats (Class of 2028, advisory) go to brain/groups/, not fake people.",
    "Timeline append-only: `- YYYY-MM-DD | fact [school-teams]`. Skip duplicates. Facts, not transcripts.",
    "fromMe=true is Yan. If Yan said it, write it as Yan told them, not as their claim.",
    "Education dates that belong on the Dates panel can be written under education/you@example.com/dates/ per the education-dashboard skill if they are not already there.",
    "Read education/you@example.com/deleted.md. Skip dates that look like a row Yan already deleted (judgement, not exact clocks).",
    "Identity.md only for Yan map facts that are new (current grade). School standing goes to identity-school.md. Dated school events go to the matching org or group timeline. Do not paste message bodies.",
    "Reply with one line: month, cards touched, dates added. Do not quote Teams messages.",
  ].join("\n");
}

export function buildSchoolTeamsCompilePrompt() {
  return [
    "Follow .cursor/skills/brain-school-teams/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md, ${BRAIN_REL}/identity.md, ${BRAIN_REL}/orgs/eastside-prep.md if it exists, and people/index.md.`,
    "Do not open anything under /tmp. The dump is done. Compile only.",
    "KEEP every existing file. Never delete. Merge Standing on cards this fill touched.",
    "Keep identity.md a short map. School standing on identity-school.md. Dated events on org or group timelines.",
    "Bump last_touched on cards you edit.",
    "Reply with which files you tightened. Do not quote Teams messages.",
  ].join("\n");
}

async function runComposer(prefix, prompt, model) {
  const { result, transientFailed, usedFallback } = await promptWithAuthRetry({
    prefix,
    prompt,
    model,
    cwd: REPO_ROOT,
    fallbackModel: null,
  });
  if (usedFallback) console.warn(`[school-teams-fill] ${prefix} used auto fallback`);
  if (transientFailed) {
    return { ok: false, status: result?.status || "error", text: result?.text || "" };
  }
  const text = String(result?.text || result?.output || "").trim();
  if (text) {
    console.log(
      text
        .split("\n")
        .slice(0, 20)
        .map((l) => `  ${l}`)
        .join("\n")
    );
  }
  return { ok: true, status: result?.status || "finished" };
}

async function regenerateGraph() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFileAsync = promisify(execFile);
  await execFileAsync("node", ["server/brain-graph.js"], { cwd: REPO_ROOT });
}

export async function runSchoolTeamsFill(opts = {}) {
  const keepDump = opts.keepDump === true;
  const skipExport = opts.skipExport === true;
  const outDir = String(opts.outDir || "").trim() || defaultDumpDir();
  const since = String(opts.since || "").trim();

  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const model = await resolveModelSelection(apiKey, SCHOOL_TEAMS_FILL_MODEL_SPEC);
  console.log(
    `[school-teams-fill] since=${since || "all"} month=${opts.month || "all"} model=${model.id} fast=false`
  );

  let manifest = skipExport
    ? JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"))
    : null;
  if (!manifest) {
    manifest = await dumpSchoolTeams({ since, outDir });
  }

  console.log(
    `[school-teams-fill] dump ${manifest.messages} msgs, ${manifest.files?.length || 0} months, ${outDir}`
  );

  const files = filesFromMonth(manifest.files || [], opts.startMonth, opts.month);
  if (opts.month && !files.length) {
    throw new Error(
      `no dump file for --month ${opts.month} (export had ${(manifest.files || []).map((f) => f.month).join(",") || "no months"})`
    );
  }

  /** @type {{ month: string, file: string, count: number, bytes: number }[]} */
  const batches = [];
  for (const file of files) {
    const bytes = Number(file.bytes) || 0;
    if (bytes <= BATCH_BYTES) {
      batches.push(file);
      continue;
    }
    const raw = await readFile(join(outDir, file.file), "utf8");
    const chunks = chunkDumpText(raw, BATCH_BYTES);
    for (let i = 0; i < chunks.length; i++) {
      const chunkFile = file.file.replace(/\.txt$/, `-${i + 1}.txt`);
      await writeFile(join(outDir, chunkFile), chunks[i], { mode: 0o600 });
      batches.push({
        month: `${file.month} part ${i + 1}/${chunks.length}`,
        file: chunkFile,
        count: file.count,
        bytes: Buffer.byteLength(chunks[i]),
      });
    }
  }

  let filled = false;
  try {
    for (let i = 0; i < batches.length; i++) {
      const prompt = buildSchoolTeamsFillPrompt({
        outDir,
        file: batches[i],
        batchIndex: i + 1,
        batchCount: batches.length,
      });
      console.log(
        `[school-teams-fill] fill ${i + 1}/${batches.length} ${batches[i].file} n=${batches[i].count}`
      );
      const outcome = await runComposer(`school-teams-fill-${batches[i].file}`, prompt, model);
      if (!outcome.ok) {
        return { ok: false, stage: "fill", month: batches[i].month, dump: outDir };
      }
    }

    console.log("[school-teams-fill] compile pass");
    const compile = await runComposer(
      "school-teams-fill-compile",
      buildSchoolTeamsCompilePrompt(),
      model
    );
    if (!compile.ok) return { ok: false, stage: "compile", dump: outDir };
    filled = true;

    try {
      const stateFile = join(REPO_ROOT, BRAIN_REL, "state.json");
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      state.cursors = state.cursors && typeof state.cursors === "object" ? state.cursors : {};
      state.cursors.teamsSince = new Date().toISOString();
      await writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    } catch (err) {
      console.warn(
        "[school-teams-fill] could not bump teamsSince",
        err instanceof Error ? err.message : err
      );
    }

    await regenerateGraph();
    const git = await gitAddCommitPush({
      paths: [
        `${BRAIN_REL}/people`,
        `${BRAIN_REL}/groups`,
        `${BRAIN_REL}/orgs`,
        `${BRAIN_REL}/identity.md`,
        `${BRAIN_REL}/identity-school.md`,
        `${BRAIN_REL}/identity-accounts.md`,
        `${BRAIN_REL}/identity-logistics.md`,
        `${BRAIN_REL}/patterns.md`,
        `${BRAIN_REL}/threads`,
        `${BRAIN_REL}/state.json`,
        "education/you@example.com/dates",
      ],
      message: "brain: fill from EPS Teams history",
    });
    return {
      ok: true,
      messages: manifest.messages,
      months: manifest.files?.length || 0,
      git,
    };
  } finally {
    if (filled && !keepDump) {
      await rm(outDir, { recursive: true, force: true });
      console.log(`[school-teams-fill] deleted ${outDir}`);
    } else if (!filled) {
      console.log(`[school-teams-fill] dump kept for resume: ${outDir} --skip-export`);
    } else {
      console.log(`[school-teams-fill] keeping dump ${outDir}`);
    }
  }
}

const isMain = (() => {
  const argPath = process.argv[1];
  if (!argPath) return false;
  try {
    return pathToFileURL(argPath).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  process.stdout._handle?.setBlocking?.(true);
  process.stderr._handle?.setBlocking?.(true);
  try {
    const result = await runSchoolTeamsFill({
      since: arg("--since", ""),
      startMonth: arg("--start-month", ""),
      month: arg("--month", ""),
      outDir: arg("--out", ""),
      keepDump: hasFlag("--keep-dump"),
      skipExport: hasFlag("--skip-export"),
    });
    console.log("[school-teams-fill]", result);
    if (!result?.ok) process.exitCode = 1;
  } catch (err) {
    console.error("[school-teams-fill] failed", err);
    process.exitCode = 1;
  }
}
