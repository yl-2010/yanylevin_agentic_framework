import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HOME_AGENT_INTERVAL_MS,
  HOME_AGENT_MODEL_SPEC,
  VACUUM_DUE_MS,
  VACUUM_SCENE,
  VACUUM_SCENE_FORBIDDEN,
  buildHomeAgentPrompt,
  classifyVacuumLocation,
  homeAgentModelSpec,
  homeVacuumGate,
  msUntilNextHomeAgentTick,
  recordVacuumSkip,
  recordVacuumStart,
  vacuumIsDue,
} from "./home-agent.js";

const HOME = { latitude: 47.7001, longitude: -122.2305 };
const EPS = { latitude: 47.6436, longitude: -122.1988 };
const NOW = Date.parse("2026-09-25T20:00:00.000Z");

describe("home agent model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(HOME_AGENT_MODEL_SPEC.id, "composer-2.5");
    const spec = homeAgentModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
  });
});

describe("home agent tick alignment", () => {
  it("waits until the next Pacific clock hour", () => {
    const nineThirty = Date.parse("2026-09-25T16:30:00.000Z");
    assert.equal(msUntilNextHomeAgentTick(nineThirty), 30 * 60 * 1000);

    const onTen = Date.parse("2026-09-25T17:00:00.000Z");
    assert.equal(msUntilNextHomeAgentTick(onTen), HOME_AGENT_INTERVAL_MS);
  });
});

describe("vacuum due window", () => {
  it("is due at exactly 72 hours and not one millisecond earlier", () => {
    const started = new Date(NOW - VACUUM_DUE_MS).toISOString();
    assert.equal(vacuumIsDue(started, NOW), true);
    assert.equal(vacuumIsDue(new Date(NOW - VACUUM_DUE_MS + 1).toISOString(), NOW), false);
    assert.equal(vacuumIsDue(null, NOW), true);
  });
});

describe("vacuum location gate", () => {
  it("stops at home, on a missing pin, and when the pin is not clearly away", () => {
    assert.equal(classifyVacuumLocation(HOME).kind, "home");
    assert.equal(classifyVacuumLocation(null).kind, "missing");
    assert.equal(classifyVacuumLocation(EPS).kind, "away");
    assert.equal(
      classifyVacuumLocation({
        latitude: 47.7011,
        longitude: -122.2305,
        accuracyMeters: 500,
      }).kind,
      "unclear"
    );

    assert.equal(homeVacuumGate({ nowMs: NOW, location: HOME }).reason, "at-home");
    assert.equal(homeVacuumGate({ nowMs: NOW, location: null }).reason, "no-pin");
    assert.equal(homeVacuumGate({ nowMs: NOW, location: EPS }).reason, "due");
    assert.equal(
      homeVacuumGate({
        nowMs: NOW,
        location: EPS,
        lastStartedAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      }).reason,
      "recent-vacuum"
    );
    assert.equal(
      homeVacuumGate({
        nowMs: NOW,
        location: EPS,
        nextCheckAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
      }).reason,
      "next-check"
    );
    assert.equal(
      homeVacuumGate({ nowMs: NOW, location: HOME, force: true }).reason,
      "force"
    );
  });
});

describe("home agent prompt", () => {
  it("names Vacuum Yan and forbids Vacuum Yan's Rooms", () => {
    const prompt = buildHomeAgentPrompt({
      dateKey: "2026-09-25",
      timezone: "America/Los_Angeles",
      vacuumPath: "/tmp/vacuum.json",
      location: { ...EPS, timestamp: "2026-09-25T19:00:00.000Z", accuracyMeters: 12 },
    });
    assert.match(prompt, /home-agent skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /trigger "Vacuum Yan"/);
    assert.match(prompt, /Never trigger "Vacuum Yan's Rooms"/);
    assert.equal(prompt.includes(VACUUM_SCENE), true);
    assert.equal(prompt.includes(VACUUM_SCENE_FORBIDDEN), true);
    assert.match(prompt, /within 2 hours/);
    assert.match(prompt, /action_count 0 is normal/);
    assert.match(prompt, /record-start/);
    assert.match(prompt, /record-skip/);
  });
});

describe("vacuum state writes", () => {
  it("keeps lastStartedAt when recording a skip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-"));
    const path = join(dir, "vacuum.json");
    await recordVacuumStart({
      path,
      at: "2026-09-22T18:00:00.000Z",
      reason: "away until evening",
    });
    await recordVacuumSkip({
      path,
      at: "2026-09-25T20:00:00.000Z",
      reason: "back within 2 hours",
      nextCheckAt: "2026-09-25T23:00:00.000Z",
    });
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.lastStartedAt, "2026-09-22T18:00:00.000Z");
    assert.equal(saved.scene, VACUUM_SCENE);
    assert.equal(saved.nextCheckAt, "2026-09-25T23:00:00.000Z");
    assert.equal(saved.skipReason, "back within 2 hours");
  });
});
