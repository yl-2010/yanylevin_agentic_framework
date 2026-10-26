import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentAction,
  ensureHomeSeeds,
  isDashboardAction,
  isFolderChange,
  lightsActionSummary,
  readAgentActions,
  vacuumSeedRows,
} from "./agent-actions.js";

describe("agent action log", () => {
  it("appends newest first and skips a repeated id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-actions-"));
    const path = join(dir, "actions.jsonl");
    try {
      await appendAgentAction(
        {
          at: "2026-09-22T18:00:00.000Z",
          agent: "home-agent",
          kind: "vacuum",
          summary: "Started Vacuum Yan",
          id: "home-agent:vacuum:yan:2026-09-22T18:00:00.000Z",
        },
        { path }
      );
      const again = await appendAgentAction(
        {
          at: "2026-09-22T18:00:00.000Z",
          agent: "home-agent",
          kind: "vacuum",
          summary: "Started Vacuum Yan",
          id: "home-agent:vacuum:yan:2026-09-22T18:00:00.000Z",
        },
        { path }
      );
      assert.equal(again, null);
      await appendAgentAction(
        {
          at: "2026-09-29T15:00:00.020Z",
          agent: "nightly-actions",
          kind: "mail",
          summary: "Sent mail to Alex",
        },
        { path }
      );
      const { entries } = await readAgentActions({ path, seed: false });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].summary, "Sent mail to Alex");
      assert.equal(entries[0].agentName, "Nightly actions");
      assert.equal(entries[1].summary, "Started Vacuum Yan");
      assert.match(entries[1].when, /Sep 22/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("seeds the latest light-off and vacuum start once", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-actions-seed-"));
    const path = join(dir, "actions.jsonl");
    const lights = {
      lastTurnedOffAt: "2026-09-29T15:00:00.020Z",
      turnedOff: [],
    };
    const vacuum = {
      lastStartedAt: "2026-09-29T16:00:17.936Z",
      scene: "Vacuum Yan",
    };
    try {
      assert.equal(lightsActionSummary(lights), "Turned off Yan's room lights");
      assert.equal(lightsActionSummary({ turnedOff: [{ name: "Desk Lamp" }] }), "Turned off Desk Lamp");
      assert.equal(vacuumSeedRows(vacuum)[0].scene, "Vacuum Yan");
      await ensureHomeSeeds({ path, lights, vacuum });
      await ensureHomeSeeds({ path, lights, vacuum });
      const { entries } = await readAgentActions({ path, seed: false });
      assert.equal(entries.length, 2);
      assert.equal(entries[0].summary, "Started Vacuum Yan");
      assert.equal(entries[1].summary, "Turned off Yan's room lights");
      assert.equal(entries[0].agent, "home-agent");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps chat sends off the dashboard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-actions-chat-"));
    const path = join(dir, "actions.jsonl");
    try {
      assert.equal(isDashboardAction("teams"), false);
      assert.equal(isDashboardAction("imessage"), false);
      assert.equal(isDashboardAction("calendar"), false);
      assert.equal(isDashboardAction("calendar", "nightly-actions"), false);
      assert.equal(isDashboardAction("calendar", "calendar-on-demand"), false);
      assert.equal(isDashboardAction("mail", "nightly-actions"), true);
      assert.equal(isDashboardAction("mail", "nightly-actions", "Sent mail to Alex"), true);
      assert.equal(isFolderChange("Filed Google data-sharing notices into Security"), true);
      assert.equal(
        isDashboardAction("mail", "nightly-actions", "Filed Google data-sharing notices into Security"),
        false
      );
      assert.equal(isFolderChange("Sent mail to Alex"), false);
      assert.equal(isDashboardAction("education-date", "nightly-actions", "Added Fall orientation"), false);
      assert.equal(
        isDashboardAction("education-date", "nightly-actions", "Updated fall parent-teacher conferences"),
        false
      );
      assert.equal(isDashboardAction("education-todo", "nightly-actions", "Added Register for AP tests"), false);
      const dropped = await appendAgentAction(
        {
          agent: "jype",
          kind: "teams",
          summary: "Sent Teams message to JYPE",
        },
        { path }
      );
      assert.equal(dropped, null);
      await appendFile(
        path,
        `${JSON.stringify({
          at: "2026-09-30T16:16:01.064Z",
          agent: "jype",
          kind: "teams",
          summary: "Sent Teams message to JYPE",
        })}\n`,
        "utf8"
      );
      await appendAgentAction(
        {
          at: "2026-09-22T18:00:00.000Z",
          agent: "home-agent",
          kind: "vacuum",
          summary: "Started Vacuum Yan",
        },
        { path }
      );
      await appendFile(
        path,
        `${JSON.stringify({
          at: "2026-10-01T20:00:00.000Z",
          agent: "calendar-on-demand",
          kind: "calendar",
          summary: "Added Dinner Friday on Home",
        })}\n`,
        "utf8"
      );
      const hidden = await appendAgentAction(
        {
          at: "2026-10-02T20:00:00.000Z",
          agent: "calendar-on-demand",
          kind: "calendar",
          summary: "Added Lunch Saturday on Home",
        },
        { path }
      );
      assert.equal(hidden, null);
      await appendFile(
        path,
        `${JSON.stringify({
          at: "2026-10-03T10:00:00.000Z",
          agent: "nightly-actions",
          kind: "calendar",
          summary: "Added Prime Factor TA on School/Work",
        })}\n`,
        "utf8"
      );
      await appendFile(
        path,
        `${JSON.stringify({
          at: "2026-10-11T10:00:47.854Z",
          agent: "nightly-actions",
          kind: "mail",
          summary: "Filed Google data-sharing notices into Security",
        })}\n`,
        "utf8"
      );
      await appendFile(
        path,
        `${JSON.stringify({
          at: "2026-10-23T10:06:59.279Z",
          agent: "nightly-actions",
          kind: "education-date",
          summary: "Updated fall parent-teacher conferences",
        })}\n`,
        "utf8"
      );
      const addedDate = await appendAgentAction(
        {
          at: "2026-10-24T10:00:00.000Z",
          agent: "nightly-actions",
          kind: "education-date",
          summary: "Added Fall orientation",
        },
        { path }
      );
      assert.equal(addedDate, null);
      const filed = await appendAgentAction(
        {
          at: "2026-10-12T10:00:00.000Z",
          agent: "nightly-actions",
          kind: "mail",
          summary: "Moved college spam into Colleges",
        },
        { path }
      );
      assert.equal(filed, null);
      const nightly = await appendAgentAction(
        {
          at: "2026-10-04T10:00:00.000Z",
          agent: "nightly-actions",
          kind: "calendar",
          summary: "Added Debate practice on School/Work",
        },
        { path }
      );
      assert.equal(nightly, null);
      const { entries } = await readAgentActions({ path, seed: false });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, "vacuum");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
