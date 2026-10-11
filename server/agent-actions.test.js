import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentAction,
  ensureHomeSeeds,
  isDashboardAction,
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
      assert.equal(isDashboardAction("calendar"), true);
      assert.equal(isDashboardAction("calendar", "nightly-actions"), true);
      assert.equal(isDashboardAction("calendar", "calendar-on-demand"), false);
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
      const { entries } = await readAgentActions({ path, seed: false });
      assert.equal(entries.length, 1);
      assert.equal(entries[0].kind, "vacuum");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
