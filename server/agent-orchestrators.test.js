import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ORCHESTRATOR_INDEX_PATH,
  loadOrchestratorIndex,
  orchestratorKey,
  readOrchestrator,
  removeOrchestrator,
  writeOrchestrator,
} from "./agent-orchestrators.js";

/** @type {string} */
let root;
/** @type {string} */
let indexPath;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "agent-orchestrators-"));
  indexPath = join(root, "agent-mentions", "orchestrators.json");
  await mkdir(dirname(indexPath), { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("orchestratorKey", () => {
  it("keys a teams chat for agent and agentg, and an imessage chat", () => {
    assert.equal(
      orchestratorKey("teams", "19:chat:id", "agent"),
      "teams:19:chat:id:agent"
    );
    assert.equal(
      orchestratorKey("teams", "19:chat:id", "agentg"),
      "teams:19:chat:id:agentg"
    );
    assert.equal(
      orchestratorKey("teams", " 19:chat:id ", "grok"),
      "teams:19:chat:id:agentg"
    );
    assert.equal(
      orchestratorKey("imessage", "+15551212", "note"),
      "imessage:+15551212:agent"
    );
    assert.equal(orchestratorKey("slack", "abc", "agent"), "imessage:abc:agent");
    assert.equal(orchestratorKey("Teams", "abc", "agentg"), "imessage:abc:agentg");
  });

  it("returns an empty string when the chat id is blank", () => {
    assert.equal(orchestratorKey("teams", "", "agent"), "");
    assert.equal(orchestratorKey("teams", "   ", "agentg"), "");
    assert.equal(orchestratorKey("imessage", null, "grok"), "");
    assert.equal(orchestratorKey("teams", undefined, "agent"), "");
  });
});

describe("orchestrator index", () => {
  it("points the default path at data/agent-mentions/orchestrators.json", () => {
    assert.ok(
      ORCHESTRATOR_INDEX_PATH.endsWith(
        join("data", "agent-mentions", "orchestrators.json")
      )
    );
  });

  it("loads a missing file as {}", async () => {
    assert.deepEqual(await loadOrchestratorIndex(indexPath), {});
    assert.equal(await readOrchestrator("teams:19:chat:id:agent", indexPath), null);
  });

  it("loads corrupt JSON as {}", async () => {
    await writeFile(indexPath, "{not json", "utf8");
    assert.deepEqual(await loadOrchestratorIndex(indexPath), {});
    await writeFile(indexPath, "[]", "utf8");
    assert.deepEqual(await loadOrchestratorIndex(indexPath), {});
  });

  it("writes then reads a row, and a second write keeps the first key", async () => {
    const teamsKey = orchestratorKey("teams", "19:chat:id", "agent");
    const grokKey = orchestratorKey("imessage", "+15551212", "grok");

    const first = await writeOrchestrator(
      teamsKey,
      {
        sessionId: "sess-1",
        cursorAgentId: "agent-1",
        workspace: "jype",
        email: "yan@example.com",
        extra: "drop me",
      },
      indexPath
    );
    assert.deepEqual(first, {
      sessionId: "sess-1",
      cursorAgentId: "agent-1",
      workspace: "jype",
      email: "yan@example.com",
    });

    await writeOrchestrator(
      grokKey,
      {
        sessionId: "sess-2",
        cursorAgentId: "agent-2",
        workspace: "home",
        email: "prasham@example.com",
      },
      indexPath
    );

    assert.deepEqual(await readOrchestrator(teamsKey, indexPath), {
      sessionId: "sess-1",
      cursorAgentId: "agent-1",
      workspace: "jype",
      email: "yan@example.com",
    });
    assert.deepEqual(await readOrchestrator(grokKey, indexPath), {
      sessionId: "sess-2",
      cursorAgentId: "agent-2",
      workspace: "",
      email: "prasham@example.com",
    });

    const stored = JSON.parse(await readFile(indexPath, "utf8"));
    assert.deepEqual(Object.keys(stored).sort(), [grokKey, teamsKey].sort());
    assert.equal(stored[teamsKey].sessionId, "sess-1");

    const names = await readdir(dirname(indexPath));
    assert.deepEqual(
      names.filter((name) => name.endsWith(".tmp")),
      []
    );
  });

  it("keeps the chat target and drops the message body", async () => {
    const key = orchestratorKey("imessage", "chat:with:colons", "agent");
    const written = await writeOrchestrator(
      key,
      {
        sessionId: "sess-origin",
        cursorAgentId: "agent-origin",
        workspace: "",
        email: "yan@example.com",
        platform: "imessage",
        origin: {
          to: "+15551212",
          chatId: "chat:with:colons",
          chat: "Alex",
          text: "this body should not be stored",
          chatGuid: "any;-;+15551212",
        },
      },
      indexPath
    );
    assert.equal(written.origin.text, undefined);
    assert.equal(written.origin.to, "+15551212");
    assert.equal(written.origin.chatId, "chat:with:colons");
    assert.equal(written.platform, "imessage");
    const read = await readOrchestrator(key, indexPath);
    assert.equal(read.origin.chatGuid, "any;-;+15551212");
    assert.equal(read.origin.text, undefined);
  });

  it("drops a stored row that has no sessionId", async () => {
    const key = orchestratorKey("teams", "19:bare", "agent");
    await writeFile(
      indexPath,
      `${JSON.stringify({
        [key]: { cursorAgentId: "c", workspace: "jype", email: "a@b.c" },
      })}\n`,
      "utf8"
    );
    assert.equal(await readOrchestrator(key, indexPath), null);
  });

  it("ignores an empty key and can remove one row", async () => {
    const key = orchestratorKey("teams", "19:keep", "agent");
    assert.equal(await writeOrchestrator("", { sessionId: "nope" }, indexPath), null);
    await assert.rejects(stat(indexPath));

    await writeOrchestrator(
      key,
      { sessionId: "sess-9", cursorAgentId: "c9", workspace: "", email: "" },
      indexPath
    );
    assert.equal(await removeOrchestrator("", indexPath), false);
    assert.equal(await removeOrchestrator("teams:missing:agent", indexPath), false);
    const kept = await readOrchestrator(key, indexPath);
    assert.equal(kept && kept.sessionId, "sess-9");
    assert.equal(await removeOrchestrator(key, indexPath), true);
    assert.equal(await readOrchestrator(key, indexPath), null);
    assert.deepEqual(await loadOrchestratorIndex(indexPath), {});
  });
});
