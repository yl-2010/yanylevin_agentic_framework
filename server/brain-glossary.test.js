import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ENTITY_DIRS, serializeFrontmatter } from "./brain-lib.js";
import {
  addGlossary,
  checkGlossary,
  lookupGlossary,
  runGlossary,
  searchGlossary,
} from "./brain-glossary.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "glossary-"));

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function add(term, extra = {}) {
  return addGlossary({
    root,
    term,
    gloss: extra.gloss || `${term} means a test shorthand.`,
    aliases: extra.aliases || [],
    see: extra.see || [],
    today: "2026-10-03",
  });
}

describe("glossary lookup", { concurrency: false }, () => {
  it("stays out of the people graph", () => {
    assert.equal(
      ENTITY_DIRS.some((dir) => dir.dir === "glossary"),
      false,
    );
  });

  it("matches term, alias, and light punctuation", () => {
    add("A-day", {
      gloss: "Example School rotation day. Periods run A through D.",
      aliases: ["A day"],
      see: ["orgs/eastside-prep"],
    });
    for (const query of ["A-day", "a day", "A day."]) {
      const hit = runGlossary([query], root);
      assert.equal(hit.exitCode, 0, hit.stderr);
      assert.match(hit.stdout, /Example School rotation day/);
      assert.match(hit.stdout, /glossary\/a-day/);
    }
    const miss = runGlossary(["not-a-term"], root);
    assert.equal(miss.exitCode, 1);
    assert.match(miss.stderr, /not in glossary/);
  });

  it("updates an existing alias instead of creating a second file", () => {
    const updated = add("A day", {
      gloss: "Rotation day with periods A through D.",
      aliases: ["A-day schedule"],
    });
    assert.equal(updated.created, false);
    assert.equal(updated.slug, "a-day");
    const files = fs.readdirSync(path.join(root, "glossary")).filter((name) => name.endsWith(".md") && name !== "index.md");
    assert.deepEqual(files, ["a-day.md"]);
    const looked = lookupGlossary(root, "A-day schedule");
    assert.equal(looked.length, 1);
    assert.match(looked[0].body, /periods A through D/);
    assert.ok(looked[0].aliases.includes("A-day schedule"));
  });

  it("fails check when two files share an alias or the index is stale", () => {
    const dir = path.join(root, "glossary");
    const other = path.join(dir, "adv-calc.md");
    fs.writeFileSync(
      other,
      `${serializeFrontmatter({
        term: "Adv Calc",
        kind: "glossary",
        aliases: ["A day"],
        see: [],
        last_touched: "2026-10-03",
      })}Advanced Calculus nickname.\n`,
    );
    const collision = checkGlossary(root);
    assert.equal(collision.ok, false);
    assert.match(collision.problems.join("\n"), /alias collision/);

    fs.rmSync(other);
    const fresh = runGlossary(["--write-index"], root);
    assert.equal(fresh.exitCode, 0, fresh.stderr);
    assert.equal(checkGlossary(root).ok, true);

    fs.writeFileSync(path.join(dir, "index.md"), "# stale\n");
    const stale = runGlossary(["--check"], root);
    assert.equal(stale.exitCode, 1);
    assert.match(stale.stderr, /stale: glossary\/index.md/);
  });

  it("searches one-liners and caps the list", () => {
    runGlossary(["--write-index"], root);
    for (let i = 0; i < 16; i += 1) {
      add(`Calc ${i}`, { gloss: `Calc shorthand number ${i}.` });
    }
    const found = searchGlossary(root, "calc");
    assert.ok(found.total >= 16);
    assert.equal(found.shown.length, 15);
    const printed = runGlossary(["--search", "calc"], root);
    assert.match(printed.stdout, /showing 15 of/);
    assert.doesNotMatch(printed.stdout, /# Calc/);
  });
});
