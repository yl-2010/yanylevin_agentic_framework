import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCHOOL_MAIL_FILL_MODEL_SPEC,
  buildSchoolMailCompilePrompt,
  buildSchoolMailFillPrompt,
  filesFromMonth,
  chunkDumpText,
} from "./school-mail-fill.js";

describe("school-mail fill model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(SCHOOL_MAIL_FILL_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(SCHOOL_MAIL_FILL_MODEL_SPEC.params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("school-mail fill prompts", () => {
  it("points at the fill skill and one dump month", () => {
    const prompt = buildSchoolMailFillPrompt({
      outDir: "/tmp/yanylevin-school-mail-export",
      file: { month: "2026-08", file: "2026-08.txt", count: 12 },
      batchIndex: 3,
      batchCount: 10,
    });
    assert.match(prompt, /brain-school-mail/);
    assert.match(prompt, /owner@school.example/);
    assert.match(prompt, /2026-08\.txt/);
    assert.match(prompt, /\[school-mail\]/);
    assert.match(prompt, /Create a new person folder only for/);
    assert.match(prompt, /Never card Scoir/);
    assert.match(prompt, /Other people's mail goes on their card/);
    assert.match(prompt, /deleted\.md/);
    assert.match(prompt, /judgement, not exact clocks/);
  });

  it("compile pass does not reopen /tmp", () => {
    const prompt = buildSchoolMailCompilePrompt();
    assert.match(prompt, /Do not open anything under \/tmp/);
    assert.match(prompt, /identity\.md/);
  });

  it("filters dump files by month", () => {
    const files = [
      { month: "2024-06", file: "2024-06.txt" },
      { month: "2026-08", file: "2026-08.txt" },
    ];
    assert.equal(filesFromMonth(files, "", "2026-08").length, 1);
    assert.equal(filesFromMonth(files, "2026-01", "").length, 1);
  });

  it("splits a fat month on message boundaries", () => {
    const a = "2024-07-01T00:00:00Z | from=a@x | to=y | one\nhello\n\n";
    const b = "2024-07-02T00:00:00Z | from=b@x | to=y | two\n" + "x".repeat(500);
    const chunks = chunkDumpText(a + b, 80);
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0], /2024-07-01T/);
  });
});
