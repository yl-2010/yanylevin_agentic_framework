import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SCHOOL_TEAMS_FILL_MODEL_SPEC,
  buildSchoolTeamsCompilePrompt,
  buildSchoolTeamsFillPrompt,
} from "./school-teams-fill.js";
import { filesFromMonth, chunkDumpText } from "./school-mail-fill.js";

describe("school-teams fill model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(SCHOOL_TEAMS_FILL_MODEL_SPEC.id, "composer-2.5");
    assert.deepEqual(SCHOOL_TEAMS_FILL_MODEL_SPEC.params, [
      { id: "fast", value: "false" },
    ]);
  });
});

describe("school-teams fill prompts", () => {
  it("points at the fill skill and one dump month", () => {
    const prompt = buildSchoolTeamsFillPrompt({
      outDir: "/tmp/yanylevin-school-teams-export",
      file: { month: "2026-05", file: "2026-05.txt", count: 40 },
      batchIndex: 3,
      batchCount: 10,
    });
    assert.match(prompt, /brain-school-teams/);
    assert.match(prompt, /owner@school.example/);
    assert.match(prompt, /2026-05\.txt/);
    assert.match(prompt, /\[school-teams\]/);
    assert.match(prompt, /fromMe=true is Yan/);
    assert.match(prompt, /Create a new person folder only for/);
    assert.match(prompt, /Never card a group-chat title/);
    assert.match(prompt, /brain\/groups\//);
    assert.match(prompt, /deleted\.md/);
    assert.match(prompt, /judgement, not exact clocks/);
  });

  it("compile pass does not reopen /tmp", () => {
    const prompt = buildSchoolTeamsCompilePrompt();
    assert.match(prompt, /Do not open anything under \/tmp/);
    assert.match(prompt, /identity\.md/);
  });

  it("filters dump files by month", () => {
    const files = [
      { month: "2024-09", file: "2024-09.txt" },
      { month: "2026-05", file: "2026-05.txt" },
    ];
    assert.equal(filesFromMonth(files, "", "2026-05").length, 1);
    assert.equal(filesFromMonth(files, "2026-01", "").length, 1);
  });

  it("splits a fat month on message boundaries", () => {
    const a = "2024-09-01T00:00:00Z | kind=chat | chat=Alex | type=oneOnOne | from=P | fromMe=false\nhi\n\n";
    const b =
      "2024-09-02T00:00:00Z | kind=chat | chat=Alex | type=oneOnOne | from=Yan | fromMe=true\n" +
      "x".repeat(500);
    const chunks = chunkDumpText(a + b, 80);
    assert.ok(chunks.length >= 2);
    assert.match(chunks[0], /2024-09-01T/);
  });
});
