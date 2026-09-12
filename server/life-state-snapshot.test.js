import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assembleLifeStateSnapshot,
  homeOccupancyKind,
  inferLunch,
  latestGymEntry,
  lastFromMeMessage,
  matchKnownPlace,
  overlappingCalendarEvents,
  rollupHome,
  summarizeScreenSessions,
} from "./life-state-snapshot.js";
import { parseDeviceContext, parseLocationPayload } from "./phone-location.js";

const HOME_FIX = {
  latitude: 47.7001,
  longitude: -122.2305,
  timestamp: "2026-09-11T21:10:00.000Z",
  source: "periodic",
  device: {
    batteryLevel: 81,
    charging: false,
    network: "wifi",
    audio: "speaker",
  },
};

const EPS_FIX = {
  latitude: 47.6436,
  longitude: -122.1988,
  timestamp: "2026-09-11T16:10:00.000Z",
  source: "ios",
};

describe("matchKnownPlace", () => {
  it("maps home and EPS coordinates", () => {
    const home = matchKnownPlace(47.7001, -122.2305);
    assert.equal(home.slug, "kirkland-home");
    const eps = matchKnownPlace(47.6436, -122.1988);
    assert.equal(eps.slug, "eastside-preparatory-school");
    assert.equal(matchKnownPlace(30.28, -97.74), null);
  });
});

describe("rollupHome", () => {
  const accessories = [
    { display_name: "Yan Overhead", room: "Yan’s Bedroom", category: "lightbulb", power: true },
    { display_name: "Office Desk", room: "Office", category: "lightbulb", power: true },
    { display_name: "Bath Fan", room: "Bathroom", category: "fan", power: true },
    { display_name: "Bath Lights", room: "Bathroom", category: "lightbulb", power: false },
    { name: "Bedroom Boolean", room: "Yan’s Bedroom", category: "outlet", power: false },
  ];

  it("treats fan-only bathroom as not showering lights", () => {
    const roll = rollupHome(accessories);
    assert.equal(roll.bathroomFanOn, true);
    assert.equal(roll.bathroomLightsOn, false);
    assert.equal(roll.bedroomLightsOn, true);
    assert.equal(roll.officeLightsOn, true);
    assert.equal(roll.bedroomBoolean, false);
    assert.equal(roll.lastMotionRoom, "office");
  });

  it("flags bathroom lights plus a recent on-event", () => {
    const withLights = accessories.map((a) =>
      a.display_name === "Bath Lights" ? { ...a, power: true } : a
    );
    const roll = rollupHome(withLights, {
      events: [
        {
          name: "Bath Lights",
          room: "Bathroom",
          at: "2026-09-11T21:08:00.000Z",
          characteristic: "power",
          value: true,
        },
      ],
    }, Date.parse("2026-09-11T20:50:00.000Z"));
    assert.equal(roll.bathroomLightsOn, true);
    assert.equal(roll.recentEvents.length, 1);
    assert.equal(roll.recentEvents[0].roomKind, "bathroom");
    assert.equal(roll.recentEvents[0].on, true);
  });

  it("reads Bathroom Boolean and Leaving Bath Bool as latches, not lights", () => {
    const roll = rollupHome([
      {
        name: "Bathroom Boolean",
        room: "Yan’s Bedroom",
        category: "outlet",
        power: true,
      },
      {
        name: "Leaving Bath Bool",
        room: "Yan’s Bedroom",
        category: "outlet",
        power: false,
      },
      {
        name: "Closet Main",
        room: "Yan’s Bedroom",
        category: "switch",
        power: true,
      },
    ]);
    assert.equal(roll.bathroomBoolean, true);
    assert.equal(roll.leavingBathBool, false);
    assert.equal(roll.closetLightsOn, true);
    assert.equal(roll.bedroomLightsOn, false);
    assert.equal(roll.bathroomLightsOn, false);
  });

  it("maps unique occupancy names and skips office middle plus duplicate Eve names", () => {
    assert.equal(homeOccupancyKind("New Bedroom Occupancy"), "bedroom");
    assert.equal(homeOccupancyKind("Bathroom Occupancy"), "bathroom");
    assert.equal(homeOccupancyKind("Closet Occupancy"), "closet");
    assert.equal(homeOccupancyKind("Office Sensor"), "office");
    assert.equal(homeOccupancyKind("Office Middle Sensor"), null);
    const roll = rollupHome([
      {
        name: "Bathroom Occupancy",
        room: "Yan’s Bedroom",
        category: "sensor",
        state: { occupancy_detected: true },
      },
      {
        name: "Office Sensor",
        room: "Yan’s Office",
        category: "sensor",
        state: { occupancy_detected: false },
      },
      {
        name: "Yan’s Bedroom Eve Motion",
        room: "Yan’s Bedroom",
        category: "sensor",
        state: { occupancy_detected: true },
      },
      {
        name: "Yan’s Bedroom Eve Motion",
        room: "Yan’s Bedroom",
        category: "sensor",
        state: { occupancy_detected: false },
      },
    ]);
    assert.equal(roll.occupancy.bathroom, true);
    assert.equal(roll.occupancy.office, false);
    assert.equal(roll.occupancy.bedroom, null);
  });

  it("reads Bedroom Boolean as last-motion, not a light", () => {
    const off = rollupHome([
      { name: "Bedroom Boolean", room: "Yan’s Bedroom", category: "outlet", power: false },
    ]);
    assert.equal(off.bedroomBoolean, false);
    assert.equal(off.lastMotionRoom, "office");
    assert.equal(off.bedroomLightsOn, false);
    const on = rollupHome([
      { name: "Bedroom Boolean", room: "Yan’s Bedroom", category: "outlet", power: true },
    ]);
    assert.equal(on.bedroomBoolean, true);
    assert.equal(on.lastMotionRoom, "bedroom");
    assert.equal(on.bedroomLightsOn, false);
  });
});

describe("inferLunch", () => {
  const today = [
    { name: "Data Science", start: "08:30", end: "09:40" },
    { name: "Free B", start: "09:55", end: "11:05", freePeriod: true },
    { name: "Adv Calc", start: "12:25", end: "13:35" },
  ];

  it("is lunch in the 11:05–12:25 gap", () => {
    const lunch = inferLunch({
      isSchoolDay: true,
      inClass: false,
      inFreePeriod: false,
      minutes: 11 * 60 + 20,
      todayClasses: today,
    });
    assert.equal(lunch.inLunch, true);
    assert.equal(lunch.start, "11:05");
    assert.equal(lunch.end, "12:25");
  });

  it("is not lunch during class", () => {
    const lunch = inferLunch({
      isSchoolDay: true,
      inClass: true,
      minutes: 12 * 60 + 30,
      todayClasses: today,
    });
    assert.equal(lunch.inLunch, false);
  });
});

describe("assembleLifeStateSnapshot", () => {
  it("prefers EPS GPS over home lights", () => {
    const snap = assembleLifeStateSnapshot({
      now: new Date("2026-09-11T16:10:00.000Z"),
      timeZone: "America/Los_Angeles",
      location: EPS_FIX,
      homeList: [
        { display_name: "Bath Lights", room: "Bathroom", category: "lightbulb", power: true },
      ],
      schedule: {
        isSchoolDay: true,
        inClass: true,
        minutes: 9 * 60 + 10,
        currentClass: { name: "Data Science", period: "A" },
        todayClasses: [{ name: "Data Science", start: "08:30", end: "09:40" }],
      },
      previous: [],
    });
    assert.equal(snap.location.knownPlace.slug, "eastside-preparatory-school");
    assert.equal(snap.home.bathroomLightsOn, true);
    assert.equal(snap.schedule.inClass, true);
  });

  it("marks stale GPS and keeps device context", () => {
    const snap = assembleLifeStateSnapshot({
      now: new Date("2026-09-12T06:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      location: HOME_FIX,
      homeList: [],
      schedule: { isSchoolDay: false, minutes: 23 * 60 },
    });
    assert.equal(snap.location.knownPlace.slug, "kirkland-home");
    assert.equal(snap.location.stale, true);
    assert.equal(snap.location.device.audio, "speaker");
    assert.equal(snap.location.device.batteryLevel, 81);
    assert.equal(snap.phoneIntent, null);
  });

  it("keeps a fresh phone-dock intent", () => {
    const snap = assembleLifeStateSnapshot({
      now: new Date("2026-09-12T06:00:00.000Z"),
      timeZone: "America/Los_Angeles",
      location: HOME_FIX,
      homeList: [],
      schedule: { isSchoolDay: false, minutes: 23 * 60 },
      phoneIntent: {
        kind: "going_to_sleep",
        orientation: "landscape",
        source: "shortcut",
        at: "2026-09-12T05:58:00.000Z",
      },
    });
    assert.equal(snap.phoneIntent.kind, "going_to_sleep");
    assert.equal(snap.phoneIntent.orientation, "landscape");
    assert.equal(snap.phoneSignals.going_to_sleep.kind, "going_to_sleep");
  });
});

describe("calendar / screen / imessage / gym helpers", () => {
  it("keeps overlapping timed events only", () => {
    const now = new Date("2026-09-11T22:20:00.000Z");
    const rows = overlappingCalendarEvents(
      [
        {
          title: "Debate",
          start: "2026-09-11T22:15:00.000Z",
          end: "2026-09-12T00:15:00.000Z",
        },
        {
          title: "All day",
          allDay: true,
          start: "2026-09-11",
        },
      ],
      now
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Debate");
  });

  it("summarizes recent screen sessions", () => {
    const rows = summarizeScreenSessions(
      [
        {
          name: "Cursor",
          device: "Mac Studio",
          minutes: 12,
          start: "2026-09-11T21:00:00.000Z",
          end: "2026-09-11T21:08:00.000Z",
        },
      ],
      Date.parse("2026-09-11T20:55:00.000Z")
    );
    assert.equal(rows[0].app, "Cursor");
  });

  it("returns last fromMe without text", () => {
    const row = lastFromMeMessage(
      [
        { fromMe: true, at: "2026-09-11T21:09:00.000Z", chat: "Alex", text: "secret" },
      ],
      Date.parse("2026-09-11T21:00:00.000Z")
    );
    assert.equal(row.chat, "Alex");
    assert.equal(row.text, undefined);
  });

  it("finds a recent gym entry", () => {
    const row = latestGymEntry(
      [
        { machine: "lat-pulldown", at: "2026-09-11T20:50:00.000Z" },
        { machine: "bench", at: "2026-09-10T20:50:00.000Z" },
      ],
      Date.parse("2026-09-11T20:30:00.000Z")
    );
    assert.equal(row.machine, "lat-pulldown");
  });
});

describe("parseDeviceContext", () => {
  it("keeps nested device on a GPS payload and ignores unknown keys", () => {
    const loc = parseLocationPayload({
      latitude: 47.7,
      longitude: -122.23,
      extra: "nope",
      device: {
        batteryLevel: 0.42,
        charging: true,
        network: "cellular",
        audio: "car",
        ssid: "HomeNet",
      },
    });
    assert.equal(loc.device.batteryLevel, 42);
    assert.equal(loc.device.audio, "car");
    assert.equal(loc.extra, undefined);
    const top = parseDeviceContext({
      batteryLevel: 80,
      charging: false,
      network: "wifi",
      audio: "headphones",
    });
    assert.equal(top.batteryLevel, 80);
    assert.equal(parseDeviceContext({ network: "ethernet" }), null);
  });
});
