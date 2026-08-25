// Shared helpers for the brain entity graph (see brain/schema.md).
// Frontmatter contract: scalars bare, arrays/objects as one-line JSON,
// `edges:` as a block list of one-line JSON objects.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OWNER_EMAIL } from "./identity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(__dirname, "..");
export const EDU_ROOT = path.join(REPO_ROOT, "education", OWNER_EMAIL);
// BRAIN_ROOT env override exists for tests and dry-runs against scratch copies.
export const BRAIN_ROOT = process.env.BRAIN_ROOT || path.join(EDU_ROOT, "brain");

export const ENTITY_DIRS = [
  { kind: "person", dir: "people", folder: true },
  { kind: "group", dir: "groups", folder: false },
  { kind: "org", dir: "orgs", folder: false },
  { kind: "place", dir: "places", folder: false },
];

const GENERATED_FILES = new Set(["index.md", "graph.md", "skipped.md"]);

export function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return { fields: null, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { fields: null, body: text };
  const raw = text.slice(4, end);
  const body = text.slice(end + 5);
  const fields = {};
  const lines = raw.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!m) throw new Error(`bad frontmatter line: ${JSON.stringify(line)}`);
    const [, key, rawValue] = m;
    if (rawValue === "") {
      // Block list: consume following "- {...}" lines.
      const items = [];
      while (i < lines.length && lines[i].trimStart().startsWith("- ")) {
        items.push(parseScalar(lines[i].trimStart().slice(2).trim()));
        i += 1;
      }
      fields[key] = items;
    } else {
      fields[key] = parseScalar(rawValue);
    }
  }
  return { fields, body };
}

function parseScalar(value) {
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") || value.startsWith("{") || value.startsWith('"')) {
    return JSON.parse(value);
  }
  return value;
}

export function serializeFrontmatter(fields) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === "edges" && Array.isArray(value)) {
      if (!value.length) {
        lines.push("edges: []");
      } else {
        lines.push("edges:");
        for (const edge of value) lines.push(`  - ${JSON.stringify(edge)}`);
      }
    } else if (value === null) {
      lines.push(`${key}: null`);
    } else if (typeof value === "object") {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

export function slugify(name) {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readEntityFile(id, kind, filePath, problems) {
  const text = fs.readFileSync(filePath, "utf8");
  const { fields, body } = parseFrontmatterSafe(text, filePath, problems);
  if (!fields) return null;
  return {
    id,
    kind: fields.kind ?? kind,
    name: fields.name ?? id.split("/").pop(),
    filePath,
    fields,
    body,
  };
}

function parseFrontmatterSafe(text, filePath, problems) {
  try {
    const parsed = parseFrontmatter(text);
    if (!parsed.fields) {
      problems.push(`${filePath}: no frontmatter`);
    }
    return parsed;
  } catch (err) {
    problems.push(`${filePath}: ${err.message}`);
    return { fields: null, body: text };
  }
}

// Lists every entity in the brain (people, groups, orgs, places, education
// mirror). Files without valid frontmatter are reported in `problems`, not
// thrown, so one bad card cannot take the graph down.
export function listEntities() {
  const entities = [];
  const problems = [];

  for (const { kind, dir, folder } of ENTITY_DIRS) {
    const dirPath = path.join(BRAIN_ROOT, dir);
    if (!fs.existsSync(dirPath)) continue;
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || GENERATED_FILES.has(entry.name)) continue;
      if (folder && entry.isDirectory()) {
        const cardPath = path.join(dirPath, entry.name, "person.md");
        if (!fs.existsSync(cardPath)) {
          problems.push(`${path.join(dirPath, entry.name)}: folder without person.md`);
          continue;
        }
        const entity = readEntityFile(`${dir}/${entry.name}`, kind, cardPath, problems);
        if (entity) {
          entity.extraFiles = fs
            .readdirSync(path.join(dirPath, entry.name))
            .filter((f) => f.endsWith(".md") && f !== "person.md")
            .sort();
          entities.push(entity);
        }
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const id = `${dir}/${entry.name.replace(/\.md$/, "")}`;
        const entity = readEntityFile(id, kind, path.join(dirPath, entry.name), problems);
        if (entity) entities.push(entity);
      }
    }
  }

  const eduMirror = path.join(BRAIN_ROOT, "education");
  if (fs.existsSync(eduMirror)) {
    for (const filePath of walkMarkdown(eduMirror)) {
      const id = path.relative(BRAIN_ROOT, filePath).replace(/\.md$/, "");
      const entity = readEntityFile(id, "education", filePath, problems);
      if (entity) entities.push(entity);
    }
  }

  return { entities, problems };
}

function* walkMarkdown(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkMarkdown(full);
    else if (entry.name.endsWith(".md")) yield full;
  }
}

export function edgesOf(entity) {
  const edges = entity.fields?.edges;
  if (!Array.isArray(edges)) return [];
  return edges.filter((e) => e && typeof e === "object" && e.type && e.to);
}

// Splits an entity body at the timeline sentinel.
export function splitTimeline(body) {
  const sentinel = "<!-- timeline -->";
  const idx = body.indexOf(sentinel);
  if (idx === -1) return { truth: body, timeline: "" };
  return {
    truth: body.slice(0, idx),
    timeline: body.slice(idx + sentinel.length),
  };
}
