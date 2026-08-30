import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contextFileListOpts,
  isSafeContextFileName,
  listContextFiles,
  parseHiddenFileNames,
  parseOrderedFileNames,
  parseVisibleFileNames,
  parseOrderedProjectPins,
  sortEducationProjects,
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
    await writeFile(join(dir, "deleted.md"), "# Manually deleted\n");
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

describe("parseOrderedFileNames", () => {
  it("keeps first-occurrence order and skips junk", () => {
    assert.deepEqual(
      parseOrderedFileNames(["Z.pdf", "a.txt", "Z.PDF", ".dot", "todo.json", "a.txt"]),
      ["z.pdf", "a.txt"]
    );
  });

  it("returns empty when absent", () => {
    assert.deepEqual(parseOrderedFileNames(undefined), []);
    assert.deepEqual(parseOrderedFileNames(null), []);
  });
});

describe("listContextFiles pin order", () => {
  /** @type {string} */
  let dir;

  it("setup temp folder with known mtimes", async () => {
    dir = await mkdtemp(join(tmpdir(), "edu-pins-"));
    await writeFile(join(dir, "old.pdf"), "a");
    await writeFile(join(dir, "mid.pdf"), "b");
    await writeFile(join(dir, "new.pdf"), "c");
    await writeFile(join(dir, "hidden.pdf"), "d");
    const t0 = new Date("2024-01-01T00:00:00Z");
    const t1 = new Date("2024-06-01T00:00:00Z");
    const t2 = new Date("2024-12-01T00:00:00Z");
    const t3 = new Date("2025-01-01T00:00:00Z");
    await utimes(join(dir, "old.pdf"), t0, t0);
    await utimes(join(dir, "mid.pdf"), t1, t1);
    await utimes(join(dir, "new.pdf"), t2, t2);
    await utimes(join(dir, "hidden.pdf"), t3, t3);
  });

  it("defaults to newest mtime first", async () => {
    const files = await listContextFiles(dir);
    assert.deepEqual(
      files.map((f) => f.name),
      ["hidden.pdf", "new.pdf", "mid.pdf", "old.pdf"]
    );
  });

  it("pins filesTop above mtime order", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesTop: ["old.pdf", "new.pdf"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "new.pdf", "hidden.pdf", "mid.pdf"]
    );
  });

  it("pins filesBottom below mtime order", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesBottom: ["new.pdf", "old.pdf"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["hidden.pdf", "mid.pdf", "new.pdf", "old.pdf"]
    );
  });

  it("puts unpinned files between top and bottom", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        filesTop: ["old.pdf"],
        filesBottom: ["new.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "hidden.pdf", "mid.pdf", "new.pdf"]
    );
  });

  it("lets filesTop win when a name is in both lists", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        filesTop: ["new.pdf"],
        filesBottom: ["new.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["new.pdf", "hidden.pdf", "mid.pdf", "old.pdf"]
    );
  });

  it("skips missing names and matches case-insensitively", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesTop: ["missing.doc", "OLD.PDF"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "hidden.pdf", "new.pdf", "mid.pdf"]
    );
  });

  it("does not show a hidden file just because it is pinned", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        hiddenFiles: ["hidden.pdf"],
        filesTop: ["hidden.pdf", "old.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "new.pdf", "mid.pdf"]
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

describe("sortEducationProjects", () => {
  it("parses projectsTop names lowercase and skips paths", () => {
    assert.deepEqual(
      parseOrderedProjectPins(["PathIvy", "pathivy", "../x", "ϵStore"]),
      ["pathivy", "ϵstore"]
    );
  });

  it("puts newest lastOpened first", () => {
    const sorted = sortEducationProjects(
      [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
        { id: "c", name: "Gamma" },
      ],
      {
        openedAt: {
          a: "2026-08-01T00:00:00.000Z",
          c: "2026-08-20T00:00:00.000Z",
        },
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["c", "a", "b"]
    );
  });

  it("keeps leftover order among never-opened projects", () => {
    const sorted = sortEducationProjects([
      { id: "debate", name: "Debate", order: 4 },
      { id: "yanylevin", name: "YanYLevin", order: 1 },
      { id: "estore", name: "ϵStore", order: 3 },
    ]);
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["yanylevin", "estore", "debate"]
    );
  });

  it("pins projectsTop above recency, projectsBottom below", () => {
    const sorted = sortEducationProjects(
      [
        { id: "pathivy", name: "PathIvy" },
        { id: "estore", name: "ϵStore" },
        { id: "debate", name: "Debate" },
        { id: "sockethr", name: "ExampleCo" },
      ],
      {
        projectsTop: ["PathIvy"],
        projectsBottom: ["debate"],
        openedAt: {
          estore: "2026-08-29T00:00:00.000Z",
          sockethr: "2026-08-20T00:00:00.000Z",
        },
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["pathivy", "estore", "sockethr", "debate"]
    );
  });

  it("matches pins by folder id or name, case-insensitive", () => {
    const sorted = sortEducationProjects(
      [
        { id: "estore", name: "ϵStore" },
        { id: "jype-frontier-cascadia", name: "JYPE - Frontier Cascadia" },
      ],
      {
        projectsTop: ["ESTORE"],
        projectsBottom: ["JYPE - Frontier Cascadia"],
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["estore", "jype-frontier-cascadia"]
    );
  });

  it("lets projectsTop win when a name is in both lists", () => {
    const sorted = sortEducationProjects(
      [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
      {
        projectsTop: ["b"],
        projectsBottom: ["b", "a"],
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["b", "a"]
    );
  });

  it("skips missing pin names", () => {
    const sorted = sortEducationProjects(
      [{ id: "a", name: "Alpha", order: 2 }],
      { projectsTop: ["gone", "Alpha"], projectsBottom: ["also-gone"] }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["a"]
    );
  });
});
