import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setObjectFolderHidden } from "./education-onedrive-visibility.js";

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
