import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zonedParts, addLocalDays } from "./calendar-cli.js";

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
