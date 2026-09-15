/**
 * Move Yan's education class trees into OneDrive (except _example-dummy).
 *
 *   node server/migrate-classes-to-onedrive.js
 *   node server/migrate-classes-to-onedrive.js --dry-run
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classObjectDir,
  gradeDirFromMeta,
  hiddenOnedriveFolderName,
} from "./education-onedrive.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = "you@example.com";
const EXISTING_FOLDERS = {
  physics: "H. Physics",
  "data-science-1": "A. Data Sci 1",
  "advanced-calculus": "C. Advanced Calc",
  "spanish-4": "D. Spanish 4",
  "us-history": "E. US History",
  "us-history-ws": "E. US History",
  "american-literature": "F. American Lit",
  "american-literature-ws": "F. American Lit",
  "pe-yoga": "G. PE Yoga",
};

async function movePath(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

function isMetaName(name) {
  const lower = String(name || "").toLowerCase();
  return (
    lower === "class.json" ||
    lower === "context.md" ||
    lower === "todos" ||
    lower === "dates"
  );
}

function folderForClass(classId, props) {
  return EXISTING_FOLDERS[classId] || hiddenOnedriveFolderName(props, classId);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = join(ROOT, "education", EMAIL);
  const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf8"));
  const gradeDir = gradeDirFromMeta(meta);
  if (!gradeDir) throw new Error("onedriveRoot/gradeFolder missing");

  const classRoot = join(root, "classes");
  const ids = (await readdir(classRoot)).filter(
    (id) => id && !id.startsWith("_example") && !id.startsWith(".")
  );

  for (const classId of ids) {
    const src = join(classRoot, classId);
    const st = await stat(src).catch(() => null);
    if (!st?.isDirectory()) continue;
    const props = JSON.parse(await readFile(join(src, "class.json"), "utf8"));
    const folder = folderForClass(classId, props);
    const classFolder = join(gradeDir, folder);
    let objectDir = classObjectDir(gradeDir, folder);
    let existing = null;
    try {
      existing = JSON.parse(await readFile(join(objectDir, "class.json"), "utf8"));
    } catch {
      existing = null;
    }
    if (existing?.id && existing.id !== classId) {
      objectDir = join(objectDir, classId);
    }
    console.log(
      `${classId} → ${folder}/.education${
        existing?.id && existing.id !== classId ? `/${classId}` : ""
      }`
    );
    if (dryRun) continue;

    await mkdir(objectDir, { recursive: true });
    const names = await readdir(src);
    for (const name of names) {
      if (name === ".DS_Store") continue;
      const destRoot = isMetaName(name) ? objectDir : classFolder;
      await movePath(join(src, name), join(destRoot, name));
    }

    const jsonPath = join(objectDir, "class.json");
    const next = {
      ...props,
      id: classId,
      onedriveFolder: folder,
    };
    await writeFile(jsonPath, JSON.stringify(next, null, 2) + "\n", "utf8");
    await rm(src, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
