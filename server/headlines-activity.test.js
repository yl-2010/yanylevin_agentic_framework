import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HEADLINES,
  claimHeadline,
  configureHeadlinesActivity,
  getHeadlineAssignment,
  listHeadlineAssignments,
} from "./headlines-activity.js";

const dirs = [];

async function freshFile() {
  const dir = await mkdtemp(join(tmpdir(), "headlines-"));
  dirs.push(dir);
  const path = join(dir, "assignments.json");
  configureHeadlinesActivity({
    assignmentsPath: path,
    wipeAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  return path;
}

afterEach(async () => {
  configureHeadlinesActivity({
    assignmentsPath: join(tmpdir(), "headlines-unused.json"),
    wipeAtMs: Date.parse("2099-01-01T00:00:00.000Z"),
  });
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("claimHeadline", () => {
  it("hands out Chauvin NYT first, then Fox, and reuses a name", async () => {
    await freshFile();
    const first = await claimHeadline("  Yan  ");
    assert.equal(first.headline, HEADLINES[0].headline);
    assert.equal(first.source, "New York Times");
    assert.equal(first.name, "Yan");
    assert.equal("voice" in first, false);

    const second = await claimHeadline("Sam");
    assert.equal(second.headline, HEADLINES[1].headline);
    assert.equal(second.source, "Fox News");

    const again = await claimHeadline("yan");
    assert.equal(again.headline, HEADLINES[0].headline);
    assert.equal(again.name, "Yan");
  });

  it("rejects a blank name and stops at 20", async () => {
    await freshFile();
    await assert.rejects(() => claimHeadline("   "), { status: 400 });
    for (let i = 0; i < HEADLINES.length; i += 1) {
      await claimHeadline(`s${i}`);
    }
    await assert.rejects(() => claimHeadline("extra"), { status: 409 });
  });
});

describe("wipe", () => {
  it("clears claims once, then keeps later class claims", async () => {
    const path = await freshFile();
    const wipeAt = Date.parse("2026-09-11T20:50:00.000Z");
    configureHeadlinesActivity({ assignmentsPath: path, wipeAtMs: wipeAt });
    await claimHeadline("Tester", wipeAt - 1000);
    const afterWipe = await listHeadlineAssignments(wipeAt);
    assert.deepEqual(afterWipe, []);
    const raw = JSON.parse(await readFile(path, "utf8"));
    assert.ok(raw.wipedAt);

    const classClaim = await claimHeadline("Class", wipeAt + 1000);
    assert.equal(classClaim.headline, HEADLINES[0].headline);
    const later = await listHeadlineAssignments(wipeAt + 60_000);
    assert.equal(later.length, 1);
    assert.equal(later[0].voice, "Active");
    assert.equal(later[0].event, "Chauvin verdict");
  });
});

describe("getHeadlineAssignment", () => {
  it("returns null after wipe", async () => {
    const path = await freshFile();
    const wipeAt = Date.parse("2026-09-11T20:50:00.000Z");
    configureHeadlinesActivity({ assignmentsPath: path, wipeAtMs: wipeAt });
    await claimHeadline("Yan", wipeAt - 1);
    assert.ok(await getHeadlineAssignment("Yan", wipeAt - 1));
    assert.equal(await getHeadlineAssignment("Yan", wipeAt), null);
  });
});
