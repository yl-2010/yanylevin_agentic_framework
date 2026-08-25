/**
 * One-shot Composer 2.5 (Fast off): dump a person's iMessage history to /tmp,
 * fill their brain folder from every message, then delete the dump.
 * Not scheduled. Do not run unless Yan asks.
 *
 *   node --env-file=.env brain-person-imessage-fill.js --slug alex-rivera
 *   node --env-file=.env brain-person-imessage-fill.js --slug alex-rivera --years 2
 */

import { readFile, rm } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BRAIN_ROOT, parseFrontmatter } from "./brain-lib.js";
import {
  promptWithAuthRetry,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
} from "./cursor-sdk-auth.js";
import { gitAddCommitPush } from "./git-publish.js";
import { resolveExportDir } from "./imessage-read.js";
import { LOCAL_SOCK } from "./local-ipc.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BRAIN_REL = "education/you@example.com/brain";
const BATCH_BYTES = 400_000;
const MET_SINCE = "2024-09-01T00:00:00Z";

export const PERSON_IMESSAGE_MODEL_SPEC = {
  id: process.env.CURSOR_PERSON_IMESSAGE_MODEL || "composer-2.5",
  params: [{ id: "fast", value: "false" }],
};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

export function personDirRel(slug) {
  return `${BRAIN_REL}/people/${slug}`;
}

export function handlesFromFields(fields) {
  const emails = Array.isArray(fields?.emails) ? fields.emails : [];
  const phones = Array.isArray(fields?.phones) ? fields.phones : [];
  return [...phones, ...emails].map((v) => String(v || "").trim()).filter(Boolean);
}

export function sinceIso(years, now = new Date()) {
  const n = Math.max(1, Number(years) || 2);
  const d = new Date(now.getTime());
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString();
}

export function batchDumpFiles(files, maxBytes = BATCH_BYTES) {
  const list = Array.isArray(files) ? files : [];
  /** @type {{ month: string, file: string, lines: number, bytes: number }[][]} */
  const batches = [];
  let cur = [];
  let size = 0;
  for (const file of list) {
    const bytes = Number(file.bytes) || 0;
    if (cur.length && size + bytes > maxBytes) {
      batches.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(file);
    size += bytes;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

/** One Composer pass per month so older months cannot get skimmed. */
export function batchDumpFilesMonthly(files) {
  return (Array.isArray(files) ? files : []).map((file) => [file]);
}

export function filesFromMonth(files, startMonth, onlyMonth) {
  const list = Array.isArray(files) ? files : [];
  const only = String(onlyMonth || "").trim();
  if (only) {
    return list.filter((f) => {
      const month = String(f.month || "").slice(0, 7);
      const file = String(f.file || "");
      return month === only || file === `${only}.txt`;
    });
  }
  const start = String(startMonth || "").trim();
  if (!start) return list;
  return list.filter((f) => String(f.month || f.file || "") >= start);
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

export function buildFillBatchPrompt({ slug, outDir, batch, batchIndex, batchCount }) {
  const files = batch.map((f) => `${outDir}/${f.file}`).join("\n");
  const person = personDirRel(slug);
  const month = batch[0]?.month || batch[0]?.file || "this month";
  return [
    "Follow .cursor/skills/brain-person-imessage/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md first and follow it exactly.`,
    `Primary person: ${person}/. KEEP every file that already exists. Never delete or empty a brain file.`,
    "Merge into Standing. Timeline is append-only; skip a fact if that date+claim is already there.",
    "",
    `This is month ${batchIndex}/${batchCount} (${month}) of a full-history iMessage fill for ${slug}.`,
    "They met in September 2024. This month is not optional. Read EVERY line. Do not skim.",
    "A one-line 'active in group chat' stub is a failure for this month. Extract actual facts:",
    "who they were to each other, hangouts, school, family, jokes that became standing, other people named.",
    `Write or replace the matching ## Month YYYY section in ${person}/notes.md for ${month}.`,
    "Keep every other month section. Put this month in calendar order among them.",
    "Earlier fills had empty dumps (bodies were in attributedBody, unread). Ignore claims of",
    "'empty text in export' or 'no export-recorded text'. Replace those. This dump has the words.",
    "Dump files (absolute, /tmp, not in the repo):",
    files,
    "",
    `Also read ${BRAIN_REL}/people/index.md (names and aliases only).`,
    "If this month states a fact about someone already in the index, Read their card and update it",
    "(timeline append, Standing/typed files if the fact is standing). Same for groups/ and orgs/",
    "when the dump is clearly about that entity. Do not create new person folders. If several",
    "index rows share a first name, skip rather than guess.",
    "",
    "Do not paste texts or transcripts into any brain file. Facts only.",
    "Do not invent. Keep uncertainty labels. Never create empty files.",
    "Reply with one line: month, facts added for primary slug, other slugs touched. Do not quote messages.",
  ].join("\n");
}

export function buildCompilePrompt({ slug }) {
  const person = personDirRel(slug);
  return [
    "Follow .cursor/skills/brain-person-imessage/SKILL.md.",
    "Yan only (you@example.com). Local only. Never spawn a Cursor cloud agent.",
    "Do not run git. Do not run scripts. Do not edit generated files",
    `(${BRAIN_REL}/people/index.md, ${BRAIN_REL}/people/graph.md, ${BRAIN_REL}/education/**).`,
    "",
    `Read ${BRAIN_REL}/schema.md, then every file in ${person}/.`,
    "Do not open anything under /tmp. The dump is done. Compile only.",
    "KEEP every existing file. Never delete. Do not drop 2024-2025 facts to make room for 2026.",
    "Rewrite the executive summary and Standing as a briefing of the FULL arc since Sep 2024,",
    "not only the last few months. Timeline stays append-only (no edits, no deletes, no reorder).",
    "Typed files (relationship, beliefs, threads, notes) should cover the whole friendship, not just summer 2026.",
    "Bump last_touched.",
    "Reply with which files you tightened. Do not quote messages.",
  ].join("\n");
}

async function ipcJson(method, path, body) {
  const payload = body == null ? "" : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: LOCAL_SOCK,
        path,
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          try {
            resolve({ status: res.statusCode || 0, body: JSON.parse(raw) });
          } catch {
            reject(new Error(`ipc ${path} non-json (${res.statusCode}): ${raw.slice(0, 120)}`));
          }
        });
      }
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function runComposer(prefix, prompt, model) {
  const { result, transientFailed, usedFallback } = await promptWithAuthRetry({
    prefix,
    prompt,
    model,
    cwd: REPO_ROOT,
    fallbackModel: null,
  });
  if (usedFallback) console.warn(`[person-imessage] ${prefix} used auto fallback`);
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

export async function runPersonImessageFill(opts = {}) {
  const slug = String(opts.slug || "").trim();
  if (!slug) throw new Error("slug required");
  const years = Math.max(1, Number(opts.years) || 2);
  const keepDump = opts.keepDump === true;
  const skipExport = opts.skipExport === true;
  const sharedChats = opts.sharedChats !== false;
  const monthly = opts.monthly !== false;
  const personFile = join(BRAIN_ROOT, "people", slug, "person.md");
  const raw = await readFile(personFile, "utf8");
  const { fields } = parseFrontmatter(raw);
  const handles = handlesFromFields(fields);
  if (!handles.length) throw new Error(`${slug}: no phones or emails in person.md`);
  const since = opts.since || MET_SINCE || sinceIso(years);
  const outDir = resolveExportDir(slug);

  await reloadCursorApiKeyFromEnv();
  const apiKey = requireCursorApiKey();
  const model = await resolveModelSelection(apiKey, PERSON_IMESSAGE_MODEL_SPEC);
  console.log(
    `[person-imessage] slug=${slug} since=${since} month=${opts.month || "all"} sharedChats=${sharedChats} monthly=${monthly} model=${model.id} fast=false`
  );
  console.log(`[person-imessage] handles=${handles.length} (not printing them)`);

  let manifest = skipExport
    ? JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"))
    : null;
  if (!manifest) {
    const { status, body } = await ipcJson("POST", "/imessage/export", {
      slug,
      handles,
      since,
      sharedChats,
    });
    if (status !== 200 || !body?.ok) {
      throw new Error(
        `export failed (${status}): ${body?.error || JSON.stringify(body).slice(0, 200)}`
      );
    }
    manifest = body;
  }

  console.log(
    `[person-imessage] dump ${manifest.messages} msgs, ${manifest.files?.length || 0} months, ${manifest.pages} pages, ${outDir}`
  );

  const files = filesFromMonth(manifest.files || [], opts.startMonth, opts.month);
  if (opts.month && !files.length) {
    throw new Error(
      `${slug}: no dump file for --month ${opts.month} (export had ${(manifest.files || []).map((f) => f.month).join(",") || "no months"})`
    );
  }
  const batches = monthly ? batchDumpFilesMonthly(files) : batchDumpFiles(files);
  let filled = false;
  try {
    for (let i = 0; i < batches.length; i++) {
      const prompt = buildFillBatchPrompt({
        slug,
        outDir,
        batch: batches[i],
        batchIndex: i + 1,
        batchCount: batches.length,
      });
      console.log(
        `[person-imessage] fill batch ${i + 1}/${batches.length} files=${batches[i].map((f) => f.file).join(",")}`
      );
      const outcome = await runComposer(`person-imessage-${slug}-${i + 1}`, prompt, model);
      if (!outcome.ok) {
        return { ok: false, stage: "fill", batch: i + 1, dump: outDir };
      }
    }

    console.log("[person-imessage] compile pass");
    const compile = await runComposer(
      `person-imessage-${slug}-compile`,
      buildCompilePrompt({ slug }),
      model
    );
    if (!compile.ok) return { ok: false, stage: "compile", dump: outDir };
    filled = true;

    await regenerateGraph();
    const git = await gitAddCommitPush({
      paths: [
        `${BRAIN_REL}/people`,
        `${BRAIN_REL}/groups`,
        `${BRAIN_REL}/orgs`,
      ],
      message: `brain: fill ${slug} from full iMessage history`,
    });
    return { ok: true, messages: manifest.messages, months: manifest.files?.length || 0, git };
  } finally {
    if (filled && !keepDump) {
      await rm(outDir, { recursive: true, force: true });
      console.log(`[person-imessage] deleted ${outDir}`);
    } else if (!filled) {
      console.log(`[person-imessage] dump kept for resume: ${outDir} --skip-export`);
    } else {
      console.log(`[person-imessage] keeping dump ${outDir}`);
    }
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
  const slug = arg("--slug", "");
  if (!slug) {
    console.log(
      "usage: node brain-person-imessage-fill.js --slug alex-rivera [--since 2024-09-01] [--start-month 2024-09] [--month 2025-07] [--keep-dump] [--skip-export]"
    );
    console.log("Do not run until Yan says so.");
    process.exit(0);
  }
  try {
    const result = await runPersonImessageFill({
      slug,
      since: arg("--since", MET_SINCE),
      years: arg("--years", "2"),
      startMonth: arg("--start-month", ""),
      month: arg("--month", ""),
      keepDump: hasFlag("--keep-dump"),
      skipExport: hasFlag("--skip-export"),
      sharedChats: !hasFlag("--no-shared-chats"),
      monthly: !hasFlag("--no-monthly"),
    });
    console.log("[person-imessage]", result);
    if (!result?.ok) process.exitCode = 1;
  } catch (err) {
    console.error("[person-imessage] failed", err);
    process.exitCode = 1;
  }
}
