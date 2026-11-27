import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  encodeHomeRouteId,
  decodeHomeRouteId,
  recoverHomeHashSplit,
} from "./home-route-id.js";

describe("home route ids", () => {
  it("leaves plain slugs alone", () => {
    assert.equal(encodeHomeRouteId("spanish-4"), "spanish-4");
    assert.equal(decodeHomeRouteId("spanish-4"), "spanish-4");
    assert.equal(decodeHomeRouteId("HW%20Sep%2017%20Motion"), "HW Sep 17 Motion");
  });

  it("round-trips Finder names with #, accents, and spaces", () => {
    const id = "QA Sep 24 #1 ESCRITO AUDITIVO Otoño 2026";
    const enc = encodeHomeRouteId(id);
    assert.equal(enc.includes("#"), false);
    assert.equal(enc.includes("%"), false);
    assert.equal(decodeHomeRouteId(enc), id.normalize("NFC"));
  });

  it("keeps a drag from turning # into a URL fragment", () => {
    const href = `/home/todo/${encodeHomeRouteId(
      "QA Sep 24 #1 ESCRITO AUDITIVO Otoño 2026"
    )}?class=spanish-4`;
    const parsed = new URL(href, "https://yanylevin.com");
    assert.equal(parsed.hash, "");
    assert.equal(parsed.searchParams.get("class"), "spanish-4");
    assert.equal(
      decodeHomeRouteId(parsed.pathname.split("/").pop()),
      "QA Sep 24 #1 ESCRITO AUDITIVO Otoño 2026"
    );
  });

  it("rebuilds an old %23 drag that split on #", () => {
    const { id, params } = recoverHomeHashSplit(
      "QA Sep 24 ",
      new URLSearchParams(),
      "#1%20ESCRITO%20AUDITIVO%20Oto%C3%B1o%202026?class=spanish-4"
    );
    assert.equal(id, "QA Sep 24 #1 ESCRITO AUDITIVO Otoño 2026");
    assert.equal(params.get("class"), "spanish-4");
  });

  it("does not steal a normal #section hash", () => {
    const { id, params } = recoverHomeHashSplit(
      "essay",
      new URLSearchParams("class=am-lit"),
      "#notes"
    );
    assert.equal(id, "essay");
    assert.equal(params.get("class"), "am-lit");
  });
});
