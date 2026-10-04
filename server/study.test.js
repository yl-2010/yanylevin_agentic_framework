import { createRequire } from "node:module";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isJypeAccessEmail, isStudyAccessEmail } from "./identity.js";
import {
  STUDY_MODEL,
  formatNumber,
  normalizeExam,
  normalizeUploads,
  parseExamPayload,
  renderExamHtml,
  wellLineCount,
} from "./study.js";
import { sanitizeText } from "../scripts/oss-lib.mjs";

const require = createRequire(import.meta.url);
const { accessForEmail, sanitizeReturnPath } = require("../api/_auth.js");

describe("study access", () => {
  it("keeps a full member on full access and lets them open study", () => {
    assert.equal(accessForEmail("you@example.com"), "full");
    assert.equal(isJypeAccessEmail("you@example.com"), true);
    assert.equal(isStudyAccessEmail("you@example.com"), true);
  });

  it("rejects a stranger", () => {
    assert.equal(accessForEmail("stranger@example.net"), "denied");
    assert.equal(isStudyAccessEmail("stranger@example.net"), false);
    assert.equal(isJypeAccessEmail("stranger@example.net"), false);
  });

  it("sends /study back to the study page", () => {
    assert.equal(sanitizeReturnPath("/study"), "/study/");
    assert.equal(sanitizeReturnPath("/study/"), "/study/");
    assert.equal(sanitizeReturnPath("/elsewhere"), "/education/");
  });

});

describe("study model", () => {
  it("uses grok 4.7 high with fast off", () => {
    assert.equal(STUDY_MODEL.id, "grok-4.7");
    const params = Object.fromEntries(STUDY_MODEL.params.map((p) => [p.id, p.value]));
    assert.equal(params.context, "256k");
    assert.equal(params.reasoning_effort, "high");
    assert.equal(params.fast, "false");
  });
});

describe("study uploads", () => {
  it("rejects an empty request, a bad type, and too many files", () => {
    assert.equal(normalizeUploads({ notes: "  ", files: [] }).error, "Add files or notes first.");
    const bad = normalizeUploads({
      notes: "",
      files: [{ name: "virus.exe", data: Buffer.from("nope").toString("base64") }],
    });
    assert.match(bad.error, /not a kind of file/);
    const many = normalizeUploads({
      notes: "",
      files: Array.from({ length: 21 }, (_, i) => ({
        name: `n${i}.txt`,
        data: Buffer.from("a").toString("base64"),
      })),
    });
    assert.equal(many.error, "Up to 20 files.");
  });

  it("keeps notes with no files", () => {
    const parsed = normalizeUploads({ notes: "Chapter 3, ten questions.", files: [] });
    assert.equal(parsed.notes, "Chapter 3, ten questions.");
    assert.equal(parsed.files.length, 0);
  });
});

describe("study exam html", () => {
  const exam = normalizeExam({
    title: "Limits <quiz>",
    course: "Calc",
    font: "serif",
    numbering: "1.",
    nameLine: true,
    questions: [
      {
        prompt: "What is <script>?",
        points: 4,
        choices: ["Two", "Four"],
        workLines: 3,
        answer: "Four, because the table says so.",
      },
      {
        section: "Graphs",
        prompt: "Sketch the derivative.",
        points: 8,
        workLines: 4,
        answer: "A".repeat(88 * 4),
      },
    ],
  });

  it("gives both copies the same questions and the same well height", () => {
    const work = renderExamHtml(exam, "work");
    const key = renderExamHtml(exam, "key");
    assert.deepEqual(lineCounts(work), lineCounts(key));
    assert.equal(lineCounts(work)[0], String(wellLineCount(exam.questions[0])));
    assert.ok(Number(lineCounts(work)[1]) >= 4);
    assert.match(work, /What is &lt;script&gt;\?/);
    assert.match(key, /What is &lt;script&gt;\?/);
    assert.match(work, /Sketch the derivative\./);
    assert.ok(work.indexOf("What is") < work.indexOf("Sketch the derivative"));
    assert.ok(key.indexOf("What is") < key.indexOf("Sketch the derivative"));
  });

  it("leaves the work copy blank and puts the answer in the key well", () => {
    const work = renderExamHtml(exam, "work");
    const key = renderExamHtml(exam, "key");
    assert.equal(work.includes('class="answer"'), false);
    assert.equal(key.includes('class="answer"'), true);
    assert.doesNotMatch(work, /because the table says so/);
    assert.match(key, /because the table says so/);
    assert.match(work, /Limits &lt;quiz&gt;/);
    assert.match(work, /Name /);
    assert.match(key, /Graphs/);
  });

  it("can drop the name line and switch to sans", () => {
    const plain = normalizeExam({
      title: "Quiz",
      font: "sans",
      numbering: "(1)",
      nameLine: false,
      questions: [{ prompt: "One", points: 1, workLines: 3, answer: "1" }],
    });
    const html = renderExamHtml(plain, "work");
    assert.equal(html.includes("Name "), false);
    assert.match(html, /Helvetica Neue/);
    assert.equal(formatNumber(1, plain.numbering), "(1)");
    assert.match(html, /\(1\)/);
  });

  it("refuses a question with no answer", () => {
    assert.throws(
      () => normalizeExam({ questions: [{ prompt: "Why?", answer: "  " }] }),
      /no answer/
    );
  });

  it("reads a fenced exam payload", () => {
    const parsed = parseExamPayload('```json\n{"title":"T","questions":[]}\n```');
    assert.equal(parsed.title, "T");
  });
});

describe("study public export", () => {
  it("drops the parent address out of the auth allowlist", async () => {
    const src = await readFile(new URL("../api/_auth.js", import.meta.url), "utf8");
    const out = sanitizeText(src, "api/_auth.js");
    assert.equal(out.includes("parent@example.com"), false);
    assert.match(out, /const STUDY_ONLY_EMAILS = new Set\(\)/);
    assert.match(out, /const JYPE_ACCESS_EMAILS = new Set\(\)/);
    assert.match(out, /function accessForEmail/);
  });
});

function lineCounts(html) {
  return [...html.matchAll(/--lines:(\d+)/g)].map((m) => m[1]);
}
