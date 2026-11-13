/**
 * Push class Live Activity updates at each bell.
 * Runs in the agent worker, next to the other schedulers.
 */

import { sendLiveActivity } from "./apns.js";
import {
  LIVE_ACTIVITY_HANDOFF_MS,
  LIVE_ACTIVITY_MAX_MS,
  classActivitySnapshot,
  msUntilNextClassPush,
} from "./class-live-activity.js";
import { listPushAccounts, liveActivitiesFor, patchLiveActivity } from "./push-devices.js";

let stopped = false;
let started = false;
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

/**
 * @param {string} email
 * @param {object} row
 * @param {Awaited<ReturnType<typeof classActivitySnapshot>>} snap
 */
async function pushOne(email, row, snap) {
  const now = Date.now();
  const dayMismatch = Boolean(row.dayId && row.dayId !== snap.dayId && row.activityPushToken);
  const needsHandoff =
    !dayMismatch &&
    row.activityPushToken &&
    row.startedAt &&
    snap.lastBellUnix &&
    snap.lastBellUnix * 1000 - Number(row.startedAt) > LIVE_ACTIVITY_MAX_MS &&
    now - Number(row.startedAt) >= LIVE_ACTIVITY_HANDOFF_MS;

  if (dayMismatch) {
    const result = await sendLiveActivity({
      sandbox: Boolean(row.sandbox),
      token: row.activityPushToken,
      event: "end",
    });
    if (result.ok || result.unregistered) {
      await patchLiveActivity(email, row.deviceId, {
        activityPushToken: "",
        contentSig: "",
        pendingStartAt: 0,
        dayId: "",
        startedAt: 0,
      });
      row.activityPushToken = "";
      row.contentSig = "";
      row.pendingStartAt = 0;
      row.startedAt = 0;
      row.dayId = "";
    }
  }

  if (snap.phase === "end" && row.activityPushToken) {
    const result = await sendLiveActivity({
      sandbox: Boolean(row.sandbox),
      token: row.activityPushToken,
      event: "end",
    });
    if (result.ok || result.unregistered) {
      await patchLiveActivity(email, row.deviceId, {
        activityPushToken: "",
        contentSig: "",
        pendingStartAt: 0,
      });
    }
    return;
  }

  if (needsHandoff && row.activityPushToken) {
    const ended = await sendLiveActivity({
      sandbox: Boolean(row.sandbox),
      token: row.activityPushToken,
      event: "end",
    });
    if (ended.ok || ended.unregistered) {
      await patchLiveActivity(email, row.deviceId, {
        activityPushToken: "",
        contentSig: "",
        pendingStartAt: 0,
        startedAt: 0,
      });
      row.activityPushToken = "";
      row.contentSig = "";
      row.pendingStartAt = 0;
      row.startedAt = 0;
    }
  }

  if (snap.phase !== "show" || !snap.contentState) return;

  if (row.activityPushToken) {
    if (row.contentSig === snap.signature) return;
    const result = await sendLiveActivity({
      sandbox: Boolean(row.sandbox),
      token: row.activityPushToken,
      event: "update",
      contentState: snap.contentState,
      staleDate: snap.staleUnix,
    });
    if (result.ok) {
      await patchLiveActivity(email, row.deviceId, {
        contentSig: snap.signature,
        dayId: snap.dayId,
      });
    } else if (result.unregistered) {
      await patchLiveActivity(email, row.deviceId, {
        activityPushToken: "",
        contentSig: "",
      });
    }
    return;
  }

  if (!row.pushToStartToken) return;
  if (row.pendingStartAt && row.dayId === snap.dayId) return;
  const started = await sendLiveActivity({
    sandbox: Boolean(row.sandbox),
    token: row.pushToStartToken,
    event: "start",
    contentState: snap.contentState,
    attributes: { dayId: snap.dayId },
    staleDate: snap.staleUnix,
    alert: {
      title: snap.contentState.className || "Class",
      body: [snap.contentState.period, snap.contentState.start].filter(Boolean).join(" "),
    },
  });
  if (started.ok) {
    await patchLiveActivity(email, row.deviceId, {
      pendingStartAt: now,
      startedAt: now,
      contentSig: snap.signature,
      dayId: snap.dayId,
    });
  } else if (started.unregistered) {
    await patchLiveActivity(email, row.deviceId, { pushToStartToken: "" });
  }
}

async function tick() {
  const emails = await listPushAccounts();
  /** @type {number[]} */
  const waits = [];
  for (const email of emails) {
    try {
      const snap = await classActivitySnapshot(email);
      waits.push(msUntilNextClassPush(snap));
      const rows = await liveActivitiesFor(email);
      for (const row of rows) {
        if (!row.pushToStartToken && !row.activityPushToken) continue;
        await pushOne(email, row, snap);
      }
    } catch (err) {
      console.error("[class-live-activity]", email, err);
      waits.push(60_000);
    }
  }
  return waits.length ? Math.min(...waits) : 15 * 60 * 1000;
}

function schedule(delay) {
  if (stopped) return;
  clearTimer();
  const wait = Math.max(1000, delay);
  timer = setTimeout(() => {
    run().catch((err) => console.error("[class-live-activity]", err));
  }, wait);
  timer.unref?.();
}

async function run() {
  if (stopped) return;
  let delay = 60_000;
  try {
    delay = await tick();
  } catch (err) {
    console.error("[class-live-activity]", err);
  }
  schedule(delay);
}

export function startClassLiveActivityScheduler() {
  if (started) return;
  started = true;
  stopped = false;
  run().catch((err) => console.error("[class-live-activity]", err));
}
