import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  objectFolderHasUserFiles,
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
