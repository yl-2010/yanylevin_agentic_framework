import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
