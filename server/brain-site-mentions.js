// Journal mention edges for the /brain snapshot.
// A given name maps to one person. A parent card titled "Alex Rivera's dad"
// does not also own the word Alex. Names shared by two people stay unlinked.
// Longer non-person labels ("Alex's house") are matched first and do not
// also count as the person.

import { readFile, writeFile, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BRAIN_ROOT } from "./brain-lib.js";
import { YAN_BACKEND_DIR } from "./onedrive-projects.js";

const SNAPSHOT_PATH = join(YAN_BACKEND_DIR, "brain-site", "brain.json");
const JOURNAL_DIR = join(BRAIN_ROOT, "journal");

export function personMentionNames(nodes) {
  const owners = new Map();
  for (const node of nodes) {
    if (node.type !== "person") continue;
    const label = String(node.label || "");
    const names = [];
    const aliases = node.details?.aliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        const name = String(alias).trim();
        if (name.length >= 3 && !/\d/.test(name)) names.push(name);
      }
    }
    if (label && !label.includes("'s")) {
      const first = label.split(/\s+/)[0];
      if (first && first.length >= 3) names.push(first);
    }
    for (const name of names) {
      if (!owners.has(name)) owners.set(name, new Set());
      owners.get(name).add(node.id);
    }
  }
  const unique = new Map();
  for (const [name, ids] of owners) {
    if (ids.size === 1) unique.set(name, [...ids][0]);
  }
  return unique;
}

function maskLabels(text, labels) {
  let out = text;
  for (const label of labels) {
    if (!label || !out.includes(label)) continue;
    out = out.replaceAll(label, " ".repeat(label.length));
  }
  return out;
}

function countName(text, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  return text.match(re)?.length || 0;
}

/**
 * Add journal mention edges for people the original pass skipped.
 * People who already have a journal mention edge are left as they are.
 * Returns the number of edges added. Safe to run twice.
 */
export function linkMissingJournalMentions(snapshot, texts) {
  const names = personMentionNames(snapshot.nodes);
  const linked = new Set();
  for (const edge of snapshot.edges) {
    if (edge.relation === "mentions" && String(edge.source).startsWith("journal/")) {
      linked.add(edge.target);
    }
  }
  const pending = [...names.entries()].filter(([, id]) => !linked.has(id));
  if (!pending.length) return { added: 0, people: [] };

  const pendingNames = new Set(pending.map(([name]) => name));
  const masks = [...new Set(
    snapshot.nodes
      .filter((node) => node.type !== "person" && node.label && [...pendingNames].some((name) => node.label.includes(name)))
      .map((node) => node.label)
  )].sort((a, b) => b.length - a.length);

  const nodeIds = new Set(snapshot.nodes.map((node) => node.id));
  const byDay = new Map((snapshot.series?.journalByDay || []).map((row) => [row.date, row]));
  const degreeOf = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const people = new Map();
  let added = 0;

  for (const { date, text } of texts) {
    const source = `journal/${date}`;
    if (!nodeIds.has(source)) continue;
    const masked = maskLabels(text, masks);
    for (const [name, id] of pending) {
      const weight = countName(masked, name);
      if (!weight) continue;
      snapshot.edges.push({ source, target: id, relation: "mentions", weight });
      const sourceNode = degreeOf.get(source);
      const targetNode = degreeOf.get(id);
      if (sourceNode) sourceNode.degree = (sourceNode.degree || 0) + 1;
      if (targetNode) targetNode.degree = (targetNode.degree || 0) + 1;
      const row = byDay.get(date);
      if (row) row.mentions = (row.mentions || 0) + weight;
      people.set(id, (people.get(id) || 0) + weight);
      added += 1;
    }
  }

  if (added && snapshot.meta) {
    snapshot.meta.journalMentionsRelinkedAt = new Date().toISOString();
  }
  return {
    added,
    people: [...people.entries()].map(([id, weight]) => ({
      id,
      label: degreeOf.get(id)?.label || id,
      weight,
    })).sort((a, b) => b.weight - a.weight),
  };
}

export async function readJournalTexts(dir = JOURNAL_DIR) {
  const files = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name));
  return Promise.all(files.map(async (name) => ({
    date: name.slice(0, 10),
    text: await readFile(join(dir, name), "utf8"),
  })));
}

async function main() {
  const snapshotPath = process.argv[2] || SNAPSHOT_PATH;
  const raw = await readFile(snapshotPath, "utf8");
  const snapshot = JSON.parse(raw);
  const texts = await readJournalTexts();
  const result = linkMissingJournalMentions(snapshot, texts);
  const tmp = `${snapshotPath}.tmp`;
  await writeFile(tmp, JSON.stringify(snapshot));
  await rename(tmp, snapshotPath);
  console.log(`journal mention edges added: ${result.added}`);
  for (const person of result.people) {
    console.log(`  ${person.weight}\t${person.label}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
