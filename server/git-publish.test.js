import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoGitPaths } from "./git-publish.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("repoGitPaths", () => {
  it("keeps repo-relative paths and drops OneDrive", () => {
    const kept = repoGitPaths([
      "education/you@example.com/meta.json",
      "$HOME/Documents/11th Grade/H. Physics/.education/class.json",
      "../outside.txt",
      "--force",
      "",
    ]);
    assert.deepEqual(kept, ["education/you@example.com/meta.json"]);
  });

  it("accepts an absolute path that is still in the repo", () => {
    const abs = join(REPO, "server/git-publish.js");
    assert.deepEqual(repoGitPaths([abs]), ["server/git-publish.js"]);
  });
});
