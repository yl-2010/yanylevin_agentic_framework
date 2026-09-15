import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  gradeDirFromMeta,
  listClassObjectDirs,
  hiddenOnedriveFolderName,
  isSafeRelativePath,
  listOnedriveTree,
  matchOnedriveFolder,
  mergeContextFileLists,
  normalizeClassFolderName,
  onedriveNameScore,
  resolveOnedriveAbsolutePath,
} from "./education-onedrive.js";

describe("gradeDirFromMeta", () => {
  it("joins root and grade folder", () => {
    assert.equal(
      gradeDirFromMeta({
        onedriveRoot: "/Users/yan/OneDrive",
        gradeFolder: "11th Grade",
      }),
      join("/Users/yan/OneDrive", "11th Grade")
    );
  });

  it("returns null when unset or pathy", () => {
    assert.equal(gradeDirFromMeta({}), null);
    assert.equal(gradeDirFromMeta({ onedriveRoot: "/x", gradeFolder: "" }), null);
    assert.equal(
      gradeDirFromMeta({ onedriveRoot: "/x", gradeFolder: "../etc" }),
      null
    );
  });
});

describe("onedrive class name match", () => {
  const folders = [
    "A. Data Sci 1",
    "C. Advanced Calc",
    "D. Spanish 4",
    "E. US History",
    "F. American Lit",
    "G. PE Yoga",
    "H. Physics",
  ];

  it("normalizes aliases", () => {
    assert.equal(normalizeClassFolderName("F. American Lit"), "american lit");
    assert.equal(
      normalizeClassFolderName("United States History"),
      "us history"
    );
    assert.equal(normalizeClassFolderName("P.E. Yoga (US)"), "pe yoga us");
  });

  it("matches current 11th grade folders by name, not period", () => {
    assert.equal(
      matchOnedriveFolder({ name: "Physics", period: "H" }, folders),
      "H. Physics"
    );
    assert.equal(
      matchOnedriveFolder({ name: "Data Science 1", period: "A" }, folders),
      "A. Data Sci 1"
    );
    assert.equal(
      matchOnedriveFolder({ name: "Advanced Calculus", period: "C" }, folders),
      "C. Advanced Calc"
    );
    assert.equal(
      matchOnedriveFolder({ name: "Spanish 4", period: "D" }, folders),
      "D. Spanish 4"
    );
    assert.equal(
      matchOnedriveFolder(
        { name: "United States History", period: "F" },
        folders
      ),
      "E. US History"
    );
    assert.equal(
      matchOnedriveFolder(
        { name: "American Literature", period: "E" },
        folders
      ),
      "F. American Lit"
    );
    assert.equal(
      matchOnedriveFolder({ name: "P.E. Yoga (US)", period: "G" }, folders),
      "G. PE Yoga"
    );
  });

  it("lets onedriveFolder override", () => {
    assert.equal(
      matchOnedriveFolder(
        { name: "Physics", onedriveFolder: "C. Advanced Calc" },
        folders
      ),
      "C. Advanced Calc"
    );
  });

  it("skips free periods and unmatched names unless an explicit folder exists", () => {
    assert.equal(
      matchOnedriveFolder(
        { name: "Free Period", period: "B", freePeriod: true },
        folders
      ),
      null
    );
    assert.equal(
      matchOnedriveFolder({ name: "Independent Study", period: "A" }, folders),
      null
    );
    assert.equal(onedriveNameScore("Independent Study", "A. Data Sci 1"), 0);
    assert.equal(
      matchOnedriveFolder(
        {
          name: "Free Period",
          period: "A",
          freePeriod: true,
          onedriveFolder: ".Free Period A",
        },
        [".Free Period A", ...folders]
      ),
      ".Free Period A"
    );
  });
});

describe("hiddenOnedriveFolderName", () => {
  it("uses a leading-dot name for missing classes", () => {
    assert.equal(
      hiddenOnedriveFolderName({ name: "Independent Study" }, "independent-study"),
      ".Independent Study"
    );
    assert.equal(
      hiddenOnedriveFolderName({ freePeriod: true, period: "B" }, "free-period-b"),
      ".Free Period B"
    );
    assert.equal(
      hiddenOnedriveFolderName({}, "advanced-programming-ai-ml"),
      ".Advanced Programming AI-ML"
    );
  });
});

describe("listClassObjectDirs", () => {
  it("includes nested extra class folders", async () => {
    const grade = join(tmpdir(), `edu-class-dirs-${Date.now()}`);
    const nested = join(grade, "E. US History", ".education", "us-history-ws");
    await mkdir(nested, { recursive: true });
    await writeFile(join(grade, "E. US History", ".education", "class.json"), "{}");
    await writeFile(join(nested, "class.json"), "{}");
    await mkdir(join(grade, "E. US History", ".education", "todos"), {
      recursive: true,
    });
    const dirs = await listClassObjectDirs(grade, "E. US History");
    assert.deepEqual(
      dirs.map((d) => d.slice(grade.length)),
      [
        "/E. US History/.education",
        "/E. US History/.education/us-history-ws",
      ]
    );
    await rm(grade, { recursive: true, force: true });
  });
});

describe("isSafeRelativePath", () => {
  it("allows nested OneDrive names", () => {
    assert.equal(isSafeRelativePath("hw scans/hw1 avg speed.pdf"), "hw scans/hw1 avg speed.pdf");
    assert.equal(isSafeRelativePath("ball drop writeup.docx"), "ball drop writeup.docx");
  });

  it("rejects traversal and dotfiles", () => {
    assert.equal(isSafeRelativePath("../secret.pdf"), null);
    assert.equal(isSafeRelativePath("hw scans/../x.pdf"), null);
    assert.equal(isSafeRelativePath(".DS_Store"), null);
    assert.equal(isSafeRelativePath("/etc/passwd"), null);
  });
});

describe("listOnedriveTree", () => {
  /** @type {string} */
  let dir;

  it("setup", async () => {
    dir = join(tmpdir(), `edu-onedrive-${Date.now()}`);
    await mkdir(join(dir, "hw scans"), { recursive: true });
    await writeFile(join(dir, "notes.docx"), "doc");
    await writeFile(join(dir, "hw scans", "scan.pdf"), "pdf");
    await writeFile(join(dir, ".DS_Store"), "skip");
    await mkdir(join(dir, "todos", "hw-1"), { recursive: true });
    await writeFile(join(dir, "todos", "hw-1", "todo.json"), "{}");
    await mkdir(join(dir, ".education"), { recursive: true });
    await writeFile(join(dir, ".education", "class.json"), "{}");
    const t0 = new Date("2024-01-01T00:00:00Z");
    const t1 = new Date("2025-01-01T00:00:00Z");
    await utimes(join(dir, "notes.docx"), t0, t0);
    await utimes(join(dir, "hw scans"), t1, t1);
  });

  it("lists files and nested folders", async () => {
    const rows = await listOnedriveTree(dir);
    assert.deepEqual(
      rows.map((r) => r.name),
      ["hw scans", "notes.docx"]
    );
    assert.equal(rows[0].kind, "folder");
    assert.equal(rows[0].source, "onedrive");
    assert.equal(rows[0].path, "hw scans");
    assert.deepEqual(
      rows[0].files.map((f) => f.name),
      ["scan.pdf"]
    );
    assert.equal(rows[0].files[0].path, "hw scans/scan.pdf");
    assert.equal(rows[1].kind, "file");
    assert.equal(rows[1].path, "notes.docx");
  });

  it("cleanup", async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

describe("mergeContextFileLists", () => {
  it("keeps education files when names collide and sorts by mtime", () => {
    const merged = mergeContextFileLists(
      [
        {
          name: "notes.docx",
          mtime: "2024-06-01T00:00:00.000Z",
          source: "education",
        },
      ],
      [
        {
          name: "notes.docx",
          mtime: "2026-01-01T00:00:00.000Z",
          source: "onedrive",
          path: "notes.docx",
        },
        {
          name: "hw scans",
          kind: "folder",
          mtime: "2026-02-01T00:00:00.000Z",
          source: "onedrive",
        },
      ]
    );
    assert.deepEqual(
      merged.map((f) => `${f.source}:${f.name}`),
      ["onedrive:hw scans", "education:notes.docx"]
    );
  });
});

describe("resolveOnedriveAbsolutePath", () => {
  it("stays inside the class folder", () => {
    const dir = "/tmp/grade/H. Physics";
    assert.equal(
      resolveOnedriveAbsolutePath(dir, "hw scans/scan.pdf"),
      join(dir, "hw scans", "scan.pdf")
    );
    assert.throws(
      () => resolveOnedriveAbsolutePath(dir, "../outside.pdf"),
      /invalid file name/
    );
  });
});
