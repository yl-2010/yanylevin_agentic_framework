import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PUSH_CAP_PER_HOUR,
  dismissedSince,
  listDevices,
  notePushSent,
  recentPushCount,
  recordDismissed,
  registerDevice,
  upsertLiveActivity,
  liveActivitiesFor,
} from "./push-devices.js";

let dir = "";

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "push-devices-"));
  process.env.PUSH_DEVICES_PATH = join(dir, "push-devices.json");
});

after(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("push device store", () => {
  it("keeps one row per device and counts the hourly cap", async () => {
    const email = "push-test@example.com";
    await registerDevice(email, {
      deviceId: "phone-1",
      token: "ab".repeat(32),
      sandbox: true,
      idiom: "phone",
      name: "iPhone",
    });
    await registerDevice(email, {
      deviceId: "phone-1",
      token: "cd".repeat(32),
      sandbox: true,
      idiom: "phone",
    });
    const devices = await listDevices(email);
    assert.equal(devices.length, 1);
    assert.equal(devices[0].token, "cd".repeat(32));
    for (let i = 0; i < PUSH_CAP_PER_HOUR; i++) await notePushSent(email);
    assert.equal(await recentPushCount(email), PUSH_CAP_PER_HOUR);
  });

  it("records a dismiss for the other device and drops an ended activity token", async () => {
    const email = "push-test-2@example.com";
    await registerDevice(email, {
      deviceId: "pad-1",
      token: "11".repeat(32),
      sandbox: false,
      idiom: "pad",
    });
    await upsertLiveActivity(email, {
      deviceId: "pad-1",
      sandbox: false,
      pushToStartToken: "22".repeat(32),
      activityPushToken: "33".repeat(32),
      dayId: "school-day-2026-11-12",
    });
    const opened = await recordDismissed(email, "note-1", "phone-1");
    assert.equal(opened.devices.length, 1);
    assert.equal(opened.devices[0].deviceId, "pad-1");
    const listed = await dismissedSince(email, 0);
    assert.deepEqual(listed.ids, ["note-1"]);
    await upsertLiveActivity(email, { deviceId: "pad-1", sandbox: false, ended: true });
    const lives = await liveActivitiesFor(email);
    assert.equal(lives[0].activityPushToken, "");
    assert.equal(lives[0].pushToStartToken, "22".repeat(32));
  });
});
