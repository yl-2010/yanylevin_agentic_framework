// Regenerates brain/education/, the read-only mirror of Yan's classes, todos,
// dates, and projects, so the brain graph has a node for every education
// object. Source of truth stays in the education JSON files, which this
// script never touches. Wipes and rewrites the whole mirror on every run.
//
//   node server/brain-education-mirror.js            regenerate
//   node server/brain-education-mirror.js --dry-run  print what would be written

import fs from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { EDU_ROOT, BRAIN_ROOT, serializeFrontmatter } from "./brain-lib.js";
import { listTopLevelProjects } from "./onedrive-projects.js";
import { withCloudRetry, isTransientCloudError } from "./cloud-storage-io.js";
import { EDUCATION_META_DIR, gradeDirFromMeta, objectDirId } from "./education-onedrive.js";

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
async function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    if (dirHasEntries(path.dirname(filePath))) {
      warnings.push(`missing ${path.relative(EDU_ROOT, filePath)}, skipped`);
    }
    return null;
  }
  try {
    const text = await withCloudRetry(filePath, () => readFile(filePath, "utf8"));
    return JSON.parse(text);
  } catch (err) {
    if (isTransientCloudError(err)) {
      warnings.push(`unreadable ${path.relative(EDU_ROOT, filePath)}, skipped`);
      return null;
    }
    throw err;
  }
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("_example") && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

function listObjectDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && objectDirId(e.name) && !e.name.startsWith("_example"))
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

function objectJsonPath(dirPath, fileName) {
  const plain = String(fileName || "").replace(/^\.+/, "");
  const dotted = path.join(dirPath, `.${plain}`);
  if (fs.existsSync(dotted)) return dotted;
  const visible = path.join(dirPath, plain);
  if (fs.existsSync(visible)) return visible;
  return null;
}

async function readObjectJson(dirPath, fileName) {
  const filePath = objectJsonPath(dirPath, fileName);
  if (!filePath) return null;
  return readJson(filePath);
}

async function collectTodo({ slug, parentEdge, dirPath, sourceRel }) {
  const todo = await readObjectJson(dirPath, "todo.json");
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

async function collectDate({ slug, parentEdge, dirPath, sourceRel }) {
  const date = await readObjectJson(dirPath, "date.json");
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
async function collectChildren(stubs, parentDir, parentId, parentSlug, classFolder) {
  const todoParents = [];
  if (classFolder && classFolder !== parentDir) todoParents.push(classFolder);
  todoParents.push(path.join(parentDir, "todos"));
  const dateParents = [];
  if (classFolder && classFolder !== parentDir) dateParents.push(classFolder);
  dateParents.push(path.join(parentDir, "dates"));
  const seenTodos = new Set();
  const seenDates = new Set();
  for (const dir of todoParents) {
    for (const child of listObjectDirs(dir)) {
      const id = objectDirId(child);
      if (!id || seenTodos.has(id)) continue;
      const todoPath = objectJsonPath(path.join(dir, child), "todo.json");
      if (!todoPath) continue;
      seenTodos.add(id);
      stubs.push(
        await collectTodo({
          slug: `${parentSlug}--${id}`,
          parentEdge: { type: "part_of", to: parentId },
          dirPath: path.join(dir, child),
          sourceRel: path.relative(EDU_ROOT, todoPath),
        }),
      );
    }
  }
  for (const dir of dateParents) {
    for (const child of listObjectDirs(dir)) {
      const id = objectDirId(child);
      if (!id || seenDates.has(id)) continue;
      const datePath = objectJsonPath(path.join(dir, child), "date.json");
      if (!datePath) continue;
      seenDates.add(id);
      stubs.push(
        await collectDate({
          slug: `${parentSlug}--${id}`,
          parentEdge: { type: "part_of", to: parentId },
          dirPath: path.join(dir, child),
          sourceRel: path.relative(EDU_ROOT, datePath),
        }),
      );
    }
  }
}

async function collect() {
  const stubs = [];
  /** @type {Map<string, { slug: string, dirPath: string, source: string, cls: object }>} */
  const classes = new Map();

  for (const slug of listDirs(path.join(EDU_ROOT, "classes"))) {
    const dirPath = path.join(EDU_ROOT, "classes", slug);
    const cls = await readJson(path.join(dirPath, "class.json"));
    if (!cls) continue;
    classes.set(slug, {
      slug,
      dirPath,
      classFolder: dirPath,
      source: `classes/${slug}/class.json`,
      cls,
    });
  }

  const meta = (await readJson(path.join(EDU_ROOT, "meta.json"))) || {};
  const gradeDir = gradeDirFromMeta(meta);
  if (gradeDir && fs.existsSync(gradeDir)) {
    let names = [];
    try {
      names = fs.readdirSync(gradeDir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name || name === ".Trash") continue;
      const metaDir = path.join(gradeDir, name, EDUCATION_META_DIR);
      const objectDirs = [metaDir];
      if (fs.existsSync(metaDir)) {
        for (const child of listDirs(metaDir)) {
          if (child === "todos" || child === "dates") continue;
          objectDirs.push(path.join(metaDir, child));
        }
      }
      for (const dirPath of objectDirs) {
        const cls = await readJson(path.join(dirPath, "class.json"));
        if (!cls) continue;
        const slug = String(cls.id || "").trim();
        if (!slug) continue;
        const rel = path.relative(path.join(gradeDir, name), dirPath);
        classes.set(slug, {
          slug,
          dirPath,
          classFolder: path.join(gradeDir, name),
          source: `onedrive:${name}/${rel}/class.json`,
          cls,
        });
      }
    }
  }

  for (const { slug, dirPath, classFolder, source, cls } of classes.values()) {
    const periodField =
      cls.period && typeof cls.period === "object"
        ? cls.period
        : cls.period ?? null;
    stubs.push(
      stub({
        outPath: path.join(MIRROR_ROOT, "classes", `${slug}.md`),
        name: cls.name,
        kind: "education-class",
        source,
        fields: { period: periodField, trimester: cls.trimester ?? null },
      }),
    );
    await collectChildren(stubs, dirPath, `education/classes/${slug}`, slug, classFolder);
  }

  const skipMirror = new Set([
    "education",
    "prasham-education",
    "fitness",
    "tests",
    "yanylevin-backend",
    "_example-dummy",
  ]);
  for (const row of await listTopLevelProjects({ includeBackend: true })) {
    if (skipMirror.has(row.id) || row.props?.fixture === true) continue;
    stubs.push(
      stub({
        outPath: path.join(MIRROR_ROOT, "projects", `${row.id}.md`),
        name: row.props.name,
        kind: "education-project",
        source: `${row.dir}/project.json`,
        fields: { order: row.props.order ?? null, tier: row.tier },
      }),
    );
    await collectChildren(stubs, row.dir, `projects/${row.id}`, row.id);
  }

  for (const slug of listDirs(path.join(EDU_ROOT, "todos"))) {
    stubs.push(
      await collectTodo({
        slug,
        parentEdge: null,
        dirPath: path.join(EDU_ROOT, "todos", slug),
        sourceRel: `todos/${slug}/todo.json`,
      }),
    );
  }

  for (const slug of listDirs(path.join(EDU_ROOT, "dates"))) {
    stubs.push(
      await collectDate({
        slug,
        parentEdge: null,
        dirPath: path.join(EDU_ROOT, "dates", slug),
        sourceRel: `dates/${slug}/date.json`,
      }),
    );
  }

  return stubs.filter(Boolean);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const stubs = await collect();
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
