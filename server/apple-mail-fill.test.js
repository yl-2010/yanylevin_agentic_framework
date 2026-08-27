import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  APPLE_MAIL_FILL_MODEL_SPEC,
  buildAppleMailCompilePrompt,
  buildAppleMailFillPrompt,
  recordAppleMailFillComplete,
} from "./apple-mail-fill.js";
import { filesFromMonth, chunkDumpText } from "./school-mail-fill.js";

describe("apple-mail fill model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(APPLE_MAIL_FILL_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(APPLE_MAIL_FILL_MODEL_SPEC.params, [{ id: "fast", value: "false" }]);
  });
});

describe("apple-mail fill prompts", () => {
  it("points at the fill skill and one dump month", () => {
    const prompt = buildAppleMailFillPrompt({
      outDir: "/tmp/yanylevin-apple-mail-export",
      file: { month: "2024-07", file: "2024-07.txt", count: 40 },
      batchIndex: 3,
      batchCount: 10,
    });
    assert.match(prompt, /brain-apple-mail/);
    assert.match(prompt, /you@example.com/);
    assert.match(prompt, /you@example.com/);
    assert.match(prompt, /you@icloud.com/);
    assert.match(prompt, /2024-07\.txt/);
    assert.match(prompt, /\[mail\]/);
    assert.doesNotMatch(prompt, /\[school-mail\]/);
    assert.match(prompt, /has the words/);
    assert.match(prompt, /empty export/);
    assert.match(prompt, /Create a new person folder only for/);
    assert.match(prompt, /skipped\.md/);
    assert.match(prompt, /owner@school.example is out of scope/);
    assert.match(prompt, /Other people's mail goes on their card/);
  });

  it("compile pass does not reopen /tmp", () => {
    const prompt = buildAppleMailCompilePrompt();
    assert.match(prompt, /Do not open anything under \/tmp/);
    assert.match(prompt, /identity\.md/);
    assert.match(prompt, /Tighten identity\.md to the map/);
  });

  it("filters dump files by month", () => {
    const files = [
      { month: "2018-01", file: "2018-01.txt" },
      { month: "2024-07", file: "2024-07.txt" },
    ];
    assert.equal(filesFromMonth(files, "", "2024-07").length, 1);
    assert.equal(filesFromMonth(files, "2020-01", "").length, 1);
  });

  it("stamps appleMailFill.lastAt outside nightly cursors", () => {
    const next = recordAppleMailFillComplete(
      {
        cursors: {
          mailSince: "2026-08-27T09:30:08.531Z",
          appleMailSince: "2026-08-25T03:24:00.683Z",
        },
        notes: {
          mail: "mail-people ok",
          appleMail: "Left appleMailSince so the next run retries.",
        },
      },
      "2026-08-27T17:00:00.000Z"
    );
    assert.equal(next.appleMailFill.lastAt, "2026-08-27T17:00:00.000Z");
    assert.equal(next.cursors.mailSince, "2026-08-27T09:30:08.531Z");
    assert.equal(next.cursors.appleMailSince, undefined);
    assert.equal(next.notes.appleMail, undefined);
    assert.equal(next.notes.mail, "mail-people ok");
  });

  it("splits a fat month on message boundaries", () => {
    const a = "2024-07-01T00:00:00Z | account=Google | folder=INBOX | from=a@x | to=y | one\nhello\n\n";
    const b = "2024-07-02T00:00:00Z | account=Google | folder=INBOX | from=b@x | to=y | two\n" + "x".repeat(500);
    const chunks = chunkDumpText(a + b, 80);
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0], /2024-07-01T/);
  });
});
