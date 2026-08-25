// Zero-LLM entity card, the gbrain entity() equivalent. Assembles frontmatter
// fields, outgoing and incoming edges, available typed files, compiled truth,
// and the most recent timeline entries in one call.
//
//   node server/brain-entity-card.js alex-rivera
//   node server/brain-entity-card.js groups/jype
//   node server/brain-entity-card.js "Alex"          (name/alias lookup)

import { listEntities, edgesOf, splitTimeline } from "./brain-lib.js";

const TIMELINE_TAIL = 10;

function findEntity(entities, query) {
  const q = query.toLowerCase();
  return (
    entities.find((e) => e.id === q) ||
    entities.find((e) => e.id.split("/").pop() === q) ||
    entities.find((e) => e.name.toLowerCase() === q) ||
    entities.find((e) =>
      (Array.isArray(e.fields.aliases) ? e.fields.aliases : []).some(
        (a) => String(a).toLowerCase() === q,
      ),
    )
  );
}

function main() {
  const query = process.argv[2];
  if (!query) {
    console.error("usage: node server/brain-entity-card.js <slug|id|name|alias>");
    process.exit(2);
  }

  const { entities, problems } = listEntities();
  const entity = findEntity(entities, query);
  if (!entity) {
    console.error(`no entity matches ${JSON.stringify(query)}. Check people/index.md and skipped.md before creating one.`);
    process.exit(1);
  }

  const byId = new Map(entities.map((e) => [e.id, e]));
  const incoming = [];
  for (const other of entities) {
    for (const edge of edgesOf(other)) {
      if (edge.to === entity.id) incoming.push({ type: edge.type, from: other.id, name: other.name });
    }
  }

  const lines = [`# ${entity.name} (${entity.id}, ${entity.kind})`, ""];

  lines.push("## Fields");
  for (const [key, value] of Object.entries(entity.fields)) {
    if (key === "edges" || key === "name" || key === "kind" || value == null) continue;
    lines.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : value}`);
  }

  const out = edgesOf(entity);
  if (out.length || incoming.length) {
    lines.push("", "## Edges");
    for (const edge of out) {
      const target = byId.get(edge.to);
      lines.push(`- ${edge.type} -> ${edge.to}${target ? ` (${target.name})` : " (MISSING)"}`);
    }
    for (const edge of incoming) lines.push(`- ${edge.type} <- ${edge.from} (${edge.name})`);
  }

  if (entity.extraFiles?.length) {
    lines.push("", "## Typed files (Read only what the task needs)");
    for (const f of entity.extraFiles) lines.push(`- ${entity.id}/${f}`);
  }

  const { truth, timeline } = splitTimeline(entity.body);
  const truthText = truth.replace(/^#\s.*\n/, "").trim();
  if (truthText) lines.push("", "## Compiled truth", truthText);

  const entries = timeline.split("\n").filter((l) => l.startsWith("- "));
  if (entries.length) {
    lines.push("", `## Timeline (last ${Math.min(TIMELINE_TAIL, entries.length)} of ${entries.length})`);
    lines.push(...entries.slice(-TIMELINE_TAIL));
  }

  console.log(lines.join("\n"));
  for (const p of problems) console.error(`problem: ${p}`);
}

main();
