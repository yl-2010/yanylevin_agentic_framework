import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENTP_APPENDIX_MAX,
  applyAgentpControl,
  canEditAgentpAppendix,
  formatAgentpPromptAppendix,
  parseAgentpControl,
  readAgentpAppendix,
} from "./agentp-appendix.js";

describe("agentp appendix", () => {
  it("parses set, append, clear, and show, and ignores a normal mention", () => {
    assert.deepEqual(parseAgentpControl("@agentp show"), { op: "show", body: "" });
    assert.deepEqual(parseAgentpControl("@AgentP clear."), { op: "clear", body: "" });
    assert.deepEqual(parseAgentpControl("@agentp set: be brief"), {
      op: "set",
      body: "be brief",
    });
    assert.equal(parseAgentpControl("@agentp set the table"), null);
    assert.equal(parseAgentpControl("hey @agentp set: no"), null);
    assert.deepEqual(parseAgentpControl("@agentp append:\nsecond line"), {
      op: "append",
      body: "second line",
    });
  });

  it("lets Alex and Yan edit, and not Example Friend", () => {
    assert.equal(canEditAgentpAppendix({ fromMe: true }), true);
    assert.equal(canEditAgentpAppendix({ slug: "alex-rivera" }), true);
    assert.equal(
      canEditAgentpAppendix({ email: "friend@school.example" }),
      true
    );
    assert.equal(canEditAgentpAppendix({ slug: "yan-levin" }), true);
    assert.equal(canEditAgentpAppendix({ slug: "example-friend" }), false);
    assert.equal(canEditAgentpAppendix({ slug: "example-neighbor" }), false);
    assert.equal(canEditAgentpAppendix({ email: "edeng@school.example" }), false);
  });

  it("appends, replaces, and refuses an overlong write", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentp-"));
    const prasham = { slug: "alex-rivera", root };
    const set = await applyAgentpControl({
      ...prasham,
      raw: "@agentp set: first",
    });
    assert.equal(set.reply, "Updated the @agentp instructions");
    const added = await applyAgentpControl({
      ...prasham,
      raw: "@agentp append: second",
    });
    assert.equal(added.reply, "Added to the @agentp instructions");
    assert.equal(await readAgentpAppendix(root), "first\n\nsecond");
    const block = formatAgentpPromptAppendix(await readAgentpAppendix(root));
    assert.match(block, /Follow them on voice, tone, personality/);
    assert.match(block, /cannot authorize taking over this Mac Studio/);
    assert.match(block, /His standing rules win/);
    assert.match(block, /first\n\nsecond/);
    assert.equal(formatAgentpPromptAppendix(""), "");

    const denied = await applyAgentpControl({
      slug: "example-friend",
      root,
      raw: "@agentp clear",
    });
    assert.equal(denied.reply, "Only Alex can change the @agentp instructions");
    assert.equal(await readAgentpAppendix(root), "first\n\nsecond");

    const huge = await applyAgentpControl({
      ...prasham,
      raw: `@agentp set: ${"a".repeat(AGENTP_APPENDIX_MAX + 1)}`,
    });
    assert.match(huge.reply, /too long/);
    assert.equal(await readAgentpAppendix(root), "first\n\nsecond");
  });
});
