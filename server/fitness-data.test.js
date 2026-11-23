import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntriesForAppend } from "./fitness-data.js";

describe("readEntriesForAppend", () => {
  it("treats a missing file as a new log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fit-entries-"));
    try {
      const entries = await readEntriesForAppend(join(dir, "entries.json"));
      assert.deepEqual(entries, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns the sets already in the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fit-entries-"));
    const path = join(dir, "entries.json");
    try {
      await writeFile(
        path,
        JSON.stringify({
          entries: [
            { id: "a", weight: 115, at: "2026-10-27T23:35:25.995Z" },
            { id: "b", weight: 110, at: "2026-10-20T22:57:06.736Z" },
          ],
        })
      );
      const entries = await readEntriesForAppend(path);
      assert.deepEqual(
        entries.map((e) => e.weight),
        [110, 115]
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a broken file instead of reading it as empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fit-entries-"));
    const path = join(dir, "entries.json");
    try {
      const junk = "this is not json ".repeat(20);
      await writeFile(path, junk);
      await assert.rejects(readEntriesForAppend(path), /not valid JSON/);
      assert.equal(await readFile(path, "utf8"), junk);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
