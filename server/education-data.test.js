import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextFileListOpts,
  isSafeContextFileName,
  listContextFiles,
  parseHiddenFileNames,
  parseVisibleFileNames,
} from "./education-data.js";

describe("parseHiddenFileNames", () => {
  it("returns empty set when hiddenFiles is absent", () => {
    assert.deepEqual([...parseHiddenFileNames({})], []);
    assert.deepEqual([...parseHiddenFileNames(null)], []);
  });

  it("keeps valid basenames lowercase", () => {
    const names = parseHiddenFileNames({
      hiddenFiles: ["worksheet.pdf", "Notes.md"],
    });
    assert.equal(names.size, 2);
    assert.ok(names.has("worksheet.pdf"));
    assert.ok(names.has("notes.md"));
  });

  it("rejects dotfiles and property JSON names", () => {
    const names = parseHiddenFileNames({
      hiddenFiles: [".secret", "todo.json", "../evil", "ok.txt"],
    });
    assert.deepEqual([...names], ["ok.txt"]);
  });
});

describe("parseVisibleFileNames", () => {
  it("parses visibleFiles lowercase", () => {
    const names = parseVisibleFileNames({
      visibleFiles: ["CONTEXT.md", ".secret"],
    });
    assert.deepEqual([...names], ["context.md"]);
  });
});

describe("listContextFiles hiddenNames", () => {
  /** @type {string} */
  let dir;

  it("setup temp folder", async () => {
    dir = await mkdtemp(join(tmpdir(), "edu-context-"));
    await writeFile(join(dir, "visible.pdf"), "a");
    await writeFile(join(dir, "hidden.pdf"), "b");
    await writeFile(join(dir, "also-visible.txt"), "c");
    await writeFile(join(dir, ".dotfile"), "d");
    await writeFile(join(dir, "todo.json"), "{}");
    await writeFile(join(dir, "CONTEXT.md"), "model notes");
  });

  it("lists safe files and hides context.md by default", async () => {
    const files = await listContextFiles(dir);
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("omits names in hiddenNames", async () => {
    const files = await listContextFiles(dir, {
      hiddenNames: parseHiddenFileNames({ hiddenFiles: ["hidden.pdf"] }),
    });
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "visible.pdf"]
    );
  });

  it("ignores invalid hiddenFiles entries", async () => {
    const files = await listContextFiles(dir, {
      hiddenNames: parseHiddenFileNames({
        hiddenFiles: ["hidden.pdf", ".secret", "missing.doc"],
      }),
    });
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "visible.pdf"]
    );
  });

  it("shows context.md when listed in visibleFiles", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ visibleFiles: ["CONTEXT.md"] })
    );
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["CONTEXT.md", "also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("lets visibleFiles override hiddenFiles", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        hiddenFiles: ["hidden.pdf"],
        visibleFiles: ["hidden.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("cleanup", async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

describe("isSafeContextFileName", () => {
  it("rejects dotfiles", () => {
    assert.equal(isSafeContextFileName(".notes.pdf"), null);
  });
});
