/**
 * One-shot Composer 2.5 (Fast off): dump Mail.app (Exchange, Google, iCloud)
 * full history, fill brain from every month, then delete the dump.
 *
 *   node --env-file=.env apple-mail-fill.js
 *   node --env-file=.env apple-mail-fill.js --skip-export --start-month 2024-01 --keep-dump
 */

import { readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defaultDumpDir, dumpAppleMail } from "./apple-mail.js";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { BATCH_BYTES, chunkDumpText, filesFromMonth } from "./school-mail-fill.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN_REL = "education/you@example.com/brain";

export const APPLE_MAIL_FILL_MODEL_SPEC = {
  id: process.env.CURSOR_APPLE_MAIL_FILL_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

/**
 * One-shot fill finished. Stamp appleMailFill.lastAt (not a nightly cursor).
 * Drop leftover appleMailSince / notes.appleMail so overnight jobs do not retry.
 *
 * @param {Record<string, unknown>} state
 * @param {string} [at]
 */
export function recordAppleMailFillComplete(state, at = new Date().toISOString()) {
  const next = state && typeof state === "object" ? { ...state } : {};
  const cursors =
    next.cursors && typeof next.cursors === "object"
      ? { .../** @type {Record<string, unknown>} */ (next.cursors) }
      : {};
  delete cursors.appleMailSince;
  next.cursors = cursors;
  next.appleMailFill = { lastAt: String(at) };
  if (next.notes && typeof next.notes === "object") {
    const notes = { .../** @type {Record<string, unknown>} */ (next.notes) };
    delete notes.appleMail;
    next.notes = notes;
  }
  return next;
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

export function buildAppleMailFillPrompt({ outDir, file, batchIndex, batchCount }) {
  const month = file.month || file.file;
  return [
    "Follow .cursor/skills/brain-apple-mail/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md first and follow it exactly.`,
    `This is month ${batchIndex}/${batchCount} (${month}) of a full Mail.app fill.`,
    "Accounts: Exchange you@example.com, Google you@example.com, iCloud you@icloud.com.",
    "School Outlook owner@school.example is out of scope (already filled).",
    "This dump was parsed from on-disk .emlx MIME. It has the words. Ignore any",
    '"empty export" / "blank body" / "AppleScript content empty" claims.',
    "Read EVERY message in the dump file. Do not skim. Newsletters and noreply are skippable;",
    "people Yan knows, family, friends, PathIvy, work, and standing logistics are not.",
    "Dump file (absolute, /tmp, not in the repo):",
    `${outDir}/${file.file}`,
    "",
    `Also read ${BRAIN_REL}/people/index.md (names and aliases only) and ${BRAIN_REL}/people/skipped.md.`,
    "Update existing person/group/org cards when this month states a fact about them.",
    "Create a new person folder only for a real person Yan clearly knows. Newsletters, noreply,",
    "Scoir, GitHub, stores, and mailing lists go to skipped.md. Never card them.",
    "Timeline append-only: `- YYYY-MM-DD | fact [mail]`. Skip duplicates. Facts, not transcripts.",
    "Identity.md only for Yan map facts (current grade, home pointer). A new email on identity-accounts.md means Yan's address. Other people's mail goes on their card. School/accounts/logistics siblings for those domains. Dated events go to the matching org timeline. Never Libby holds, sign-in alerts, iCloud-full, or Duolingo day-counts.",
    "Do not paste email bodies.",
    "Reply with one line: month, cards touched, dates added. Do not quote emails.",
  ].join("\n");
}

export function buildAppleMailCompilePrompt() {
  return [
    "Follow .cursor/skills/brain-apple-mail/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md, ${BRAIN_REL}/identity.md, and people/index.md.`,
    "Do not open anything under /tmp. The dump is done. Compile only.",
    "KEEP every existing file. Never delete. Merge Standing on cards this fill touched.",
    "Tighten identity.md to the map. Put school/accounts/logistics on the matching identity-*.md sibling.",
    "Never restore Libby holds, sign-in alerts, iCloud-full, or Duolingo day-counts into identity pages.",
    "Bump last_touched on cards you edit.",
    "Reply with which files you tightened. Do not quote emails.",
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
  if (usedFallback) console.warn(`[apple-mail-fill] ${prefix} used auto fallback`);
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

export async function runAppleMailFill(opts = {}) {
  const keepDump = opts.keepDump === true;
  const skipExport = opts.skipExport === true;
  const outDir = String(opts.outDir || "").trim() || defaultDumpDir();
  const since = String(opts.since || "").trim();

  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const model = await resolveModelSelection(apiKey, APPLE_MAIL_FILL_MODEL_SPEC);
  console.log(
    `[apple-mail-fill] month=${opts.month || "all"} model=${model.id} fast=false`
  );

  let manifest = skipExport
    ? JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"))
    : null;
  if (!manifest) {
    manifest = await dumpAppleMail({ outDir, since });
  }

  console.log(
    `[apple-mail-fill] dump ${manifest.messages} msgs, ${manifest.withBody} with body, empty=${manifest.emptyBody}, ${manifest.files?.length || 0} months, ${outDir}`
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
      const prompt = buildAppleMailFillPrompt({
        outDir,
        file: batches[i],
        batchIndex: i + 1,
        batchCount: batches.length,
      });
      console.log(
        `[apple-mail-fill] fill ${i + 1}/${batches.length} ${batches[i].file} n=${batches[i].count}`
      );
      const outcome = await runComposer(`apple-mail-fill-${batches[i].file}`, prompt, model);
      if (!outcome.ok) {
        return { ok: false, stage: "fill", month: batches[i].month, dump: outDir };
      }
    }

    console.log("[apple-mail-fill] compile pass");
    const compile = await runComposer(
      "apple-mail-fill-compile",
      buildAppleMailCompilePrompt(),
      model
    );
    if (!compile.ok) return { ok: false, stage: "compile", dump: outDir };
    filled = true;

    try {
      const stateFile = join(REPO_ROOT, BRAIN_REL, "state.json");
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      const next = recordAppleMailFillComplete(state);
      await writeFile(stateFile, `${JSON.stringify(next, null, 2)}\n`);
    } catch (err) {
      console.warn(
        "[apple-mail-fill] could not stamp appleMailFill.lastAt",
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
      message: "brain: fill from Apple Mail history",
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
      console.log(`[apple-mail-fill] deleted ${outDir}`);
    } else if (!filled) {
      console.log(`[apple-mail-fill] dump kept for resume: ${outDir} --skip-export`);
    } else {
      console.log(`[apple-mail-fill] keeping dump ${outDir}`);
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
    const result = await runAppleMailFill({
      since: arg("--since", ""),
      startMonth: arg("--start-month", ""),
      month: arg("--month", ""),
      outDir: arg("--out", ""),
      keepDump: hasFlag("--keep-dump"),
      skipExport: hasFlag("--skip-export"),
    });
    console.log("[apple-mail-fill]", result);
    if (!result?.ok) process.exitCode = 1;
  } catch (err) {
    console.error("[apple-mail-fill] failed", err);
    process.exitCode = 1;
  }
}
