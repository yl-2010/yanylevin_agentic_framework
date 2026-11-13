import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChatHistoryMeta } from "./education-chat-history.js";
import {
  cancelFutureAgent,
  formatPacificScheduleLabel,
  formatScheduledSystemBlock,
  formatScheduledUserBubble,
  futureAgentWait,
  listUpcomingFutureAgents,
  parseRunAt,
  readFutureAgent,
  scheduleFutureAgent,
  scheduledThreadShouldInheritHide,
  selectDueFutureAgents,
} from "./future-agents.js";
import { listChatHistory, patchChatHistoryEphemeral } from "./education-chat-history.js";

const YAN = "you@example.com";
const JEFFERY = "friend@example.com";
const RUN_AT = "2026-10-13T16:35:00.000Z";
const NOW = Date.parse("2026-10-11T08:00:00.000Z");

describe("parseRunAt", () => {
  it("keeps the Pacific wall time when the offset is the other one", () => {
    assert.equal(
      parseRunAt("2026-10-13T09:35:00-07:00"),
      "2026-10-13T16:35:00.000Z"
    );
    assert.equal(
      parseRunAt("2026-12-01T09:35:00-07:00"),
      "2026-12-01T17:35:00.000Z"
    );
  });
});

describe("future agent schedule", () => {
  it("formats the user bubble in Pacific time", () => {
    const bubble = formatScheduledUserBubble(
      RUN_AT,
      "Send the Spanish MA link in this Teams chat."
    );
    assert.equal(
      formatPacificScheduleLabel(RUN_AT),
      "Tue, Oct 13, 2026, 9:35 AM PT"
    );
    assert.equal(
      bubble,
      "Agent scheduled for Tue, Oct 13, 2026, 9:35 AM PT:\n\nSend the Spanish MA link in this Teams chat."
    );
  });

  it("puts a JYPE schedule in JYPE history and a personal one in that inbox", async () => {
    const root = await mkdtemp(join(tmpdir(), "future-agents-"));
    try {
      const jype = await scheduleFutureAgent({
        root,
        now: NOW,
        runAt: "2026-10-13T09:35:00-07:00",
        prompt: "Send the Spanish MA link in this Teams chat.",
        context: "Site is https://yanylevin.com/spanish-ma/. Asked in JYPE Teams.",
        workspace: "jype",
        email: YAN,
        origin: { kind: "teams", chatId: "19:abc@thread.v2" },
      });
      const personalPath = join(
        root,
        "education",
        YAN,
        ".chat-history",
        `${jype.sessionId}.md`
      );
      const jypePath = join(
        root,
        "education/projects/jype/.chat-history",
        `${jype.sessionId}.md`
      );
      await assert.rejects(readFile(personalPath, "utf8"));
      const jypeText = await readFile(jypePath, "utf8");
      const meta = parseChatHistoryMeta(jypeText);
      assert.equal(meta.scheduled, true);
      assert.equal(meta.scheduledStatus, "pending");
      assert.equal(meta.workspace, "jype");
      assert.match(meta.title, /^Scheduled: /);
      assert.match(jypeText, /Send the Spanish MA link/);
      assert.equal(jype.history, "jype");
      assert.equal(jype.runAtLocal, "Tue, Oct 13, 2026, 9:35 AM PT");

      const personal = await scheduleFutureAgent({
        root,
        now: NOW,
        runAt: "2026-10-14T15:00:00-07:00",
        prompt: "Remind me to mail the form.",
        workspace: "personal",
        email: YAN,
      });
      assert.equal(personal.history, "personal");
      const own = await readFile(
        join(root, "education", YAN, ".chat-history", `${personal.sessionId}.md`),
        "utf8"
      );
      assert.match(own, /Remind me to mail the form/);
      assert.doesNotMatch(own, /^ephemeral:/m);
      await assert.rejects(
        readFile(
          join(
            root,
            "education/projects/jype/.chat-history",
            `${personal.sessionId}.md`
          ),
          "utf8"
        )
      );

      await assert.rejects(
        scheduleFutureAgent({
          root,
          now: NOW,
          runAt: "2026-10-14T15:00:00-07:00",
          prompt: "Nope.",
          workspace: "personal",
          email: JEFFERY,
        })
      );

      const upcoming = await listUpcomingFutureAgents({ root });
      assert.deepEqual(
        upcoming.map((row) => row.sessionId),
        [jype.sessionId, personal.sessionId]
      );

      const block = formatScheduledSystemBlock(jype.record, { kickoff: true });
      assert.match(block, /19:abc@thread\.v2/);
      assert.match(block, /https:\/\/yanylevin\.com\/spanish-ma\//);

      const canceled = await cancelFutureAgent(jype.sessionId, { root });
      assert.equal(canceled.status, "canceled");
      const hidden = parseChatHistoryMeta(await readFile(jypePath, "utf8"));
      assert.equal(hidden.visibility, "hidden");
      assert.equal(hidden.scheduledStatus, "canceled");
      const left = await listUpcomingFutureAgents({ root });
      assert.deepEqual(
        left.map((row) => row.sessionId),
        [personal.sessionId]
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("inherits the parent chat hide and keeps JYPE listed", async () => {
    const root = await mkdtemp(join(tmpdir(), "future-agents-hide-"));
    const finished = "2026-10-11T08:00:00.000Z";
    try {
      const hidden = await scheduleFutureAgent({
        root,
        now: NOW,
        runAt: "2026-10-14T15:00:00-07:00",
        prompt: "Text me when class ends.",
        workspace: "personal",
        email: YAN,
        ephemeral: true,
        origin: { kind: "imessage", to: "+15551212" },
      });
      const hiddenPath = join(
        root,
        "education",
        YAN,
        ".chat-history",
        `${hidden.sessionId}.md`
      );
      const hiddenText = await readFile(hiddenPath, "utf8");
      assert.match(hiddenText, /^ephemeral: true$/m);
      const hiddenRecord = await readFutureAgent(hidden.sessionId, { root });
      assert.equal(hiddenRecord?.ephemeral, true);
      await writeFile(
        hiddenPath,
        hiddenText.replace(/^updated: .+$/m, `updated: ${finished}`),
        "utf8"
      );
      const stillFresh = await listChatHistory({
        root,
        email: YAN,
        now: new Date("2026-10-11T08:09:00.000Z"),
      });
      assert.ok(stillFresh.some((row) => row.sessionId === hidden.sessionId));
      const expired = await listChatHistory({
        root,
        email: YAN,
        now: new Date("2026-10-11T08:11:00.000Z"),
      });
      assert.equal(
        expired.some((row) => row.sessionId === hidden.sessionId),
        false
      );

      const jype = await scheduleFutureAgent({
        root,
        now: NOW,
        runAt: "2026-10-14T15:00:00-07:00",
        prompt: "Send the link in Teams.",
        workspace: "jype",
        email: YAN,
        ephemeral: true,
        origin: { kind: "teams", chatId: "19:abc@thread.v2" },
      });
      const jypeText = await readFile(
        join(root, "education/projects/jype/.chat-history", `${jype.sessionId}.md`),
        "utf8"
      );
      assert.doesNotMatch(jypeText, /^ephemeral:/m);
      const jypeRecord = await readFutureAgent(jype.sessionId, { root });
      assert.equal(jypeRecord?.ephemeral, false);
      const jypeListed = await listChatHistory({
        root,
        email: YAN,
        workspace: "jype",
        now: new Date("2026-10-11T09:00:00.000Z"),
      });
      assert.ok(jypeListed.some((row) => row.sessionId === jype.sessionId));

      const kept = await scheduleFutureAgent({
        root,
        now: NOW,
        runAt: "2026-10-14T15:00:00-07:00",
        prompt: "Leave this one listed.",
        workspace: "personal",
        email: YAN,
      });
      const keptPath = join(
        root,
        "education",
        YAN,
        ".chat-history",
        `${kept.sessionId}.md`
      );
      const before = await readFile(keptPath, "utf8");
      const updated = before.match(/^updated: (\S+)/m)?.[1] || "";
      assert.equal(
        scheduledThreadShouldInheritHide(
          { workspace: "", origin: { kind: "teams" }, status: "done" },
          { visibility: "showing", messages: [{ role: "user" }] }
        ),
        true
      );
      assert.equal(
        scheduledThreadShouldInheritHide(
          { workspace: "jype", origin: { kind: "teams" }, status: "done" },
          { visibility: "showing", messages: [{ role: "user" }] }
        ),
        false
      );
      assert.equal(
        scheduledThreadShouldInheritHide(
          { workspace: "", origin: { kind: "teams" }, status: "done" },
          {
            visibility: "showing",
            messages: [{ role: "user" }, { role: "user" }],
          }
        ),
        false
      );
      assert.equal(await patchChatHistoryEphemeral({
        root,
        email: YAN,
        sessionId: kept.sessionId,
      }), true);
      const after = await readFile(keptPath, "utf8");
      assert.match(after, /^ephemeral: true$/m);
      assert.match(after, new RegExp(`^updated: ${updated}$`, "m"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects overdue pending jobs and crashed running jobs", () => {
    const now = Date.parse("2026-10-13T17:00:00.000Z");
    const due = selectDueFutureAgents(
      [
        { status: "pending", runAt: "2026-10-13T16:35:00.000Z", sessionId: "a" },
        { status: "pending", runAt: "2026-10-14T16:35:00.000Z", sessionId: "b" },
        { status: "running", runAt: "2026-10-13T16:35:00.000Z", sessionId: "c" },
        { status: "done", runAt: "2026-10-13T16:00:00.000Z", sessionId: "d" },
        { status: "canceled", runAt: "2026-10-12T16:00:00.000Z", sessionId: "e" },
      ],
      now
    );
    assert.deepEqual(
      due.map((row) => row.sessionId),
      ["a", "c"]
    );
    assert.deepEqual(futureAgentWait({ status: "running", runAt: "2099-01-01T00:00:00.000Z" }, now), {
      wait: 0,
      rearm: false,
    });
    const later = futureAgentWait(
      { status: "pending", runAt: "2026-10-13T18:00:00.000Z" },
      now
    );
    assert.equal(later.wait, 60 * 60 * 1000);
    assert.equal(later.rearm, false);
  });
});
