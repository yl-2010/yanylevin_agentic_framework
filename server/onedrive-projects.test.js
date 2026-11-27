import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  backupShouldCopy,
  listTopLevelProjects,
  normalizeTier,
  stableProjectId,
} from "./onedrive-projects.js";

describe("onedrive project tiers", () => {
  it("uses the json tier, and a dot folder without one is hidden", () => {
    assert.equal(normalizeTier("backend", "Visible"), "backend");
    assert.equal(normalizeTier("", ".eStore"), "hidden");
    assert.equal(normalizeTier("", "Debate"), "main");
  });

  it("keeps a kebab id when the folder name has spaces", () => {
    assert.equal(stableProjectId({ id: "college-prep" }, "College Prep"), "college-prep");
    assert.equal(stableProjectId({}, ".eStore"), "eStore");
  });

  it("omits backend and still returns hidden", async () => {
    const root = await mkdtemp(join(tmpdir(), "od-projects-"));
    await mkdir(join(root, "College Prep"), { recursive: true });
    await writeFile(
      join(root, "College Prep/project.json"),
      JSON.stringify({ id: "college-prep", name: "College Prep", tier: "main" })
    );
    await mkdir(join(root, ".eStore"), { recursive: true });
    await writeFile(
      join(root, ".eStore/project.json"),
      JSON.stringify({ id: "estore", name: "eStore", tier: "hidden" })
    );
    await mkdir(join(root, ".tests"), { recursive: true });
    await writeFile(
      join(root, ".tests/project.json"),
      JSON.stringify({ id: "tests", name: "Tests", tier: "backend" })
    );
    const listed = await listTopLevelProjects({ roots: [root] });
    assert.deepEqual(
      listed.map((row) => row.id).sort(),
      ["college-prep", "estore"]
    );
    const all = await listTopLevelProjects({ includeBackend: true, roots: [root] });
    assert.equal(all.find((row) => row.id === "tests")?.tier, "backend");
  });
});

describe("onedrive backup filter", () => {
  it("copies class json and skips a worksheet pdf", () => {
    assert.equal(
      backupShouldCopy("C. Advanced Calc/.HW Sep 16 problem set/.todo.json", "grade"),
      true
    );
    assert.equal(
      backupShouldCopy("H. Physics/.education/class.json", "grade"),
      true
    );
    assert.equal(
      backupShouldCopy("C. Advanced Calc/.HW Sep 16 problem set/problem set.pdf", "grade"),
      false
    );
  });

  it("copies project json and chat history, and skips audio", () => {
    assert.equal(backupShouldCopy("project.json", "project"), true);
    assert.equal(backupShouldCopy(".chat-history/2026-11-27/note.txt", "project"), true);
    assert.equal(backupShouldCopy("sites/song.wav", "project"), false);
    assert.equal(backupShouldCopy("essay.docx", "project"), false);
  });

  it("copies a person card in a full tree and skips Finder junk", () => {
    assert.equal(backupShouldCopy("brain/people/ada/person.md", "full"), true);
    assert.equal(backupShouldCopy(".DS_Store", "full"), false);
  });
});
