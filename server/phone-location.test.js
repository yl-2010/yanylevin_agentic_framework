import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseLocationPayload,
  formatPhoneLocationLine,
  writePhoneLocation,
  readPhoneLocation,
  isYanLocationUser,
  isNearDuplicateLocation,
  appendLocationHistory,
  readLastHistoryEntry,
  hasUnprocessedLocationPoints,
  locationLogMonthKey,
} from "./phone-location.js";

describe("parseLocationPayload", () => {
  it("requires finite lat/lon in range", () => {
    assert.equal(parseLocationPayload(null), null);
    assert.equal(parseLocationPayload({ latitude: 47, longitude: "x" }), null);
    assert.equal(parseLocationPayload({ latitude: 91, longitude: -122 }), null);
  });

  it("keeps place fields and clips junk", () => {
    const loc = parseLocationPayload({
      latitude: 47.6812,
      longitude: -122.2086,
      accuracyMeters: 12.4,
      placeName: "Example School",
      locality: "Sample City",
      source: "ios",
      timestamp: "2026-08-15T17:00:00.000Z",
    });
    assert.equal(loc.latitude, 47.6812);
    assert.equal(loc.longitude, -122.2086);
    assert.equal(loc.accuracyMeters, 12);
    assert.equal(loc.placeName, "Example School");
    assert.equal(loc.source, "ios");
  });

  it("keeps motion fields and visit kind", () => {
    const loc = parseLocationPayload({
      latitude: 30.28,
      longitude: -97.74,
      speedMps: 12.34,
      courseDegrees: 181.26,
      altitudeMeters: 149.6,
      visitKind: "arrival",
      source: "visit",
    });
    assert.equal(loc.speedMps, 12.34);
    assert.equal(loc.courseDegrees, 181.3);
    assert.equal(loc.altitudeMeters, 150);
    assert.equal(loc.visitKind, "arrival");
    assert.equal(loc.source, "visit");
  });

  it("keeps periodic heartbeat source", () => {
    const loc = parseLocationPayload({
      latitude: 47.6812,
      longitude: -122.2086,
      source: "periodic",
    });
    assert.equal(loc.source, "periodic");
  });

  it("drops invalid speed and visit kind", () => {
    const loc = parseLocationPayload({
      latitude: 30.28,
      longitude: -97.74,
      speedMps: -1,
      visitKind: "hover",
    });
    assert.equal(loc.speedMps, undefined);
    assert.equal(loc.visitKind, undefined);
  });
});

describe("formatPhoneLocationLine", () => {
  it("returns null without a fix", () => {
    assert.equal(formatPhoneLocationLine(null), null);
  });

  it("includes place and coordinates", () => {
    const line = formatPhoneLocationLine({
      latitude: 47.6812,
      longitude: -122.2086,
      accuracyMeters: 15,
      locality: "Sample City",
      administrativeArea: "WA",
      timestamp: new Date().toISOString(),
    });
    assert.match(line, /Phone location:/);
    assert.match(line, /Sample City/);
    assert.match(line, /47\.6812/);
    assert.match(line, /±15 m/);
  });
});

describe("isYanLocationUser", () => {
  it("aliases iCloud onto Gmail", () => {
    assert.equal(isYanLocationUser("you@example.com"), true);
    assert.equal(isYanLocationUser("you@icloud.com"), true);
    assert.equal(isYanLocationUser("stranger@example.com"), false);
  });
});

describe("write/readPhoneLocation", () => {
  it("round-trips a fix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phone-loc-"));
    const path = join(dir, ".location.json");
    try {
      const saved = await writePhoneLocation(
        { latitude: 47.6, longitude: -122.2, source: "shortcut" },
        { source: "shortcut", path }
      );
      assert.equal(saved.latitude, 47.6);
      const read = await readPhoneLocation(path);
      assert.equal(read.longitude, -122.2);
      assert.equal(read.source, "shortcut");
      assert.ok(read.receivedAt);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("appends JSONL and skips near-duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "phone-hist-"));
    const path = join(dir, ".location.json");
    const historyDir = join(dir, "location");
    try {
      const ts = "2026-08-16T18:00:00.000Z";
      await writePhoneLocation(
        { latitude: 47.6, longitude: -122.2, timestamp: ts, source: "ios" },
        { path, historyDir }
      );
      const skipped = await appendLocationHistory(
        {
          latitude: 47.6,
          longitude: -122.2,
          timestamp: ts,
          receivedAt: "2026-08-16T18:00:10.000Z",
          source: "ios",
        },
        { historyDir }
      );
      assert.equal(skipped, false);
      await writePhoneLocation(
        {
          latitude: 47.61,
          longitude: -122.21,
          timestamp: "2026-08-16T18:10:00.000Z",
          source: "ios",
        },
        { path, historyDir }
      );
      const last = await readLastHistoryEntry(historyDir);
      assert.equal(last.latitude, 47.61);
      assert.equal(await hasUnprocessedLocationPoints(historyDir), true);
      await writeFile(
        join(historyDir, "state.json"),
        `${JSON.stringify({ lastProcessedReceivedAt: last.receivedAt }, null, 2)}\n`,
        "utf8"
      );
      assert.equal(await hasUnprocessedLocationPoints(historyDir), false);
      const month = locationLogMonthKey("2026-08-16T18:10:00.000Z");
      assert.equal(month, "2026-08");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isNearDuplicateLocation", () => {
  it("requires same coords and close timestamps", () => {
    const a = {
      latitude: 47.6,
      longitude: -122.2,
      timestamp: "2026-08-16T18:00:00.000Z",
    };
    assert.equal(
      isNearDuplicateLocation(a, {
        ...a,
        timestamp: "2026-08-16T18:00:30.000Z",
      }),
      true
    );
    assert.equal(
      isNearDuplicateLocation(a, {
        ...a,
        timestamp: "2026-08-16T18:02:00.000Z",
      }),
      false
    );
    assert.equal(
      isNearDuplicateLocation(a, {
        latitude: 47.61,
        longitude: -122.2,
        timestamp: a.timestamp,
      }),
      false
    );
  });
});
