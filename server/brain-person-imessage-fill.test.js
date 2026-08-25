import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  batchDumpFilesMonthly,
  buildCompilePrompt,
  buildFillBatchPrompt,
  filesFromMonth,
  handlesFromFields,
  PERSON_IMESSAGE_MODEL_SPEC,
  sinceIso,
} from "./brain-person-imessage-fill.js";

describe("person iMessage fill", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(PERSON_IMESSAGE_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(PERSON_IMESSAGE_MODEL_SPEC.params, [
      { id: "fast", value: "false" },
    ]);
  });

  it("pulls handles from person frontmatter", () => {
    assert.deepEqual(
      handlesFromFields({
        phones: ["+15555550100"],
        emails: ["friend@school.example"],
      }),
      ["+15555550100", "friend@school.example"]
    );
  });

  it("computes a since date from years", () => {
    assert.equal(sinceIso(2, new Date("2026-08-21T07:00:00Z")), "2024-08-21T07:00:00.000Z");
  });

  it("one Composer pass per month by default", () => {
    const batches = batchDumpFilesMonthly([
      { file: "2024-09.txt", month: "2024-09", bytes: 12 },
      { file: "2024-10.txt", month: "2024-10", bytes: 12 },
    ]);
    assert.equal(batches.length, 2);
    assert.equal(batches[0][0].file, "2024-09.txt");
  });

  it("can resume from a start month", () => {
    const files = filesFromMonth(
      [
        { file: "2024-09.txt", month: "2024-09" },
        { file: "2025-06.txt", month: "2025-06" },
      ],
      "2025-01"
    );
    assert.deepEqual(
      files.map((f) => f.month),
      ["2025-06"]
    );
  });

  it("can pin a single dump month", () => {
    const files = filesFromMonth(
      [
        { file: "2025-06.txt", month: "2025-06" },
        { file: "2025-07.txt", month: "2025-07" },
        { file: "2025-08.txt", month: "2025-08" },
      ],
      "2025-06",
      "2025-07"
    );
    assert.deepEqual(
      files.map((f) => f.month),
      ["2025-07"]
    );
  });

  it("points fill prompts at /tmp dumps and forbids transcripts", () => {
    const prompt = buildFillBatchPrompt({
      slug: "alex-rivera",
      outDir: "/tmp/yanylevin-imessage-export/alex-rivera",
      batch: [{ file: "2024-09.txt", bytes: 12, lines: 3 }],
      batchIndex: 1,
      batchCount: 2,
    });
    assert.match(prompt, /brain-person-imessage\/SKILL.md/);
    assert.match(prompt, /\/tmp\/yanylevin-imessage-export\/alex-rivera\/2024-09\.txt/);
    assert.match(prompt, /KEEP every file/);
    assert.match(prompt, /people\/index.md/);
    assert.match(prompt, /Do not create new person folders/);
    assert.match(prompt, /Do not paste texts/);
    assert.match(prompt, /empty dumps/);
    assert.match(prompt, /notes\.md/);
    assert.match(prompt, /calendar order/);
  });

  it("compile pass stays off the dump", () => {
    const prompt = buildCompilePrompt({ slug: "alex-rivera" });
    assert.match(prompt, /Do not open anything under \/tmp/);
    assert.match(prompt, /KEEP every existing file/);
    assert.match(prompt, /FULL arc since Sep 2024/);
    assert.doesNotMatch(prompt, /2024-09\.txt/);
  });
});
