import test from "node:test";
import assert from "node:assert/strict";
import { linkMissingJournalMentions, personMentionNames } from "./brain-site-mentions.js";

function snapshot() {
  return {
    meta: {},
    nodes: [
      { id: "journal/2026-11-17", type: "journal", label: "2026-11-17", degree: 1 },
      { id: "people/alex-rivera", type: "person", label: "Alex Rivera", degree: 2, details: { aliases: ["Alex"] } },
      { id: "people/alex-rivera-dad", type: "person", label: "Alex Rivera's dad", degree: 1, details: { aliases: [] } },
      { id: "people/example-neighbor", type: "person", label: "Example Neighbor", degree: 1, details: { aliases: ["Example Neighbor"] } },
      { id: "people/example-neighbor-mom", type: "person", label: "Example Neighbor's mom", degree: 0, details: { aliases: [] } },
      { id: "people/example-friend", type: "person", label: "Example Friend", degree: 2, details: { aliases: ["Example Friend"] } },
      { id: "people/jayesh", type: "person", label: "Jayesh", degree: 0, details: { aliases: ["Jayesh"] } },
      { id: "people/jayesh-singhal", type: "person", label: "Jayesh Singhal", degree: 0, details: { aliases: ["Jayesh"] } },
      { id: "places/prashams-house", type: "place", label: "Alex's house", degree: 1 },
    ],
    edges: [
      { source: "journal/2026-11-17", target: "people/example-friend", relation: "mentions", weight: 4 },
      { source: "journal/2026-11-17", target: "places/prashams-house", relation: "mentions", weight: 1 },
    ],
    series: { journalByDay: [{ date: "2026-11-17", words: 20, mentions: 5 }] },
  };
}

const text = "Alex came by Alex's house. Example Neighbor stayed. Example Friend called. Jayesh waved.";

test("a parent card does not steal the given name", () => {
  const names = personMentionNames(snapshot().nodes);
  assert.equal(names.get("Alex"), "people/alex-rivera");
  assert.equal(names.get("Example Neighbor"), "people/example-neighbor");
  assert.equal(names.has("Jayesh"), false);
});

test("missing journal mentions attach to the person, not the house or the parent", () => {
  const data = snapshot();
  const result = linkMissingJournalMentions(data, [{ date: "2026-11-17", text }]);
  const prasham = data.edges.filter((edge) => edge.target === "people/alex-rivera");
  assert.equal(prasham.length, 1);
  assert.equal(prasham[0].weight, 1);
  assert.equal(prasham[0].relation, "mentions");
  const everette = data.edges.find((edge) => edge.target === "people/example-neighbor");
  assert.equal(everette.weight, 1);
  assert.equal(data.edges.some((edge) => edge.target === "people/alex-rivera-dad"), false);
  assert.equal(data.edges.some((edge) => edge.target === "people/jayesh"), false);
  const jeffery = data.edges.filter((edge) => edge.target === "people/example-friend");
  assert.equal(jeffery.length, 1);
  assert.equal(jeffery[0].weight, 4);
  assert.equal(data.series.journalByDay[0].mentions, 7);
  assert.equal(data.nodes.find((node) => node.id === "people/alex-rivera").degree, 3);
  assert.ok(result.added >= 2);
  const again = linkMissingJournalMentions(data, [{ date: "2026-11-17", text }]);
  assert.equal(again.added, 0);
});
