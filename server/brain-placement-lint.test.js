import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  lintIdentityText,
  lintIdentityPages,
} from "./brain-placement-lint.js";

describe("brain-placement-lint", () => {
  it("flags person facts on identity prose", () => {
    const hits = lintIdentityText(
      "identity.md",
      [
        "# Identity",
        "- Closest: Alex Rivera `people/alex-rivera`. (JYPE; spelling is Example Friend only).",
        "- Rajasi Saha (mom; never took Levin) `people/rajasi-saha`. Mail rajasi@hotmail.com.",
        "- Adi Levin, born 2015",
        "- Cell 425-555-0199",
      ].join("\n")
    );
    const reasons = hits.map((h) => h.reason).sort();
    assert.ok(reasons.includes("person-keyword"));
    assert.ok(reasons.includes("other-email"));
    assert.ok(reasons.includes("other-phone"));
  });

  it("allows Yan emails, Yan phone, and slug pointers", () => {
    const hits = lintIdentityText(
      "identity.md",
      [
        "- Yan Levin, 11th grade `people/alex-rivera`",
        "- School `owner@school.example`",
        "- Cell 555-0100",
      ].join("\n")
    );
    assert.deepEqual(hits, []);
  });

  it("current identity pages are clean", () => {
    const hits = lintIdentityPages();
    assert.deepEqual(
      hits,
      [],
      hits.map((h) => `${h.file}:${h.line} ${h.reason}`).join("\n")
    );
  });
});
