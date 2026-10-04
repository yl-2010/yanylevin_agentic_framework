/**
 * /study jobs. Grok 4.7 high reads the uploaded class files, or the notes
 * alone, and writes exam.json. Chrome prints two PDFs that share the same
 * question spacing: one blank for work, one with the answers in that space.
 * Same local Cursor agent path as a Grok turn on the site. Jobs run next
 * to other agents. There is no Mac-wide lock.
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { requireAuth } from "./auth.js";
import {
  AUTO_MODEL_SELECTION,
  INTERACTIVE_FALLBACK_DELAYS_MS,
  INTERACTIVE_MODEL_DELAYS_MS,
  createLocalCursorAgent,
  disposeCursorAgent,
  onLocalCursorExecutorEvict,
  recreateLocalCursorAgent,
  reloadCursorApiKeyFromEnv,
  requireCursorApiKey,
  runWithModelFallback,
} from "./cursor-sdk-auth.js";
import { isStudyAccessEmail } from "./identity.js";

const execFileAsync = promisify(execFile);

const SERVER_DIR = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(SERVER_DIR, "..");

export const STUDY_ROOT = join(REPO_ROOT, "data", "study");
export const MAX_FILES = 20;
export const MAX_FILE_BYTES = 12 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
export const MAX_NOTES = 20_000;
export const JOB_ID_RE = /^[a-f0-9]{24}$/;
const MODEL_TIMEOUT_MS = 8 * 60 * 1000;
const EXTRACT_CHARS = 200_000;

const ALLOWED_EXT = new Set([
  ".pdf",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".txt",
  ".md",
  ".doc",
  ".docx",
]);

export const STUDY_MODEL = {
  id: "grok-4.7",
  params: [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "high" },
    { id: "fast", value: "false" },
  ],
};

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** Live study runs. An executor evict nulls the handle, same as a site chat. */
/** @type {Set<{ agent: any }>} */
const liveStudyRuns = new Set();

onLocalCursorExecutorEvict(() => {
  for (const run of liveStudyRuns) run.agent = null;
});

/**
 * @param {string} value
 */
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * @param {string} name
 */
export function safeFileName(name) {
  const base = basename(String(name || "file")).replace(/[^A-Za-z0-9._-]+/g, "_");
  const cleaned = base.replace(/^\.+/, "").slice(0, 120);
  return cleaned || "file";
}

/**
 * @param {string} name
 * @param {Set<string>} used
 */
function uniqueName(name, used) {
  if (!used.has(name)) {
    used.add(name);
    return name;
  }
  const ext = extname(name);
  const stem = basename(name, ext);
  let i = 2;
  let next = `${stem}-${i}${ext}`;
  while (used.has(next)) {
    i += 1;
    next = `${stem}-${i}${ext}`;
  }
  used.add(next);
  return next;
}

/**
 * @param {unknown} data
 * @returns {Buffer|null}
 */
function decodeBase64(data) {
  if (typeof data !== "string" || !data.trim()) return null;
  let raw = data.trim();
  const comma = raw.indexOf(",");
  if (raw.startsWith("data:") && comma !== -1) raw = raw.slice(comma + 1);
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) return null;
  return buf;
}

/**
 * @param {unknown} body
 * @returns {{ error: string } | { notes: string, files: { name: string, buf: Buffer }[] }}
 */
export function normalizeUploads(body) {
  const record = body && typeof body === "object" ? /** @type {Record<string, unknown>} */ (body) : {};
  const notes = String(record.notes || "");
  const list = Array.isArray(record.files) ? record.files : [];
  if (!list.length && !notes.trim()) {
    return { error: "Add files or notes first." };
  }
  if (notes.length > MAX_NOTES) return { error: "Notes are too long." };
  if (list.length > MAX_FILES) return { error: "Up to 20 files." };

  /** @type {{ name: string, buf: Buffer }[]} */
  const files = [];
  const used = new Set();
  let total = 0;
  for (const item of list) {
    const row = item && typeof item === "object" ? /** @type {Record<string, unknown>} */ (item) : {};
    const named = uniqueName(safeFileName(String(row.name || "file")), used);
    const ext = extname(named).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return { error: `${named} is not a kind of file Study can read.` };
    }
    const buf = decodeBase64(row.data);
    if (!buf) return { error: `${named} is empty.` };
    if (buf.length > MAX_FILE_BYTES) return { error: `${named} is too big.` };
    total += buf.length;
    if (total > MAX_TOTAL_BYTES) return { error: "Those files are over 40MB." };
    files.push({ name: named, buf });
  }
  return { notes, files };
}

/**
 * @param {unknown} text
 */
export function parseExamPayload(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    /* keep looking */
  }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]);
    } catch {
      /* keep looking */
    }
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * @param {unknown} raw
 */
export function normalizeExam(raw) {
  if (!raw || typeof raw !== "object") {
    throw examError("The model did not return a test.");
  }
  const record = /** @type {Record<string, unknown>} */ (raw);
  if (typeof record.error === "string" && record.error.trim()) {
    throw examError(record.error.trim().slice(0, 400));
  }
  const questionsIn = Array.isArray(record.questions) ? record.questions : [];
  if (!questionsIn.length) throw examError("The model returned a test with no questions.");
  if (questionsIn.length > 40) throw examError("That test came back with too many questions.");

  const font = record.font === "sans" ? "sans" : "serif";
  const numbering = record.numbering === "1)" || record.numbering === "(1)" ? record.numbering : "1.";
  /** @type {ExamQuestion[]} */
  const questions = [];
  for (let i = 0; i < questionsIn.length; i += 1) {
    const q = questionsIn[i] && typeof questionsIn[i] === "object"
      ? /** @type {Record<string, unknown>} */ (questionsIn[i])
      : {};
    const prompt = String(q.prompt || q.stem || "").trim();
    if (!prompt) throw examError(`Question ${i + 1} has no prompt.`);
    const answer = String(q.answer || "").trim();
    if (!answer) throw examError(`Question ${i + 1} has no answer.`);
    if (prompt.length > 4000 || answer.length > 8000) {
      throw examError(`Question ${i + 1} came back too long.`);
    }
    const points = clamp(Number(q.points) || 1, 1, 50);
    const workLines = clamp(Number(q.workLines) || Math.max(4, points * 2), 3, 36);
    const choices = Array.isArray(q.choices)
      ? q.choices.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 8)
      : [];
    questions.push({
      section: String(q.section || "").trim().slice(0, 120),
      prompt,
      points,
      choices,
      workLines,
      answer,
    });
  }

  return {
    title: String(record.title || "Practice test").trim().slice(0, 140) || "Practice test",
    course: String(record.course || "").trim().slice(0, 80),
    font,
    numbering,
    nameLine: record.nameLine !== false,
    questions,
  };
}

/**
 * @param {string} message
 */
function examError(message) {
  const err = new Error(message);
  err.status = 422;
  return err;
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 */
function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * Ruled lines tall enough for handwriting or for the printed answer.
 * @param {{ workLines: number, answer: string }} question
 */
export function wellLineCount(question) {
  const wrapped = String(question.answer || "")
    .split("\n")
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 88)), 0);
  return Math.max(question.workLines, wrapped);
}

/**
 * @param {number} n
 * @param {string} style
 */
export function formatNumber(n, style) {
  if (style === "1)") return `${n})`;
  if (style === "(1)") return `(${n})`;
  return `${n}.`;
}

/**
 * @param {ReturnType<typeof normalizeExam>} exam
 * @param {"work"|"key"} mode
 */
export function renderExamHtml(exam, mode) {
  let lastSection = "";
  const blocks = exam.questions.map((q, i) => {
    const lines = wellLineCount(q);
    const section =
      q.section && q.section !== lastSection
        ? `<h2>${escapeHtml(q.section)}</h2>`
        : "";
    if (q.section) lastSection = q.section;
    const choices = q.choices.length
      ? `<ol class="choices" type="A">${q.choices.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ol>`
      : "";
    const answer =
      mode === "key" ? `<div class="answer">${escapeHtml(q.answer)}</div>` : "";
    return `${section}<article class="q">
      <div class="q-row">
        <p class="prompt"><span class="n">${escapeHtml(formatNumber(i + 1, exam.numbering))}</span> ${escapeHtml(q.prompt)}</p>
        <p class="pts">${q.points} pts</p>
      </div>
      ${choices}
      <div class="well" style="--lines:${lines}">${answer}</div>
    </article>`;
  });

  const nameLine = exam.nameLine
    ? `<p class="name-line">Name <span class="blank"></span> Date <span class="blank"></span></p>`
    : "";
  const course = exam.course ? `<p class="course">${escapeHtml(exam.course)}</p>` : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(exam.title)}</title>
  <style>
    @page { size: letter; margin: 0.7in; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: #1a1c1e;
      font-family: ${exam.font === "sans"
        ? '"Helvetica Neue", Helvetica, Arial, sans-serif'
        : '"Iowan Old Style", "Palatino Linotype", Palatino, "Times New Roman", serif'};
      font-size: 12pt;
      line-height: 1.35;
    }
    h1 { font-size: 18pt; font-weight: 600; margin: 0 0 0.4rem; letter-spacing: -0.02em; }
    h2 { font-size: 13pt; font-weight: 600; margin: 1.1rem 0 0.35rem; }
    .course { margin: 0 0 0.15rem; font-size: 11pt; }
    .name-line { margin: 0.35rem 0 1rem; }
    .blank { display: inline-block; width: 2.6in; border-bottom: 1px solid #1a1c1e; transform: translateY(-2px); }
    .q { break-inside: avoid; page-break-inside: avoid; margin: 0 0 0.85rem; }
    .q-row { display: flex; gap: 0.75rem; align-items: flex-start; }
    .prompt { margin: 0; flex: 1; white-space: pre-wrap; }
    .n { font-variant-numeric: tabular-nums; }
    .pts { margin: 0; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .choices { margin: 0.35rem 0 0.2rem 1.6rem; padding: 0; }
    .choices li { margin: 0.12rem 0; }
    .well {
      margin-top: 0.35rem;
      min-height: calc(var(--lines) * 1.55rem);
      background-image: repeating-linear-gradient(
        to bottom,
        transparent 0,
        transparent calc(1.55rem - 1px),
        #c5cdd6 0,
        #c5cdd6 1.55rem
      );
    }
    .answer {
      white-space: pre-wrap;
      line-height: 1.55rem;
      padding-top: 0.02rem;
    }
  </style>
</head>
<body class="${exam.font}">
  <header>
    ${course}
    <h1>${escapeHtml(exam.title)}</h1>
    ${nameLine}
  </header>
  ${blocks.join("\n")}
</body>
</html>`;
}

/**
 * @param {string} id
 * @param {string} [root]
 */
function jobDir(id, root = STUDY_ROOT) {
  if (!JOB_ID_RE.test(id)) return "";
  return join(root, id);
}

/**
 * @param {string} dir
 */
async function readMeta(dir) {
  try {
    const raw = await readFile(join(dir, "meta.json"), "utf8");
    const meta = JSON.parse(raw);
    return meta && typeof meta === "object" ? meta : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dir
 * @param {Record<string, unknown>} meta
 */
async function writeMeta(dir, meta) {
  meta.updatedAt = new Date().toISOString();
  await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2));
}

/**
 * @param {string} [root]
 */
export async function recoverStuckJobs(root = STUDY_ROOT) {
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!JOB_ID_RE.test(name)) continue;
    const dir = join(root, name);
    const meta = await readMeta(dir);
    if (!meta) continue;
    if (meta.status === "queued" || meta.status === "running") {
      meta.status = "error";
      meta.error = "The server restarted before this test finished.";
      await writeMeta(dir, meta);
    }
  }
}

/**
 * @param {string} sources
 * @param {{ name: string, buf: Buffer }[]} files
 */
async function writeSources(sources, files) {
  await mkdir(sources, { recursive: true });
  for (const file of files) {
    await writeFile(join(sources, file.name), file.buf);
  }
}

/**
 * @param {string} sources
 */
async function extractSourceText(sources) {
  const names = await readdir(sources);
  for (const name of names) {
    const ext = extname(name).toLowerCase();
    const abs = join(sources, name);
    try {
      if (ext === ".pdf") {
        await execFileAsync("pdftotext", ["-layout", abs, join(sources, `${name}.txt`)], {
          timeout: 30_000,
        }).catch(() => {});
        await execFileAsync(
          "qlmanage",
          ["-t", "-s", "1400", "-o", sources, abs],
          { timeout: 30_000 }
        ).catch(() => {});
      } else if (ext === ".doc" || ext === ".docx") {
        const { stdout } = await execFileAsync("textutil", ["-convert", "txt", "-stdout", abs], {
          timeout: 30_000,
          maxBuffer: EXTRACT_CHARS * 2,
        });
        await writeFile(join(sources, `${name}.txt`), String(stdout || "").slice(0, EXTRACT_CHARS));
      }
    } catch {
      /* the original file is still there for the model */
    }
  }
  const after = await readdir(sources);
  for (const name of after) {
    if (!name.endsWith(".txt")) continue;
    const abs = join(sources, name);
    const text = await readFile(abs, "utf8").catch(() => "");
    if (text.length > EXTRACT_CHARS) {
      await writeFile(abs, text.slice(0, EXTRACT_CHARS));
    }
  }
}

/**
 * Notes with no files are a real job. Put that text where the model reads files.
 * @param {string} sources
 * @param {string} notes
 */
export async function seedNotesFile(sources, notes) {
  const text = String(notes || "").trim();
  if (!text) return false;
  const names = await readdir(sources);
  if (names.length) return false;
  await writeFile(join(sources, "notes.txt"), text);
  return true;
}

/**
 * @param {string} notes
 */
export function modelPrompt(notes) {
  return `You are writing one practice test. Read every file in sources/. The student's notes are below.

Write exam.json in this folder and nothing else. Do not edit, delete, or create any other file.

Notes alone are a complete request. If sources/ only has notes.txt, or the notes are the only material, write the test from that text. A class name, a unit, or a list of skills is enough. Write original practice questions on those skills. Do not stop because the notes have no sample problems, examples, or rules.

If the only material is a Canvas page or an assignment blurb, in the notes or in a text file, ignore the due date, the score, the accommodations link, and the teacher comment. Test the skills that page names.

If the files or notes contain a passage, a data set, slides, or class notes, the questions have to come from that material. Do not invent quotes, page numbers, or facts that are not in it.

Write exactly this and stop only when the notes and files do not say what subject or skills to test:
{"error":"one sentence saying what is missing"}

If two or more files are teacher-made tests and they share a header, numbering, and where the points sit, match that in font, numbering, and nameLine. font is "serif" or "sans". numbering is "1." or "1)" or "(1)". If they do not share a layout, use serif, "1.", and nameLine true. PNG files whose names end in .pdf.png are a picture of that PDF, for layout only.

exam.json shape:
{
  "title": "",
  "course": "",
  "font": "serif",
  "numbering": "1.",
  "nameLine": true,
  "questions": [
    {
      "section": "",
      "prompt": "",
      "points": 4,
      "choices": [],
      "workLines": 6,
      "answer": ""
    }
  ]
}

choices stays empty unless the question is multiple choice. workLines is how many ruled lines a student needs to show work, at least 3. The answer is the full worked answer that will be printed in that same space on the key. Plain text only, no HTML and no markdown.

If the notes name a length, match it. If they do not, write a short concept check that covers each named skill.

Notes:
${notes || "(none)"}
`;
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

/**
 * Match a catalog variant when Cursor lists one, same as a site Grok turn.
 * @param {string} apiKey
 * @param {{ id: string, params?: { id: string, value: string }[] }} spec
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
      if (params.length !== wanted.length) {
        return wanted.every((w) =>
          params.some((p) => p.id === w.id && p.value === w.value)
        );
      }
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
      "[study] model catalog lookup failed; using explicit ModelSelection",
      err instanceof Error ? err.message : err
    );
    return fallback;
  }
}

/**
 * @param {any} run
 */
async function textFromRun(run) {
  /** @type {string[]} */
  const chunks = [];
  if (run && typeof run.stream === "function") {
    for await (const event of run.stream()) {
      if (event?.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block?.type === "text" && typeof block.text === "string") chunks.push(block.text);
        }
      }
    }
  }
  return chunks.join("");
}

/**
 * @param {string} dir
 * @param {string} notes
 */
async function writeExamWithModel(dir, notes) {
  await reloadCursorApiKeyFromEnv();
  const model = await resolveModelSelection(requireCursorApiKey(), STUDY_MODEL);
  const holder = { agent: null };
  liveStudyRuns.add(holder);
  const prompt = modelPrompt(notes);
  try {
    const outcome = await runWithModelFallback({
      prefix: "study",
      preferredModel: model,
      delaysMs: INTERACTIVE_MODEL_DELAYS_MS,
      fallbackModel: AUTO_MODEL_SELECTION,
      fallbackDelaysMs: INTERACTIVE_FALLBACK_DELAYS_MS,
      laterDelaysMs: [],
      onBeforeAttempt: async ({ model: nextModel, recreate }) => {
        if (recreate) {
          const prev = holder.agent;
          holder.agent = null;
          if (prev) await disposeCursorAgent(prev);
          await recreateLocalCursorAgent({
            model: nextModel,
            cwd: dir,
            attach: (agent) => {
              holder.agent = agent;
            },
          });
        } else if (!holder.agent) {
          holder.agent = await createLocalCursorAgent({
            model: nextModel,
            cwd: dir,
          });
        }
      },
      run: async (nextModel) => {
        if (!holder.agent) {
          holder.agent = await createLocalCursorAgent({
            model: nextModel,
            cwd: dir,
          });
        }
        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let timer;
        try {
          const run = await Promise.race([
            holder.agent.send(prompt, { model: nextModel }),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(examError("The model took too long.")),
                MODEL_TIMEOUT_MS
              );
            }),
          ]);
          clearTimeout(timer);
          const spoken = await textFromRun(run);
          const result = typeof run.wait === "function" ? await run.wait() : null;
          const status = String(result?.status || "").toLowerCase();
          if (status === "error") return result;
          const text =
            spoken ||
            (result && typeof result.result === "string" ? result.result : "");
          let raw = null;
          try {
            raw = parseExamPayload(await readFile(join(dir, "exam.json"), "utf8"));
          } catch {
            raw = parseExamPayload(text);
          }
          if (!raw) throw examError("The model did not return a test.");
          const exam = normalizeExam(raw);
          await writeFile(join(dir, "exam.json"), JSON.stringify(exam, null, 2));
          return { status: "finished", result: text, exam };
        } finally {
          clearTimeout(timer);
        }
      },
    });
    const exam = outcome.result?.exam;
    if (!exam) throw examError("The model did not return a test.");
    return exam;
  } finally {
    liveStudyRuns.delete(holder);
    await disposeCursorAgent(holder.agent);
  }
}

/**
 * @param {string} htmlPath
 * @param {string} pdfPath
 * @param {string} profile
 */
async function printPdf(htmlPath, pdfPath, profile) {
  let chrome = "";
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      chrome = candidate;
      break;
    } catch {
      /* next */
    }
  }
  if (!chrome) {
    throw examError("Chrome is not installed on the Mac, so the PDF could not be printed.");
  }
  await mkdir(profile, { recursive: true });
  await execFileAsync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      "--no-pdf-header-footer",
      `--print-to-pdf=${pdfPath}`,
      pathToFileURL(htmlPath).href,
    ],
    { timeout: 90_000 }
  );
  await access(pdfPath);
}

/**
 * @param {string} id
 * @param {string} [root]
 */
export async function runJob(id, root = STUDY_ROOT) {
  const dir = jobDir(id, root);
  const meta = await readMeta(dir);
  if (!meta) return;
  try {
    meta.status = "running";
    await writeMeta(dir, meta);
    const notes = await readFile(join(dir, "notes.txt"), "utf8").catch(() => "");
    const sources = join(dir, "sources");
    await seedNotesFile(sources, notes);
    await extractSourceText(sources);
    const exam = await writeExamWithModel(dir, notes);
    const workHtml = renderExamHtml(exam, "work");
    const keyHtml = renderExamHtml(exam, "key");
    await writeFile(join(dir, "work.html"), workHtml);
    await writeFile(join(dir, "key.html"), keyHtml);
    await printPdf(join(dir, "work.html"), join(dir, "work.pdf"), join(dir, "chrome-work"));
    await printPdf(join(dir, "key.html"), join(dir, "key.pdf"), join(dir, "chrome-key"));
    meta.status = "done";
    meta.title = exam.title;
    meta.error = "";
    await writeMeta(dir, meta);
  } catch (err) {
    meta.status = "error";
    meta.error = err instanceof Error && err.message ? err.message : "The test could not be made.";
    await writeMeta(dir, meta).catch(() => {});
    console.error("[study]", id, meta.error);
  }
}

/**
 * @param {import("express").Express} app
 */
export function attachStudyRoutes(app) {
  recoverStuckJobs().catch((err) => console.error("[study] recover", err));

  function requireStudy(req, res, next) {
    requireAuth(req, res, () => {
      if (!isStudyAccessEmail(req.user?.email)) {
        res.status(403).json({ ok: false, error: "forbidden" });
        return;
      }
      next();
    });
  }

  app.post("/api/study/jobs", requireStudy, async (req, res) => {
    try {
      const parsed = normalizeUploads(req.body);
      if ("error" in parsed) {
        res.status(400).json({ ok: false, error: parsed.error });
        return;
      }
      const id = randomBytes(12).toString("hex");
      const dir = join(STUDY_ROOT, id);
      await mkdir(join(dir, "sources"), { recursive: true });
      await writeSources(join(dir, "sources"), parsed.files);
      await writeFile(join(dir, "notes.txt"), parsed.notes);
      const meta = {
        id,
        email: req.user.email,
        status: "queued",
        error: "",
        title: "",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await writeMeta(dir, meta);
      res.status(202).json({ ok: true, id, status: "queued" });
      void runJob(id);
    } catch (err) {
      console.error("[study] create", err);
      res.status(500).json({ ok: false, error: "Could not start that test." });
    }
  });

  app.get("/api/study/jobs", requireStudy, async (req, res) => {
    try {
      const email = req.user.email;
      let names = [];
      try {
        names = await readdir(STUDY_ROOT);
      } catch {
        names = [];
      }
      /** @type {Record<string, unknown>[]} */
      const jobs = [];
      for (const name of names) {
        if (!JOB_ID_RE.test(name)) continue;
        const meta = await readMeta(join(STUDY_ROOT, name));
        if (!meta || meta.email !== email) continue;
        jobs.push(publicJob(meta));
      }
      jobs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      res.setHeader("Cache-Control", "no-store");
      res.json({ ok: true, jobs: jobs.slice(0, 12) });
    } catch (err) {
      console.error("[study] list", err);
      res.status(500).json({ ok: false, error: "Could not list tests." });
    }
  });

  app.get("/api/study/jobs/:id", requireStudy, async (req, res) => {
    const meta = await ownJob(req, res);
    if (!meta) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, ...publicJob(meta) });
  });

  app.get("/api/study/jobs/:id/:file", requireStudy, async (req, res) => {
    const file = req.params.file === "work.pdf" || req.params.file === "key.pdf" ? req.params.file : "";
    if (!file) {
      res.status(404).json({ ok: false, error: "not found" });
      return;
    }
    const meta = await ownJob(req, res);
    if (!meta) return;
    if (meta.status !== "done") {
      res.status(409).json({ ok: false, error: "That test is not ready." });
      return;
    }
    const abs = join(jobDir(meta.id), file);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${file === "key.pdf" ? "key.pdf" : "work.pdf"}"`);
    res.setHeader("Cache-Control", "no-store");
    res.sendFile(abs, (err) => {
      if (err && !res.headersSent) res.status(404).json({ ok: false, error: "not found" });
    });
  });
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
async function ownJob(req, res) {
  const id = String(req.params.id || "");
  const dir = jobDir(id);
  if (!dir) {
    res.status(404).json({ ok: false, error: "not found" });
    return null;
  }
  const meta = await readMeta(dir);
  if (!meta || meta.email !== req.user.email) {
    res.status(404).json({ ok: false, error: "not found" });
    return null;
  }
  return meta;
}

/**
 * @param {Record<string, unknown>} meta
 */
function publicJob(meta) {
  return {
    id: meta.id,
    status: meta.status,
    error: meta.status === "error" ? meta.error || "The test could not be made." : "",
    title: meta.title || "",
    createdAt: meta.createdAt || "",
  };
}
