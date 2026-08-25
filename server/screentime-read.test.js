import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  APPLE_EPOCH_S,
  appInfo,
  dateKeyInTimeZone,
  defaultKnowledgeDb,
  deviceKind,
  deviceLabel,
  screenTimeSummary,
  summarizeUsage,
} from "./screentime-read.js";

const execFileAsync = promisify(execFile);

describe("screentime labels", () => {
  it("defaults to ~/Library/Application Support/Knowledge/knowledgeC.db", () => {
    const prev = process.env.SCREENTIME_DB_PATH;
    delete process.env.SCREENTIME_DB_PATH;
    try {
      assert.match(
        defaultKnowledgeDb(),
        /Library\/Application Support\/Knowledge\/knowledgeC\.db$/
      );
    } finally {
      if (prev != null) process.env.SCREENTIME_DB_PATH = prev;
    }
  });

  it("maps device models and null (this Mac) to Studio", () => {
    assert.equal(deviceLabel("iPhone15,3", "abc"), "iPhone");
    assert.equal(deviceLabel("Mac14,9", "abc"), "MacBook");
    assert.equal(deviceLabel("Mac15,14", "abc"), "Mac Studio");
    assert.equal(deviceLabel(null, null), "Mac Studio");
    assert.equal(deviceKind("iPhone"), "iphone");
    assert.equal(deviceKind("Mac Studio"), "studio");
  });

  it("names known bundles and falls back cleanly", () => {
    assert.deepEqual(appInfo("com.zhiliaoapp.musically"), {
      bundle: "com.zhiliaoapp.musically",
      name: "TikTok",
      category: "video",
    });
    assert.equal(appInfo("com.todesktop.230313mzl4w4u92").name, "Cursor");
    assert.equal(appInfo("com.example.FooBar").name, "FooBar");
  });
});

describe("screentime summarize", () => {
  it("buckets sessions by local day, device, and category", () => {
    const now = new Date("2026-08-17T18:00:00.000Z");
    const start = Date.parse("2026-08-16T02:00:00.000Z");
    const rows = [
      {
        startMs: start,
        endMs: start + 45 * 60 * 1000,
        bundle: "com.zhiliaoapp.musically",
        deviceId: "phone",
        model: "iPhone15,3",
      },
      {
        startMs: start + 60 * 60 * 1000,
        endMs: start + 90 * 60 * 1000,
        bundle: "com.todesktop.230313mzl4w4u92",
        deviceId: null,
        model: null,
      },
    ];
    const summary = summarizeUsage(rows, {
      timezone: "America/Chicago",
      now,
      lookbackDays: 7,
    });
    assert.equal(dateKeyInTimeZone(new Date(start), "America/Chicago"), "2026-08-15");
    const day = summary.days.find((d) => d.dateKey === "2026-08-15");
    assert.ok(day);
    const phone = day.devices.find((d) => d.name === "iPhone");
    const studio = day.devices.find((d) => d.name === "Mac Studio");
    assert.equal(phone.apps[0].name, "TikTok");
    assert.equal(phone.apps[0].minutes, 45);
    assert.equal(studio.apps[0].name, "Cursor");
    assert.ok(day.categories.some((c) => c.category === "video"));
    assert.ok(summary.weekTopApps.some((a) => a.name === "TikTok"));
  });
});

describe("screentime sqlite", () => {
  it("reads /app/usage from a fixture db", async () => {
    const dir = await mkdtemp(join(tmpdir(), "screentime-"));
    const db = join(dir, "knowledgeC.db");
    const startApple = Date.parse("2026-08-16T20:00:00.000Z") / 1000 - APPLE_EPOCH_S;
    const endApple = startApple + 600;
    try {
      await execFileAsync("sqlite3", [
        db,
        `
        CREATE TABLE ZOBJECT (
          Z_PK INTEGER PRIMARY KEY,
          ZSOURCE INTEGER,
          ZSTRUCTUREDMETADATA INTEGER,
          ZSTARTDATE TIMESTAMP,
          ZENDDATE TIMESTAMP,
          ZSTREAMNAME VARCHAR,
          ZVALUESTRING VARCHAR
        );
        CREATE TABLE ZSOURCE (Z_PK INTEGER PRIMARY KEY, ZDEVICEID VARCHAR);
        CREATE TABLE ZSYNCPEER (Z_PK INTEGER PRIMARY KEY, ZDEVICEID VARCHAR, ZMODEL VARCHAR);
        CREATE TABLE ZSTRUCTUREDMETADATA (
          Z_PK INTEGER PRIMARY KEY,
          Z_DKDIGITALHEALTHMETADATAKEY__WEBDOMAIN VARCHAR
        );
        INSERT INTO ZSOURCE VALUES (1, 'phone-id');
        INSERT INTO ZSYNCPEER VALUES (1, 'phone-id', 'iPhone15,3');
        INSERT INTO ZOBJECT VALUES (1, 1, NULL, ${startApple}, ${endApple}, '/app/usage', 'com.burbn.instagram');
        INSERT INTO ZSTRUCTUREDMETADATA VALUES (1, 'www.reddit.com');
        INSERT INTO ZOBJECT VALUES (2, 1, 1, ${startApple}, ${startApple + 180}, '/app/webUsage', 'com.apple.Safari');
        `,
      ]);
      const summary = await screenTimeSummary({
        db,
        days: 7,
        timezone: "America/Chicago",
        now: new Date("2026-08-17T18:00:00.000Z"),
      });
      assert.equal(summary.ok, true);
      const day = summary.days.find((d) => d.devices.some((dev) => dev.name === "iPhone"));
      assert.ok(day);
      assert.equal(day.devices[0].apps[0].name, "Instagram");
      assert.equal(summary.webDomains[0].domain, "www.reddit.com");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
