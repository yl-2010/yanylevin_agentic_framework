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
  classifyLightsPresence,
  classifyVacuumLocation,
  homeAgentModelSpec,
  homeVacuumGate,
  isYanRoomLight,
  lightsPinMaxAgeMs,
  msUntilNextHomeAgentTick,
  recordVacuumSkip,
  recordVacuumStart,
  turnOffYanRoomLightsIfAway,
  vacuumIsDue,
  yanRoomLightsToTurnOff,
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
    assert.match(prompt, /Do not turn any lights/);
  });
});

describe("away lights presence", () => {
  const freshAway = {
    ...EPS,
    accuracyMeters: 12,
    timestamp: new Date(NOW - 5 * 60 * 1000).toISOString(),
  };

  it("turns lights off only when the pin is fresh and clearly away", () => {
    assert.equal(classifyLightsPresence(freshAway, NOW).turnOff, true);
    assert.equal(classifyLightsPresence(HOME, NOW).reason, "at-home");
    assert.equal(classifyLightsPresence(null, NOW).reason, "no-pin");
    assert.equal(
      classifyLightsPresence(
        {
          latitude: 47.7011,
          longitude: -122.2305,
          accuracyMeters: 500,
          timestamp: freshAway.timestamp,
        },
        NOW
      ).reason,
      "not-clearly-away"
    );
    assert.equal(
      classifyLightsPresence(
        { ...EPS, timestamp: freshAway.timestamp },
        NOW
      ).reason,
      "no-accuracy"
    );
    assert.equal(
      classifyLightsPresence(
        { ...freshAway, timestamp: new Date(NOW - 21 * 60 * 1000).toISOString() },
        NOW
      ).reason,
      "stale-pin"
    );
    assert.equal(
      classifyLightsPresence(
        freshAway,
        NOW,
        { place: "kirkland-home", at: new Date(NOW - 5 * 60 * 1000).toISOString() }
      ).reason,
      "life-state-home"
    );
    assert.equal(
      classifyLightsPresence(
        freshAway,
        NOW,
        { place: "kirkland-home", at: new Date(NOW - 31 * 60 * 1000).toISOString() }
      ).turnOff,
      true
    );
  });

  it("keeps a far pin until a fast drive could have reached the house", () => {
    const far = { latitude: 47.0, longitude: -122.2305, accuracyMeters: 20 };
    const where = classifyVacuumLocation(far);
    assert.equal(where.kind, "away");
    const max = lightsPinMaxAgeMs(where.meters);
    assert.ok(max > 20 * 60 * 1000);
    assert.equal(
      classifyLightsPresence(
        { ...far, timestamp: new Date(NOW - max + 1000).toISOString() },
        NOW
      ).turnOff,
      true
    );
    assert.equal(
      classifyLightsPresence(
        { ...far, timestamp: new Date(NOW - max - 1000).toISOString() },
        NOW
      ).reason,
      "stale-pin"
    );
  });
});

describe("Yan's room lights", () => {
  const on = (row) => ({ power: "true", reachable: true, ...row });

  it("selects lights in his two rooms and leaves the rest of the house", () => {
    const rows = [
      on({
        id: "lamp",
        display_name: "Jellyfish Lamp",
        room: "Yan\u2019s Bedroom",
        category: "outlet",
      }),
      on({
        id: "sky",
        display_name: "Yan\u2019s Bedroom Right Skyline",
        room: "Yan\u2019s Bedroom",
        category: "lightbulb",
      }),
      on({
        id: "main",
        display_name: "Main",
        room: "Yan\u2019s Office",
        category: "switch",
      }),
      on({
        id: "laser",
        display_name: "Disco Lasers",
        room: "Yan\u2019s Office",
        category: "outlet",
      }),
      on({
        id: "closet",
        display_name: "Closet Main",
        room: "Yan\u2019s Bedroom",
        category: "switch",
      }),
      on({
        id: "bool",
        display_name: "Bedroom Boolean",
        room: "Yan\u2019s Bedroom",
        category: "outlet",
      }),
      on({
        id: "fan",
        display_name: "Bathroom Fan",
        room: "Yan\u2019s Bedroom",
        category: "switch",
      }),
      on({
        id: "tv",
        display_name: "Office TV",
        room: "Yan\u2019s Office",
        category: "outlet",
      }),
      on({
        id: "port",
        display_name: "Desk Port",
        room: "Yan\u2019s Office",
        category: "outlet",
      }),
      on({
        id: "guest",
        display_name: "Guest Bedroom Main Lights",
        room: "Guest Bedroom",
        category: "switch",
      }),
      on({
        id: "kitchen",
        display_name: "Kitchen Main Lights",
        room: "Kitchen",
        category: "lightbulb",
      }),
      on({
        id: "off",
        display_name: "Reading Lamp",
        room: "Yan\u2019s Bedroom",
        category: "outlet",
        power: "false",
      }),
      on({
        id: "dark",
        display_name: "Nanoleaf Lamp",
        room: "Yan\u2019s Office",
        category: "lightbulb",
        reachable: false,
      }),
    ];

    assert.equal(isYanRoomLight(rows[5]), false);
    assert.equal(isYanRoomLight(rows[7]), false);
    const names = yanRoomLightsToTurnOff(rows).map((row) => row.name);
    assert.deepEqual(names, [
      "Jellyfish Lamp",
      "Yan\u2019s Bedroom Right Skyline",
      "Main",
      "Disco Lasers",
      "Closet Main",
    ]);
  });

  it("turns off only the selected lights and records the skip when he might be home", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-lights-"));
    const path = join(dir, "lights.json");
    const calls = [];
    const away = await turnOffYanRoomLightsIfAway({
      path,
      nowMs: NOW,
      location: {
        ...EPS,
        accuracyMeters: 12,
        timestamp: new Date(NOW - 5 * 60 * 1000).toISOString(),
      },
      listAccessories: async () => [
        {
          id: "lamp",
          display_name: "Desk Lamp",
          room: "Yan\u2019s Office",
          category: "outlet",
          state: { power: "true" },
        },
        {
          id: "kitchen",
          display_name: "Island Chandelier",
          room: "Kitchen",
          category: "lightbulb",
          state: { power: "true" },
        },
      ],
      setOff: async (id) => {
        calls.push(id);
      },
    });
    assert.deepEqual(calls, ["lamp"]);
    assert.equal(away.reason, "away");
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.turnedOff[0].name, "Desk Lamp");
    assert.equal(saved.turnedOff[0].id, undefined);

    calls.length = 0;
    const home = await turnOffYanRoomLightsIfAway({
      path,
      nowMs: NOW,
      location: { ...HOME, accuracyMeters: 8, timestamp: new Date(NOW).toISOString() },
      listAccessories: async () => {
        throw new Error("should not list");
      },
      setOff: async (id) => {
        calls.push(id);
      },
    });
    assert.equal(home.reason, "at-home");
    assert.deepEqual(calls, []);
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.reason, "at-home");
    assert.deepEqual(after.turnedOff, []);
    assert.equal(after.lastTurnedOffAt, saved.lastTurnedOffAt);
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
