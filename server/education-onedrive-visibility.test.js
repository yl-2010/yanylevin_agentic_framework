import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hideBookkeepingFiles,
  objectFolderHasUserFiles,
  renameObjectFolder,
  setObjectFolderHidden,
} from "./education-onedrive-visibility.js";

describe("setObjectFolderHidden", () => {
  it("renames to a leading-dot folder and back", async () => {
    const parent = await mkdtemp(join(tmpdir(), "edu-hide-"));
    const visible = join(parent, "hw-foo");
    await mkdir(visible);
    await writeFile(join(visible, "todo.json"), "{}\n");
    const hiddenPath = await setObjectFolderHidden(parent, "hw-foo", true);
    assert.equal(hiddenPath, join(parent, ".hw-foo"));
    await stat(join(parent, ".hw-foo", "todo.json"));
    await assert.rejects(stat(visible));
    const shown = await setObjectFolderHidden(parent, "hw-foo", false);
    assert.equal(shown, visible);
    await stat(join(visible, "todo.json"));
    await assert.rejects(stat(join(parent, ".hw-foo")));
    await rm(parent, { recursive: true, force: true });
  });

  it("hides a Finder name that has spaces", async () => {
    const parent = await mkdtemp(join(tmpdir(), "edu-hide-space-"));
    const visible = join(parent, "HW Sep 15 Foo");
    await mkdir(visible);
    await writeFile(join(visible, "todo.json"), "{}\n");
    const hiddenPath = await setObjectFolderHidden(
      parent,
      "HW Sep 15 Foo",
      true
    );
    assert.equal(hiddenPath, join(parent, ".HW Sep 15 Foo"));
    await stat(join(parent, ".HW Sep 15 Foo", "todo.json"));
    const shown = await setObjectFolderHidden(parent, "HW Sep 15 Foo", false);
    assert.equal(shown, visible);
    await rm(parent, { recursive: true, force: true });
  });
});

describe("objectFolderHasUserFiles", () => {
  it("ignores property JSON, CONTEXT.md, and junk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-files-"));
    await writeFile(join(dir, "todo.json"), "{}\n");
    await writeFile(join(dir, "CONTEXT.md"), "notes\n");
    await writeFile(join(dir, ".DS_Store"), "");
    assert.equal(await objectFolderHasUserFiles(dir), false);
    await writeFile(join(dir, "worksheet.pdf"), "pdf");
    assert.equal(await objectFolderHasUserFiles(dir), true);
    await rm(dir, { recursive: true, force: true });
  });

  it("ignores Canvas downloads when deciding the folder was started", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-canvas-"));
    await writeFile(join(dir, "todo.json"), "{}\n");
    await writeFile(join(dir, "Escrito.png"), "clipart");
    const ignore = new Set(["escrito.png"]);
    assert.equal(await objectFolderHasUserFiles(dir, 0, ignore), false);
    await writeFile(join(dir, "my draft.docx"), "work");
    assert.equal(await objectFolderHasUserFiles(dir, 0, ignore), true);
    await rm(dir, { recursive: true, force: true });
  });

  it("counts nested user files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-nested-"));
    await writeFile(join(dir, "todo.json"), "{}\n");
    await mkdir(join(dir, "notes"));
    assert.equal(await objectFolderHasUserFiles(dir), false);
    await writeFile(join(dir, "notes", "quotes.html"), "<p></p>");
    assert.equal(await objectFolderHasUserFiles(dir), true);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("hideBookkeepingFiles", () => {
  it("renames todo.json and CONTEXT.md to leading-dot names", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-dot-"));
    await writeFile(join(dir, "todo.json"), "{}\n");
    await writeFile(join(dir, "CONTEXT.md"), "notes\n");
    await writeFile(join(dir, "worksheet.pdf"), "pdf");
    await hideBookkeepingFiles(dir);
    await stat(join(dir, ".todo.json"));
    await stat(join(dir, ".CONTEXT.md"));
    await stat(join(dir, "worksheet.pdf"));
    await assert.rejects(stat(join(dir, "todo.json")));
    await assert.rejects(stat(join(dir, "CONTEXT.md")));
    await rm(dir, { recursive: true, force: true });
  });
});

describe("renameObjectFolder", () => {
  it("renames a hidden kebab folder to a spaced Finder name", async () => {
    const parent = await mkdtemp(join(tmpdir(), "edu-rename-"));
    const hidden = join(parent, ".hw-comparing-motion-diagrams");
    await mkdir(hidden);
    await writeFile(join(hidden, "todo.json"), "{}\n");
    const id = await renameObjectFolder(
      parent,
      "hw-comparing-motion-diagrams",
      "HW Sep 15 Comparing Motion Diagrams"
    );
    assert.equal(id, "HW Sep 15 Comparing Motion Diagrams");
    await stat(
      join(parent, ".HW Sep 15 Comparing Motion Diagrams", "todo.json")
    );
    await assert.rejects(stat(hidden));
    await rm(parent, { recursive: true, force: true });
  });
});
