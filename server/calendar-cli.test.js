import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zonedParts, addLocalDays } from "./calendar-cli.js";
import {
  eventsAreIdentical,
  findCreateBlock,
  loadAgentCreated,
  reconcileAgentCalendar,
  recordAgentEvent,
  tombstoneAgentEvent,
  tombstonesFromDeletedMarkdown,
} from "./calendar-memory.js";

describe("calendar-cli date helpers", () => {
  it("formats zoned date keys", () => {
    const p = zonedParts(new Date("2026-08-17T02:00:00.000Z"), "America/Chicago");
    assert.match(p.dateKey, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(p.hm, /^\d{2}:\d{2}$/);
  });

  it("adds calendar days on the UTC date key", () => {
    assert.equal(addLocalDays("2026-08-16", 1), "2026-08-17");
    assert.equal(addLocalDays("2026-08-31", 1), "2026-09-01");
  });
});

const dinner = {
  title: "Dinner with Sam",
  allDay: false,
  start: "2026-09-14T18:00:00.000Z",
  end: "2026-09-14T19:00:00.000Z",
  location: "Home",
  url: "https://meet.example/abc",
};

describe("calendar delete memory", () => {
  it("refuses an identical tombstone and allows a new time or link", () => {
    const block = findCreateBlock({
      candidate: dinner,
      tombstones: [{ ...dinner, id: "gone" }],
      liveEvents: [],
    });
    assert.equal(block.skipped, "deleted-identical");

    const moved = findCreateBlock({
      candidate: { ...dinner, start: "2026-09-14T20:00:00.000Z", end: "2026-09-14T21:00:00.000Z" },
      tombstones: [{ ...dinner, id: "gone" }],
      liveEvents: [],
    });
    assert.equal(moved, null);

    const linked = findCreateBlock({
      candidate: { ...dinner, url: "https://meet.example/new", location: "https://meet.example/new" },
      tombstones: [{ ...dinner, id: "gone" }],
      liveEvents: [],
    });
    assert.equal(linked, null);

    assert.equal(eventsAreIdentical(dinner, { ...dinner, title: "Dinner with Sam 2026" }), true);
  });

  it("refuses a live event at the same start and lets --force through", () => {
    const live = findCreateBlock({
      candidate: dinner,
      tombstones: [],
      liveEvents: [{ ...dinner, id: "live" }],
    });
    assert.equal(live.skipped, "already-on-calendar");
    const forced = findCreateBlock({
      candidate: dinner,
      tombstones: [{ ...dinner, id: "gone" }],
      liveEvents: [{ ...dinner, id: "live" }],
      force: true,
    });
    assert.equal(forced, null);
  });

  it("reads a deleted.md calendar row as a fingerprint", () => {
    const tombs = tombstonesFromDeletedMarkdown(
      "- deleted 2026-09-09 06:34 | calendar | Fall Media Day | on 2026-09-14 11:00 | Home | was ABC\n"
    );
    const block = findCreateBlock({
      candidate: {
        title: "Fall Media Day",
        allDay: false,
        start: "2026-09-14T18:00:00.000Z",
        end: "2026-09-14T19:00:00.000Z",
        location: "",
        url: "",
      },
      tombstones: tombs,
      liveEvents: [],
    });
    assert.equal(block.skipped, "deleted-identical");
    const later = findCreateBlock({
      candidate: {
        title: "Fall Media Day",
        allDay: false,
        start: "2026-09-14T20:00:00.000Z",
        end: "2026-09-14T21:00:00.000Z",
        location: "",
        url: "",
      },
      tombstones: tombs,
      liveEvents: [],
    });
    assert.equal(later, null);
  });

  it("tombstones a missing event only on the second miss", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-mem-"));
    const createdPath = join(dir, "created.jsonl");
    const tombstonePath = join(dir, "deleted.jsonl");
    const deletedMdPath = join(dir, "deleted.md");
    const statePath = join(dir, "state.json");
    try {
      await recordAgentEvent({ ...dinner, id: "ev-1", calendar: "Home" }, { createdPath });
      const paths = { createdPath, tombstonePath, deletedMdPath, statePath };
      const now = new Date("2026-09-14T17:00:00.000Z");
      const first = await reconcileAgentCalendar({
        ...paths,
        now,
        getEvent: async () => ({ ok: true, found: false }),
      });
      assert.equal(first.tombstoned, 0);
      const second = await reconcileAgentCalendar({
        ...paths,
        now,
        getEvent: async () => ({ ok: true, found: false }),
      });
      assert.equal(second.tombstoned, 1);
      const md = await readFile(deletedMdPath, "utf8");
      assert.match(md, /Dinner with Sam/);
      assert.match(md, /was ev-1/);
      const third = await reconcileAgentCalendar({
        ...paths,
        now,
        getEvent: async () => ({ ok: true, found: false }),
      });
      assert.equal(third.tombstoned, 0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refreshes a live edit and ignores a lookup error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cal-mem-"));
    const createdPath = join(dir, "created.jsonl");
    const tombstonePath = join(dir, "deleted.jsonl");
    const deletedMdPath = join(dir, "deleted.md");
    const statePath = join(dir, "state.json");
    try {
      await recordAgentEvent({ ...dinner, id: "ev-2", calendar: "Home" }, { createdPath });
      const edited = { ...dinner, id: "ev-2", start: "2026-09-14T21:00:00.000Z", calendar: "Home" };
      const now = new Date("2026-09-14T17:00:00.000Z");
      await reconcileAgentCalendar({
        createdPath,
        tombstonePath,
        deletedMdPath,
        statePath,
        now,
        getEvent: async () => ({ ok: true, found: true, event: edited }),
      });
      const rows = await loadAgentCreated({ createdPath });
      assert.equal(rows.find((row) => row.id === "ev-2").start, edited.start);
      await reconcileAgentCalendar({
        createdPath,
        tombstonePath,
        deletedMdPath,
        statePath,
        now,
        getEvent: async () => {
          throw new Error("calendar down");
        },
      });
      const md = await readFile(deletedMdPath, "utf8").catch(() => "");
      assert.equal(md.includes("ev-2"), false);
      await tombstoneAgentEvent({ ...dinner, id: "ev-9" }, "cli-delete", {
        tombstonePath,
        deletedMdPath,
      });
      await tombstoneAgentEvent({ ...dinner, id: "ev-9" }, "cli-delete", {
        tombstonePath,
        deletedMdPath,
      });
      const text = await readFile(deletedMdPath, "utf8");
      assert.equal(text.split("ev-9").length - 1, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
