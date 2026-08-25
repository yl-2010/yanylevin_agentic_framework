// Regenerates brain/education/, the read-only mirror of Yan's classes, todos,
// dates, and projects, so the brain graph has a node for every education
// object. Source of truth stays in the education JSON files, which this
// script never touches. Wipes and rewrites the whole mirror on every run.
//
//   node server/brain-education-mirror.js            regenerate
//   node server/brain-education-mirror.js --dry-run  print what would be written

import fs from "node:fs";
import path from "node:path";
import { EDU_ROOT, BRAIN_ROOT, serializeFrontmatter } from "./brain-lib.js";

const MIRROR_ROOT = path.join(BRAIN_ROOT, "education");

const warnings = [];

function dirHasEntries(dirPath) {
  try {
    return fs.readdirSync(dirPath).length > 0;
  } catch {
    return false;
  }
}

// Empty leftover directories exist (e.g. a todo moved under a project). Skip
// those quietly. Warn only when the folder still has files but no properties json.
function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    if (dirHasEntries(path.dirname(filePath))) {
      warnings.push(`missing ${path.relative(EDU_ROOT, filePath)}, skipped`);
    }
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_example") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function stub({ outPath, name, kind, source, fields = {}, edges = [], description }) {
  const frontmatter = serializeFrontmatter({
    name,
    kind,
    ...fields,
    edges,
    source,
  });
  const body = [
    `# ${name}`,
    "",
    "GENERATED mirror of an education object (see brain/schema.md). Do not edit;",
    `source of truth is \`${source}\`.`,
  ];
  if (description) body.push("", description);
  return { outPath, text: frontmatter + "\n" + body.join("\n") + "\n" };
}

function collectTodo({ slug, parentEdge, dirPath, sourceRel }) {
  const todo = readJson(path.join(dirPath, "todo.json"));
  if (!todo) return null;
  return stub({
    outPath: path.join(MIRROR_ROOT, "todos", `${slug}.md`),
    name: todo.name,
    kind: "education-todo",
    source: sourceRel,
    fields: {
      tag: todo.tag ?? null,
      due_date: todo.dueDate ?? null,
      due_time: todo.dueTime ?? null,
      done: todo.done ?? false,
    },
    edges: parentEdge ? [parentEdge] : [],
    description: todo.description,
  });
}

function collectDate({ slug, parentEdge, dirPath, sourceRel }) {
  const date = readJson(path.join(dirPath, "date.json"));
  if (!date) return null;
  return stub({
    outPath: path.join(MIRROR_ROOT, "dates", `${slug}.md`),
    name: date.name,
    kind: "education-date",
    source: sourceRel,
    fields: {
      date: date.date ?? null,
      time: date.time ?? null,
    },
    edges: parentEdge ? [parentEdge] : [],
    description: date.description,
  });
}

// Todos/dates nested under a class or project get a `<parent>--<slug>` mirror
// slug so top-level and nested names cannot collide.
function collectChildren(stubs, parentDir, parentId, parentSlug) {
  for (const child of listDirs(path.join(parentDir, "todos"))) {
    stubs.push(
      collectTodo({
        slug: `${parentSlug}--${child}`,
        parentEdge: { type: "part_of", to: parentId },
        dirPath: path.join(parentDir, "todos", child),
        sourceRel: path.relative(EDU_ROOT, path.join(parentDir, "todos", child, "todo.json")),
      }),
    );
  }
  for (const child of listDirs(path.join(parentDir, "dates"))) {
    stubs.push(
      collectDate({
        slug: `${parentSlug}--${child}`,
        parentEdge: { type: "part_of", to: parentId },
        dirPath: path.join(parentDir, "dates", child),
        sourceRel: path.relative(EDU_ROOT, path.join(parentDir, "dates", child, "date.json")),
      }),
    );
  }
}

function collect() {
  const stubs = [];

  for (const slug of listDirs(path.join(EDU_ROOT, "classes"))) {
    const dirPath = path.join(EDU_ROOT, "classes", slug);
    const cls = readJson(path.join(dirPath, "class.json"));
    if (!cls) continue;
    stubs.push(
      stub({
        outPath: path.join(MIRROR_ROOT, "classes", `${slug}.md`),
        name: cls.name,
        kind: "education-class",
        source: `classes/${slug}/class.json`,
        fields: { period: cls.period ?? null, trimester: cls.trimester ?? null },
      }),
    );
    collectChildren(stubs, dirPath, `education/classes/${slug}`, slug);
  }

  for (const slug of listDirs(path.join(EDU_ROOT, "projects"))) {
    const dirPath = path.join(EDU_ROOT, "projects", slug);
    const project = readJson(path.join(dirPath, "project.json"));
    if (!project) continue;
    stubs.push(
      stub({
        outPath: path.join(MIRROR_ROOT, "projects", `${slug}.md`),
        name: project.name,
        kind: "education-project",
        source: `projects/${slug}/project.json`,
        fields: { order: project.order ?? null },
      }),
    );
    collectChildren(stubs, dirPath, `education/projects/${slug}`, slug);
  }

  for (const slug of listDirs(path.join(EDU_ROOT, "todos"))) {
    stubs.push(
      collectTodo({
        slug,
        parentEdge: null,
        dirPath: path.join(EDU_ROOT, "todos", slug),
        sourceRel: `todos/${slug}/todo.json`,
      }),
    );
  }

  for (const slug of listDirs(path.join(EDU_ROOT, "dates"))) {
    stubs.push(
      collectDate({
        slug,
        parentEdge: null,
        dirPath: path.join(EDU_ROOT, "dates", slug),
        sourceRel: `dates/${slug}/date.json`,
      }),
    );
  }

  return stubs.filter(Boolean);
}

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const stubs = collect();
  for (const w of warnings) console.warn(`warning: ${w}`);

  const counts = {};
  for (const s of stubs) {
    const type = path.relative(MIRROR_ROOT, s.outPath).split(path.sep)[0];
    counts[type] = (counts[type] || 0) + 1;
  }

  if (dryRun) {
    for (const s of stubs) console.log(path.relative(BRAIN_ROOT, s.outPath));
    console.log(`\nwould write ${stubs.length} stubs:`, counts);
    return;
  }

  fs.rmSync(MIRROR_ROOT, { recursive: true, force: true });
  for (const s of stubs) {
    fs.mkdirSync(path.dirname(s.outPath), { recursive: true });
    fs.writeFileSync(s.outPath, s.text);
  }
  console.log(`wrote ${stubs.length} education mirror stubs:`, counts);
}

main();
