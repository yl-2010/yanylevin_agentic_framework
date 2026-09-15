/**
 * Year-long History/Lit (no WS shells), todos/dates as siblings of .education,
 * class-root files moved into the todo they belong to, then Finder flags.
 *
 *   node server/migrate-class-object-layout.js
 *   node server/migrate-class-object-layout.js --dry-run
 */

import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gradeDirFromMeta } from "./education-onedrive.js";
import { syncOnedriveObjectVisibility } from "./education-onedrive-visibility.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EMAIL = "you@example.com";

const YEAR_LONG = {
  "us-history": {
    period: { fall: "F", winter: "E", spring: "E" },
    wsId: "us-history-ws",
  },
  "american-literature": {
    period: { fall: "E", winter: "F", spring: "F" },
    wsId: "american-literature-ws",
  },
};

/** Class-root leftovers → todo id (relative to the class folder). */
const FILE_MOVES = {
  "A. Data Sci 1": [
    ["cw personal infographic", "hw-personal-infographic"],
    ["RegionSales.csv", "cw-find-some-data-and-pull-out-something-interesting"],
    ["interesting dataset.pptx", "cw-find-some-data-and-pull-out-something-interesting"],
    ["youtube data practice.xlsx", "cw-find-some-data-and-pull-out-something-interesting"],
  ],
  "C. Advanced Calc": [
    ["CW excel practical.xlsx", "cw-excel-activity"],
    ["problem set 1.docx", "hw-problem-set-one"],
  ],
  "E. US History": [
    ["hw colonial gvt.docx", "hw-colonial-government-british-political-traditions"],
    ["chesepeake insta post.pptx", "hw-colonial-america-map-video"],
  ],
  "F. American Lit": [
    ["Letter to teacher.docx", "hw-introductory-letter-to-teacher"],
    ["Summer Reading.docx", "summer-reading-when-the-emperor-was-divine"],
    ["active vs passive.pptx", "cw-presentation"],
    ["group mla citation.pptx", "ma-american-dream-epigraphic-essay"],
  ],
  "H. Physics": [
    ["ball drop writeup.docx", "hw-average-speed-activity-write-up"],
    ["hw scans/hw1 avg speed.pdf", "hw-average-speed-measurement-initial-ideas"],
    ["hw scans/hw2 ping pong.pdf", "hw-ping-pong-vacuum-cannon-ws"],
    ["hw scans/hw3 motion diagrams.pdf", "hw-comparing-motion-diagrams"],
  ],
};

const HISTORY_CONTEXT = `# United States History: The American Question

**F fall · E winter and spring.** Bandel. TALI-202A. Same teacher, room, and OneDrive folder all year.

Not Gould. Alex Rivera is still Gould TALI-201A in E (his last Four11). Example Friend has Gould TALI-201A in F (same fall period, different section). Example Neighbor is McLane TALI-202A in E. Source: Four11 printed 09/01/26.

## OneNote (\`US History 26-27\`)

Same notebook all year. Fall collab space is \`Bandel F\`.

- Syllabus, Foner link, Chicago, AI policy, skills: \`_Content Library/Course Resources\`.
- Current unit (lessons, PPTs, primary sources, maps, HW prompts): \`_Content Library/I. Forming A Nation\`. Numbered \`1.3\` pages are the lesson. \`HW: ...\` pages are the assignment. The 13-colonies map is on \`HW: The British Colonies\`.
- Yan's filled copies (Crash Course notes, maps): \`Yan Levin/Homework\`.
- Later units II–IV and FINAL PROJECT are empty shells.
`;

const LIT_CONTEXT = `# American Literature

**E fall · F winter and spring.** Sundberg Lunstrum. TALI-202B. Same teacher, room, and OneDrive folder all year.

Period E Sundberg Lunstrum roster (Canvas 2026-09-02, 17 including Yan): Amanda Chickering, Anna Dumitrascu, Anika Kharche, Ben Sacson, Daniel(a) Shendure, Elaina Guan, Ellie Patel, Kaitlyn Bai, Mia Icev, Nathan Tareke, Paolo Contenti, Alex Rivera, Sonya Zhang, Tarek Rifaat, Thomas Diamantopoulos, Zoe Stone.

Fall Unit I (Formation of the American Dream): *When the Emperor Was Divine*, then *Death of a Salesman* (starts mid-September).

Alex is in this E section (shared Lit all year: E fall, F winter/spring). Example Neighbor is Fierce E. Example Friend is Fierce F. Source: Canvas 2026-09-02; Four11 printed 09/01/26.

## OneNote (\`Am. Lit\`)

- Day plan / in-class agenda: \`_Content Library/Tri 1-Investigation and Vision\` (\`Day 1 (9-2)\`, \`Day 2 (9-9)\`, \`Day 3 (9-11)\`). Also Emperor materials, class policies, the in-class diagnostic.
- Syllabus and grading: \`_Content Library/Course Resources\`.
- Thesis / claims / MLA: \`_Content Library/Writing Resources\`.
- Grammar presentation roster: \`_Content Library/Grammar Presentations\` → \`E Period Sundberg Lunstrum Presentations\`.
`;

async function movePath(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  try {
    await rename(src, dest);
  } catch (err) {
    if (err?.code === "EEXIST") {
      const name = src.split("/").pop();
      const alt = join(dirname(dest), `moved-${name}`);
      await movePath(src, alt);
      return;
    }
    if (err?.code !== "EXDEV") throw err;
    await cp(src, dest, { recursive: true });
    await rm(src, { recursive: true, force: true });
  }
}

async function pathKind(p) {
  try {
    const st = await stat(p);
    return st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
  } catch {
    return null;
  }
}

async function rmdirIfEmpty(dir) {
  try {
    const names = (await readdir(dir)).filter((n) => n !== ".DS_Store");
    if (!names.length) await rm(dir, { recursive: true, force: true });
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const root = join(ROOT, "education", EMAIL);
  const meta = JSON.parse(await readFile(join(root, "meta.json"), "utf8"));
  const gradeDir = gradeDirFromMeta(meta);
  if (!gradeDir) throw new Error("onedriveRoot/gradeFolder missing");

  const folderNames = (await readdir(gradeDir)).filter(
    (n) => n && n !== ".Trash" && n !== ".DS_Store"
  );

  for (const name of folderNames) {
    const classFolder = join(gradeDir, name);
    if ((await pathKind(classFolder)) !== "dir") continue;
    const metaDir = join(classFolder, ".education");
    if ((await pathKind(metaDir)) !== "dir") continue;

    const classJsonPath = join(metaDir, "class.json");
    let props = null;
    try {
      props = JSON.parse(await readFile(classJsonPath, "utf8"));
    } catch {
      continue;
    }
    const classId = String(props.id || "").trim();
    const year = YEAR_LONG[classId];
    if (year) {
      const wsDir = join(metaDir, year.wsId);
      console.log(`${classId}: year-long period map, drop ${year.wsId}`);
      if (!dryRun) {
        props.period = year.period;
        props.trimester = "year";
        await writeFile(classJsonPath, JSON.stringify(props, null, 2) + "\n", "utf8");
        const ctxName =
          classId === "us-history" ? HISTORY_CONTEXT : LIT_CONTEXT;
        await writeFile(join(metaDir, "CONTEXT.md"), ctxName, "utf8");
        await rm(wsDir, { recursive: true, force: true });
      }
    }

    for (const nested of ["todos", "dates"]) {
      const nestedDir = join(metaDir, nested);
      if ((await pathKind(nestedDir)) !== "dir") continue;
      const ids = (await readdir(nestedDir)).filter(
        (id) => id && !id.startsWith(".")
      );
      for (const id of ids) {
        const src = join(nestedDir, id);
        const dest = join(classFolder, id);
        console.log(`  ${nested}/${id} → ${name}/${id}`);
        if (dryRun) continue;
        if ((await pathKind(dest)) && dest !== src) {
          console.warn(`  skip, already at ${dest}`);
          continue;
        }
        await movePath(src, dest);
      }
      if (!dryRun) await rmdirIfEmpty(nestedDir);
    }

    for (const [rel, todoId] of FILE_MOVES[name] || []) {
      const src = join(classFolder, rel);
      if (!(await pathKind(src))) continue;
      const dest = join(classFolder, todoId, rel.split("/").pop());
      console.log(`  file ${rel} → ${todoId}/`);
      if (dryRun) continue;
      await movePath(src, dest);
    }
    if (!dryRun && name === "H. Physics") {
      await rmdirIfEmpty(join(classFolder, "hw scans"));
    }
  }

  if (dryRun) return;
  await syncOnedriveObjectVisibility(EMAIL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
