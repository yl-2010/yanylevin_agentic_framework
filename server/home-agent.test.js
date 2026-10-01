import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FAMILY_VACUUM_DUE_MS,
  HOME_AGENT_INTERVAL_MS,
  HOME_AGENT_MODEL_SPEC,
  MASTER_VACUUM_SCENE,
  SUNNY_VACUUM_SCENE,
  VACUUM_CONFIRM_GRACE_MS,
  VACUUM_DUE_MS,
  VACUUM_SCENE,
  VACUUM_SCENE_FORBIDDEN,
  VACUUM_WARN_LEAD_MS,
  buildHomeAgentPrompt,
  buildVacuumConfirmPrompt,
  classifyLightsPresence,
  classifyVacuumLocation,
  familyVacuumWarningText,
  familyWarnWindowOpen,
  houseAsleepAt,
  homeAgentModelSpec,
  homeVacuumGate,
  isYanRoomLight,
  lightsPinMaxAgeMs,
  msUntilNextHomeAgentTick,
  pickVacuumZone,
  recordVacuumDeny,
  recordVacuumSkip,
  recordVacuumStart,
  recordVacuumWarn,
  warnFamilyVacuumZone,
  schoolInSessionAt,
  turnOffYanRoomLightsIfAway,
  vacuumConfirmPlan,
  vacuumIsDue,
  vacuumOverlapsFamilySleep,
  vacuumZonesFromState,
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
      "already-ran-today"
    );
    assert.equal(
      homeVacuumGate({
        nowMs: NOW,
        location: EPS,
        nextCheckAt: new Date(NOW + 60 * 60 * 1000).toISOString(),
      }).reason,
      "due"
    );
    assert.equal(
      homeVacuumGate({ nowMs: NOW, location: HOME, force: true }).reason,
      "force"
    );
    assert.equal(
      homeVacuumGate({ nowMs: NOW, location: HOME, force: true }).zone,
      "yan"
    );
  });
});

const SCHOOL = {
  timezone: "America/Los_Angeles",
  schoolStart: "2026-09-02",
  schoolEnd: "2027-06-11",
  closedDates: ["2026-09-18"],
  bells: [
    { slot: 1, start: "08:30", end: "09:40" },
    { slot: 4, start: "13:50", end: "15:00" },
  ],
};

describe("school session", () => {
  it("is open on a school-day afternoon and closed for the 15-minute tail", () => {
    assert.equal(schoolInSessionAt(NOW, SCHOOL), true);
    assert.equal(familyWarnWindowOpen(NOW, SCHOOL), true);

    const late = Date.parse("2026-09-25T21:50:00.000Z");
    assert.equal(schoolInSessionAt(late, SCHOOL), true);
    assert.equal(familyWarnWindowOpen(late, SCHOOL), false);

    const saturday = Date.parse("2026-09-26T17:00:00.000Z");
    assert.equal(schoolInSessionAt(saturday, SCHOOL), false);

    const closed = Date.parse("2026-09-18T17:00:00.000Z");
    assert.equal(schoolInSessionAt(closed, SCHOOL), false);
  });
});

describe("family sleep", () => {
  const tenPm = Date.parse("2026-09-26T05:00:00.000Z");
  const sixAm = Date.parse("2026-09-25T13:00:00.000Z");
  const sevenAm = Date.parse("2026-09-25T14:00:00.000Z");
  const eightPm = Date.parse("2026-09-26T03:00:00.000Z");
  const sixFifty = Date.parse("2026-09-26T01:50:00.000Z");

  it("blocks every zone from 7pm through 7am, including force", () => {
    assert.equal(houseAsleepAt(tenPm), true);
    assert.equal(houseAsleepAt(sixAm), true);
    assert.equal(houseAsleepAt(sevenAm), false);
    assert.equal(vacuumOverlapsFamilySleep(eightPm), true);
    assert.equal(vacuumOverlapsFamilySleep(sevenAm), false);

    const night = pickVacuumZone({
      nowMs: tenPm,
      dateKey: "2026-09-25",
      timeZone: "America/Los_Angeles",
      location: EPS,
      force: true,
      zones: {
        yan: { lastStartedAt: null },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
    });
    assert.equal(night.reason, "house-asleep");
    assert.equal(night.zone, null);

    const morning = pickVacuumZone({
      nowMs: sevenAm,
      dateKey: "2026-09-25",
      timeZone: "America/Los_Angeles",
      location: EPS,
      zones: {
        yan: { lastStartedAt: null },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
    });
    assert.equal(morning.zone, "yan");
  });

  it("still allows Yan just before 7pm, and blocks a family warning that would start after that", () => {
    assert.equal(vacuumOverlapsFamilySleep(sixFifty), false);
    assert.equal(vacuumOverlapsFamilySleep(sixFifty, "America/Los_Angeles", VACUUM_WARN_LEAD_MS), true);

    const yan = pickVacuumZone({
      nowMs: sixFifty,
      dateKey: "2026-09-25",
      timeZone: "America/Los_Angeles",
      location: EPS,
      zones: {
        yan: { lastStartedAt: null },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
    });
    assert.equal(yan.zone, "yan");

    const sunny = pickVacuumZone({
      nowMs: sixFifty,
      dateKey: "2026-09-25",
      timeZone: "America/Los_Angeles",
      location: EPS,
      familyWindowOpen: true,
      zones: {
        yan: { lastStartedAt: new Date(sixFifty - 24 * 60 * 60 * 1000).toISOString() },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
    });
    assert.equal(sunny.reason, "house-asleep");
  });
});

describe("vacuum zone priority", () => {
  const dayAgo = new Date(NOW - 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString();

  function pick(zones, extra = {}) {
    return pickVacuumZone({
      nowMs: NOW,
      dateKey: "2026-09-25",
      timeZone: "America/Los_Angeles",
      location: EPS,
      zones,
      ...extra,
    });
  }

  it("keeps a legacy Yan start on the Yan clock", () => {
    const zones = vacuumZonesFromState({
      lastStartedAt: "2026-09-29T16:00:17.936Z",
      scene: VACUUM_SCENE,
      reason: "school day",
    });
    assert.equal(zones.yan.lastStartedAt, "2026-09-29T16:00:17.936Z");
    assert.equal(zones.sunny.lastStartedAt, null);
    assert.equal(zones.master.lastStartedAt, null);
  });

  it("picks Yan at exactly 72 hours even when Sunny is also due", () => {
    const yanAt = new Date(NOW - VACUUM_DUE_MS).toISOString();
    const picked = pick(
      {
        yan: { lastStartedAt: yanAt },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true }
    );
    assert.equal(picked.zone, "yan");
    assert.equal(vacuumIsDue(yanAt, NOW), true);
    assert.equal(vacuumIsDue(new Date(NOW - VACUUM_DUE_MS + 1).toISOString(), NOW), false);
  });

  it("picks Sunny only inside the school window after a recent Yan run", () => {
    const open = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true }
    );
    assert.equal(open.zone, "sunny");

    const shut = pick({
      yan: { lastStartedAt: dayAgo },
      sunny: { lastStartedAt: null },
      master: { lastStartedAt: null },
    });
    assert.equal(shut.reason, "not-in-session");
  });

  it("picks master only after both earlier zones are still fresh", () => {
    const ready = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: twoDaysAgo },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true }
    );
    assert.equal(ready.zone, "master");

    const sunnyDue = new Date(NOW - FAMILY_VACUUM_DUE_MS).toISOString();
    const sunnyInstead = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: sunnyDue },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true }
    );
    assert.equal(sunnyInstead.zone, "sunny");
    assert.equal(vacuumIsDue(sunnyDue, NOW, FAMILY_VACUUM_DUE_MS), true);
    assert.equal(
      vacuumIsDue(new Date(NOW - FAMILY_VACUUM_DUE_MS + 1).toISOString(), NOW, FAMILY_VACUUM_DUE_MS),
      false
    );
  });

  it("blocks the rest of the day after a start, a warning, or a denial", () => {
    const started = pick(
      {
        yan: { lastStartedAt: new Date(NOW - 60 * 60 * 1000).toISOString() },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true }
    );
    assert.equal(started.reason, "already-ran-today");

    const pending = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      {
        familyWindowOpen: true,
        pending: {
          zone: "sunny",
          confirmAt: new Date(NOW + VACUUM_WARN_LEAD_MS).toISOString(),
        },
      }
    );
    assert.equal(pending.reason, "pending-confirm");

    const denied = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true, blockedDate: "2026-09-25" }
    );
    assert.equal(denied.reason, "denied-today");
  });

  it("does not let an earlier skip hold the next hour", () => {
    const held = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      {
        familyWindowOpen: true,
        nextCheckAt: new Date(NOW + 30 * 60 * 1000).toISOString(),
      }
    );
    assert.equal(held.zone, "sunny");
    assert.equal(held.reason, "due");
  });

  it("still warns Sunny when the phone is home", () => {
    const atHome = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true, location: HOME }
    );
    assert.equal(atHome.zone, "sunny");

    const noPin = pick(
      {
        yan: { lastStartedAt: dayAgo },
        sunny: { lastStartedAt: null },
        master: { lastStartedAt: null },
      },
      { familyWindowOpen: true, location: null }
    );
    assert.equal(noPin.zone, "sunny");
  });

  it("drops a confirm that missed the grace window", () => {
    const warnedAt = new Date(NOW - VACUUM_WARN_LEAD_MS - VACUUM_CONFIRM_GRACE_MS - 1000).toISOString();
    const plan = vacuumConfirmPlan(
      {
        zone: "sunny",
        confirmAt: new Date(Date.parse(warnedAt) + VACUUM_WARN_LEAD_MS).toISOString(),
      },
      NOW
    );
    assert.equal(plan.action, "drop");

    const soon = vacuumConfirmPlan(
      { zone: "master", confirmAt: new Date(NOW + 5 * 60 * 1000).toISOString() },
      NOW
    );
    assert.equal(soon.action, "wait");
    assert.equal(soon.delayMs, 5 * 60 * 1000);
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
    assert.match(prompt, /trigger --zone yan/);
  });

  it("warns for Sunny and does not trigger on that pass", () => {
    const prompt = buildHomeAgentPrompt({
      dateKey: "2026-09-25",
      timezone: "America/Los_Angeles",
      vacuumPath: "/tmp/vacuum.json",
      location: { ...EPS, timestamp: "2026-09-25T19:00:00.000Z", accuracyMeters: 12 },
      zone: "sunny",
    });
    assert.match(prompt, /Roomba Sunny Boy Landing Laundry Room/);
    assert.match(prompt, /Do not trigger the scene on this pass/);
    assert.match(prompt, /record-warn --zone sunny/);
    assert.match(prompt, /Someone being home is not a reason to skip/);
    assert.match(prompt, /Do not record a skip on this pass/);
    assert.match(prompt, /Levin-Saha Family/);
    assert.match(prompt, /Sent by Yan's Personal Agent/);
    assert.doesNotMatch(prompt, /trigger --zone sunny/);
    assert.doesNotMatch(prompt, /unlikely to be home within 2 hours/);
  });

  it("confirm pass starts on silence and acks a rejection", () => {
    const prompt = buildVacuumConfirmPrompt({
      dateKey: "2026-09-25",
      timezone: "America/Los_Angeles",
      vacuumPath: "/tmp/vacuum.json",
      zone: "master",
      warnedAt: "2026-09-25T18:00:00.000Z",
    });
    assert.match(prompt, /15-minute confirm/);
    assert.match(prompt, /Roomba Master Rooms/);
    assert.match(prompt, /Silence is a yes/);
    assert.match(prompt, /trigger --zone master/);
    assert.match(prompt, /record-deny/);
    assert.match(prompt, /clear-pending/);
    assert.match(prompt, /Send no iMessage/);
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
    const actionsPath = join(dir, "actions.jsonl");
    const calls = [];
    const away = await turnOffYanRoomLightsIfAway({
      path,
      actionsPath,
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
    const logged = await readFile(actionsPath, "utf8");
    assert.match(logged, /Turned off Desk Lamp/);
    assert.match(logged, /"agent":"home-agent"/);

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
    const still = await readFile(actionsPath, "utf8");
    assert.equal(still.trim().split("\n").length, 1);
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
    assert.equal(saved.zones.yan.lastStartedAt, "2026-09-22T18:00:00.000Z");
    assert.equal(saved.nextCheckAt, "2026-09-25T23:00:00.000Z");
    assert.equal(saved.skipReason, "back within 2 hours");
  });

  it("warns Sunny without moving Yan's start, then a denial blocks the day", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-"));
    const path = join(dir, "vacuum.json");
    await recordVacuumStart({
      path,
      at: "2026-09-22T18:00:00.000Z",
      reason: "yan rooms",
    });
    const warned = await recordVacuumWarn({
      path,
      zone: "sunny",
      at: "2026-09-25T18:00:00.000Z",
      reason: "school afternoon",
    });
    assert.equal(warned.lastStartedAt, "2026-09-22T18:00:00.000Z");
    assert.equal(warned.pending.zone, "sunny");
    assert.equal(warned.pending.scene, SUNNY_VACUUM_SCENE);
    assert.equal(
      Date.parse(warned.pending.confirmAt) - Date.parse(warned.pending.warnedAt),
      VACUUM_WARN_LEAD_MS
    );

    const denied = await recordVacuumDeny({
      path,
      at: "2026-09-25T18:15:00.000Z",
      reason: "mom said no",
      nextCheckAt: "2026-09-28T15:30:00.000Z",
    });
    assert.equal(denied.pending, undefined);
    assert.equal(denied.blockedDate, "2026-09-25");
    assert.equal(denied.zones.yan.lastStartedAt, "2026-09-22T18:00:00.000Z");
    assert.equal(denied.zones.sunny, undefined);
  });

  it("sends the family warning even when the last hour asked to wait", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-warn-"));
    const path = join(dir, "vacuum.json");
    await recordVacuumSkip({
      path,
      at: "2026-09-25T16:00:00.000Z",
      reason: "Michael likely home",
      nextCheckAt: "2026-09-25T17:30:00.000Z",
    });
    const sent = [];
    const warned = await warnFamilyVacuumZone({
      path,
      zone: "sunny",
      at: "2026-09-25T17:00:00.000Z",
      send: async (msg) => {
        sent.push(msg);
      },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "Levin-Saha Family");
    assert.equal(
      sent[0].text,
      "The Roomba starts in 15 minutes in Sunny's room, the landing, and the laundry room. Reply no if it should wait."
    );
    assert.equal(familyVacuumWarningText("master"), "The Roomba starts in 15 minutes in the master rooms. Reply no if it should wait.");
    assert.equal(warned.pending.zone, "sunny");
    assert.equal(warned.nextCheckAt, undefined);
    assert.equal(warned.skipReason, "Michael likely home");

    await assert.rejects(
      () =>
        warnFamilyVacuumZone({
          path,
          zone: "sunny",
          at: "2026-09-25T18:00:00.000Z",
          send: async () => {
            throw new Error("messages down");
          },
        }),
      /messages down/
    );
    const after = JSON.parse(await readFile(path, "utf8"));
    assert.equal(after.pending.warnedAt, "2026-09-25T17:00:00.000Z");
  });

  it("records a master start on its own clock and clears a pending warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-"));
    const path = join(dir, "vacuum.json");
    await recordVacuumStart({
      path,
      zone: "yan",
      at: "2026-09-22T18:00:00.000Z",
      reason: "yan rooms",
    });
    await recordVacuumWarn({
      path,
      zone: "master",
      at: "2026-09-25T18:00:00.000Z",
      reason: "school afternoon",
    });
    const started = await recordVacuumStart({
      path,
      zone: "master",
      at: "2026-09-25T18:15:00.000Z",
      reason: "no reply",
    });
    assert.equal(started.scene, MASTER_VACUUM_SCENE);
    assert.equal(started.lastStartedAt, "2026-09-25T18:15:00.000Z");
    assert.equal(started.zones.yan.lastStartedAt, "2026-09-22T18:00:00.000Z");
    assert.equal(started.zones.master.lastStartedAt, "2026-09-25T18:15:00.000Z");
    assert.equal(started.pending, undefined);
    assert.equal(VACUUM_SCENE_FORBIDDEN.includes("Rooms"), true);
  });

  it("refuses to record a start or a warning that runs into family sleep", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-"));
    const path = join(dir, "vacuum.json");
    await assert.rejects(
      () =>
        recordVacuumStart({
          path,
          at: "2026-09-26T05:00:00.000Z",
          reason: "night",
        }),
      /family sleep/
    );
    await assert.rejects(
      () =>
        recordVacuumWarn({
          path,
          zone: "sunny",
          at: "2026-09-26T01:50:00.000Z",
          reason: "too late",
        }),
      /family sleep/
    );
  });

  it("writes a vacuum start to the action log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "home-agent-actions-"));
    const path = join(dir, "vacuum.json");
    const actionsPath = join(dir, "actions.jsonl");
    await recordVacuumStart({
      path,
      actionsPath,
      at: "2026-09-22T18:00:00.000Z",
      zone: "yan",
      reason: "away until evening",
    });
    const raw = await readFile(actionsPath, "utf8");
    assert.match(raw, /Started Vacuum Yan/);
    assert.match(raw, /"kind":"vacuum"/);
    await recordVacuumSkip({
      path,
      at: "2026-09-25T20:00:00.000Z",
      reason: "back within 2 hours",
      nextCheckAt: "2026-09-25T23:00:00.000Z",
    });
    const afterSkip = await readFile(actionsPath, "utf8");
    assert.equal(afterSkip.trim().split("\n").length, 1);
  });
});
