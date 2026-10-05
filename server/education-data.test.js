import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, utimes, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  contextFileListOpts,
  decodeEducationFileQuery,
  isSafeContextFileName,
  listContextFiles,
  parseHiddenFileNames,
  parseOrderedFileNames,
  parseVisibleFileNames,
  parseOrderedProjectPins,
  mergeCreateOpenedAt,
  sortEducationProjects,
  meetingHighlightStartMin,
  isMeetingHighlighted,
  activeMeetingAt,
  partitionClassTodos,
  siteFilesFromProps,
  loadClassScopedObjects,
  resolveLinkedTodoFile,
  stripTodoTagPrefix,
  uiPanelDateKeys,
  publicDebateCase,
} from "./education-data.js";

const require = createRequire(import.meta.url);
const {
  encodeEducationFileQueryValue,
  decodeEducationFileQueryValue,
} = require("../education/file-query.js");

describe("education file query", () => {
  const id = "HW Sep 24 STUDY GUIDE QA #1 ESCRITO AUDITIVO GUÍA DE ESTUDIO Otoño 2026";

  it("roundtrips folder names that contain #", () => {
    const enc = encodeEducationFileQueryValue(id);
    assert.equal(enc.includes("#"), false);
    assert.equal(decodeEducationFileQueryValue(enc), id);
    assert.equal(encodeEducationFileQueryValue("spanish-4"), "spanish-4");
    assert.equal(encodeEducationFileQueryValue("image-57b18e43.png"), "image-57b18e43.png");
  });

  it("keeps a dragged link from splitting on #", () => {
    const q = new URLSearchParams();
    q.set("scope", "todo");
    q.set("name", "image-57b18e43-adb7-4bd1-b40c-8cc412a38c18.png");
    q.set("id", encodeEducationFileQueryValue(id));
    q.set("classId", "spanish-4");
    const url = new URL(`https://yanylevin.com/api/education/file?${q}`);
    assert.equal(url.hash, "");
    const decoded = decodeEducationFileQuery({
      scope: url.searchParams.get("scope"),
      name: url.searchParams.get("name"),
      id: url.searchParams.get("id"),
      classId: url.searchParams.get("classId"),
    });
    assert.equal(decoded.id, id);
    assert.equal(decoded.classId, "spanish-4");
  });
});

describe("parseHiddenFileNames", () => {
  it("returns empty set when hiddenFiles is absent", () => {
    assert.deepEqual([...parseHiddenFileNames({})], []);
    assert.deepEqual([...parseHiddenFileNames(null)], []);
  });

  it("keeps valid basenames lowercase", () => {
    const names = parseHiddenFileNames({
      hiddenFiles: ["worksheet.pdf", "Notes.md"],
    });
    assert.equal(names.size, 2);
    assert.ok(names.has("worksheet.pdf"));
    assert.ok(names.has("notes.md"));
  });

  it("rejects dotfiles and property JSON names", () => {
    const names = parseHiddenFileNames({
      hiddenFiles: [".secret", "todo.json", "../evil", "ok.txt"],
    });
    assert.deepEqual([...names], ["ok.txt"]);
  });
});

describe("parseVisibleFileNames", () => {
  it("parses visibleFiles lowercase", () => {
    const names = parseVisibleFileNames({
      visibleFiles: ["CONTEXT.md", ".secret"],
    });
    assert.deepEqual([...names], ["context.md"]);
  });
});

describe("listContextFiles hiddenNames", () => {
  /** @type {string} */
  let dir;

  it("setup temp folder", async () => {
    dir = await mkdtemp(join(tmpdir(), "edu-context-"));
    await writeFile(join(dir, "visible.pdf"), "a");
    await writeFile(join(dir, "hidden.pdf"), "b");
    await writeFile(join(dir, "also-visible.txt"), "c");
    await writeFile(join(dir, ".dotfile"), "d");
    await writeFile(join(dir, "todo.json"), "{}");
    await writeFile(join(dir, "CONTEXT.md"), "model notes");
    await writeFile(join(dir, "deleted.md"), "# Manually deleted\n");
  });

  it("lists safe files and hides context.md by default", async () => {
    const files = await listContextFiles(dir);
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("omits names in hiddenNames", async () => {
    const files = await listContextFiles(dir, {
      hiddenNames: parseHiddenFileNames({ hiddenFiles: ["hidden.pdf"] }),
    });
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "visible.pdf"]
    );
  });

  it("ignores invalid hiddenFiles entries", async () => {
    const files = await listContextFiles(dir, {
      hiddenNames: parseHiddenFileNames({
        hiddenFiles: ["hidden.pdf", ".secret", "missing.doc"],
      }),
    });
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "visible.pdf"]
    );
  });

  it("shows context.md when listed in visibleFiles", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ visibleFiles: ["CONTEXT.md"] })
    );
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["CONTEXT.md", "also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("lets visibleFiles override hiddenFiles", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        hiddenFiles: ["hidden.pdf"],
        visibleFiles: ["hidden.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name).sort(),
      ["also-visible.txt", "hidden.pdf", "visible.pdf"]
    );
  });

  it("cleanup", async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

describe("parseOrderedFileNames", () => {
  it("keeps first-occurrence order and skips junk", () => {
    assert.deepEqual(
      parseOrderedFileNames(["Z.pdf", "a.txt", "Z.PDF", ".dot", "todo.json", "a.txt"]),
      ["z.pdf", "a.txt"]
    );
  });

  it("returns empty when absent", () => {
    assert.deepEqual(parseOrderedFileNames(undefined), []);
    assert.deepEqual(parseOrderedFileNames(null), []);
  });
});

describe("listContextFiles pin order", () => {
  /** @type {string} */
  let dir;

  it("setup temp folder with known mtimes", async () => {
    dir = await mkdtemp(join(tmpdir(), "edu-pins-"));
    await writeFile(join(dir, "old.pdf"), "a");
    await writeFile(join(dir, "mid.pdf"), "b");
    await writeFile(join(dir, "new.pdf"), "c");
    await writeFile(join(dir, "hidden.pdf"), "d");
    const t0 = new Date("2024-01-01T00:00:00Z");
    const t1 = new Date("2024-06-01T00:00:00Z");
    const t2 = new Date("2024-12-01T00:00:00Z");
    const t3 = new Date("2025-01-01T00:00:00Z");
    await utimes(join(dir, "old.pdf"), t0, t0);
    await utimes(join(dir, "mid.pdf"), t1, t1);
    await utimes(join(dir, "new.pdf"), t2, t2);
    await utimes(join(dir, "hidden.pdf"), t3, t3);
  });

  it("defaults to newest mtime first", async () => {
    const files = await listContextFiles(dir);
    assert.deepEqual(
      files.map((f) => f.name),
      ["hidden.pdf", "new.pdf", "mid.pdf", "old.pdf"]
    );
  });

  it("pins filesTop above mtime order", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesTop: ["old.pdf", "new.pdf"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "new.pdf", "hidden.pdf", "mid.pdf"]
    );
  });

  it("pins filesBottom below mtime order", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesBottom: ["new.pdf", "old.pdf"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["hidden.pdf", "mid.pdf", "new.pdf", "old.pdf"]
    );
  });

  it("puts unpinned files between top and bottom", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        filesTop: ["old.pdf"],
        filesBottom: ["new.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "hidden.pdf", "mid.pdf", "new.pdf"]
    );
  });

  it("lets filesTop win when a name is in both lists", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        filesTop: ["new.pdf"],
        filesBottom: ["new.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["new.pdf", "hidden.pdf", "mid.pdf", "old.pdf"]
    );
  });

  it("skips missing names and matches case-insensitively", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({ filesTop: ["missing.doc", "OLD.PDF"] })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "hidden.pdf", "new.pdf", "mid.pdf"]
    );
  });

  it("does not show a hidden file just because it is pinned", async () => {
    const files = await listContextFiles(
      dir,
      contextFileListOpts({
        hiddenFiles: ["hidden.pdf"],
        filesTop: ["hidden.pdf", "old.pdf"],
      })
    );
    assert.deepEqual(
      files.map((f) => f.name),
      ["old.pdf", "new.pdf", "mid.pdf"]
    );
  });

  it("cleanup", async () => {
    await rm(dir, { recursive: true, force: true });
  });
});

describe("isSafeContextFileName", () => {
  it("rejects dotfiles", () => {
    assert.equal(isSafeContextFileName(".notes.pdf"), null);
  });
});

describe("siteFilesFromProps", () => {
  it("turns sites[] into kind url tiles", () => {
    const files = siteFilesFromProps({
      sites: [
        { name: "QA #1", url: "https://yanylevin.com/spanish4/fall-qa-1/" },
        { title: "dup", href: "https://yanylevin.com/spanish4/fall-qa-1/" },
        { name: "skip", url: "ftp://nope.example" },
        {
          name: "problem set one",
          url: "https://example.com/p1",
          clientUrl: "onenote:https://example.com/p1",
          oneNote: "personal",
          pageId: "p1",
        },
        "nope",
      ],
    });
    assert.deepEqual(files, [
      {
        name: "QA #1",
        kind: "url",
        source: "site",
        url: "https://yanylevin.com/spanish4/fall-qa-1/",
        webUrl: "https://yanylevin.com/spanish4/fall-qa-1/",
        webViewUrl: "https://yanylevin.com/spanish4/fall-qa-1/",
      },
      {
        name: "problem set one",
        kind: "url",
        source: "site",
        url: "https://example.com/p1",
        webUrl: "https://example.com/p1",
        webViewUrl: "https://example.com/p1",
        officeUri: "onenote:https://example.com/p1",
      },
    ]);
  });

  it("returns empty when sites is missing", () => {
    assert.deepEqual(siteFilesFromProps({}), []);
    assert.deepEqual(siteFilesFromProps(null), []);
  });
});

describe("listContextFiles url tiles", () => {
  it("treats link json and .url shortcuts as kind url", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-url-"));
    await writeFile(
      join(dir, "qa-1.json"),
      JSON.stringify({
        kind: "url",
        name: "QA #1 Study Guide",
        url: "https://yanylevin.com/spanish4/fall-qa-1/",
      })
    );
    await writeFile(
      join(dir, "notes.url"),
      "[InternetShortcut]\nURL=https://yanylevin.com/notes/\n"
    );
    await writeFile(join(dir, "worksheet.pdf"), "bytes");
    await writeFile(join(dir, "random.json"), JSON.stringify({ hello: "world" }));
    const files = await listContextFiles(dir);
    const qa = files.find((f) => f.url === "https://yanylevin.com/spanish4/fall-qa-1/");
    const notes = files.find((f) => f.url === "https://yanylevin.com/notes/");
    const pdf = files.find((f) => f.name === "worksheet.pdf");
    const random = files.find((f) => f.name === "random.json");
    assert.equal(qa?.kind, "url");
    assert.equal(qa?.name, "QA #1 Study Guide");
    assert.equal(notes?.kind, "url");
    assert.equal(notes?.name, "notes");
    assert.equal(pdf?.kind, "file");
    assert.equal(random?.kind, "file");
    await rm(dir, { recursive: true, force: true });
  });
});

describe("listContextFiles office open", () => {
  it("attaches SharePoint URLs to Office files only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "edu-office-"));
    await writeFile(join(dir, "quotes.html"), "<h1>q</h1>");
    await writeFile(join(dir, "notes.docx"), "doc");
    const web =
      "https://contoso-my.sharepoint.com/personal/yan_contoso_org/Documents";
    const files = await listContextFiles(dir, {
      onedriveRoot: dir,
      onedriveWebRoot: web,
    });
    const html = files.find((f) => f.name === "quotes.html");
    const docx = files.find((f) => f.name === "notes.docx");
    assert.equal(html.webUrl, undefined);
    assert.equal(html.officeUri, undefined);
    assert.equal(docx.webUrl, `${web}/notes.docx`);
    assert.equal(docx.webViewUrl, `${web}/notes.docx?web=1`);
    assert.equal(docx.officeUri, `ms-word:ofe|u|${web}/notes.docx`);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("linkedFiles", () => {
  /** @type {string} */
  let classDir;
  const maId = "MA Oct 7 Essay";
  const cwId = "CW Oct 6 Prep";
  const web =
    "https://contoso-my.sharepoint.com/personal/yan_contoso_org/Documents";

  it("setup class todos", async () => {
    classDir = await mkdtemp(join(tmpdir(), "edu-linked-"));
    const maDir = join(classDir, `.${maId}`);
    const cwDir = join(classDir, cwId);
    await mkdir(maDir);
    await mkdir(cwDir);
    await writeFile(join(maDir, "essay.docx"), "doc");
    await writeFile(join(maDir, "prep.pdf"), "pdf-bytes");
    await writeFile(join(maDir, "secret.docx"), "secret");
    await writeFile(join(maDir, "local.docx"), "ma-local-longer");
    await writeFile(
      join(maDir, ".todo.json"),
      JSON.stringify({
        name: "Essay",
        tag: "MA",
        canvasId: "40000000",
        hiddenFiles: ["secret.docx"],
        sites: [
          {
            name: "essay notes",
            url: "https://example.com/p1",
            clientUrl: "onenote:https://example.com/p1",
            oneNote: "personal",
            pageId: "p1",
          },
          {
            name: "Content Library: prep",
            url: "https://example.com/p2",
            clientUrl: "onenote:https://example.com/p2",
            oneNote: "content-library",
            pageId: "p2",
          },
        ],
      })
    );
    await writeFile(join(cwDir, "worksheet.txt"), "own");
    await writeFile(join(cwDir, "local.docx"), "cw");
    await writeFile(
      join(cwDir, ".todo.json"),
      JSON.stringify({
        name: "Prep",
        tag: "CW",
        canvasId: "40000001",
        sites: [
          {
            name: "essay notes",
            url: "https://example.com/p1",
            clientUrl: "onenote:https://example.com/p1",
            oneNote: "personal",
            pageId: "p1",
          },
        ],
        linkedFiles: [
          { todo: "MA Oct 1 Old Title", canvasId: "40000000", name: "essay.docx" },
          { todo: maId, canvasId: "40000000", name: "missing.docx" },
          { todo: maId, canvasId: "40000000", name: "secret.docx" },
          { todo: maId, canvasId: "40000000", name: "local.docx" },
          { todo: maId, canvasId: "40000000", name: "prep.pdf" },
          { todo: maId, canvasId: "40000000", pageId: "p1" },
          { todo: maId, canvasId: "40000000", pageId: "p2" },
          { todo: maId, canvasId: "40000000", pageId: "gone" },
        ],
      })
    );
  });

  it("shows the sibling Word file and OneNote page on the CW", async () => {
    const todos = await loadClassScopedObjects(
      { id: "american-literature", objectDir: classDir, classFolder: classDir },
      "todo",
      {
        includeFixtures: true,
        classId: "american-literature",
        officeOpen: { onedriveRoot: classDir, onedriveWebRoot: web },
      }
    );
    const ma = todos.find((t) => t.id === maId);
    const cw = todos.find((t) => t.id === cwId);
    const maEssay = ma.files.find((f) => f.name === "essay.docx");
    const cwEssay = cw.files.find((f) => f.name === "essay.docx");
    const names = cw.files.map((f) => f.name);
    assert.equal(cw._objectDir, undefined);
    assert.ok(names.indexOf("worksheet.txt") < names.indexOf("essay.docx"));
    assert.equal(names.filter((n) => n === "local.docx").length, 1);
    assert.equal(cw.files.find((f) => f.name === "local.docx").size, 2);
    assert.equal(names.includes("missing.docx"), false);
    assert.equal(names.filter((n) => n === "essay notes").length, 1);
    assert.equal(cwEssay.officeUri, maEssay.officeUri);
    assert.equal(cwEssay.officeUri, `ms-word:ofe|u|${maEssay.webUrl}`);
    const secret = cw.files.find((f) => f.name === "secret.docx");
    assert.equal(secret.officeUri, `ms-word:ofe|u|${secret.webUrl}`);
    assert.match(secret.officeUri, /^ms-word:ofe\|u\|/);
    const prepPage = cw.files.find((f) => f.name === "Content Library: prep");
    assert.equal(prepPage.kind, "url");
    assert.equal(prepPage.officeUri, "onenote:https://example.com/p2");
    assert.equal(cw.files.some((f) => f.name === "gone"), false);
    const pdf = cw.files.find((f) => f.name === "prep.pdf");
    assert.equal(pdf.kind, "file");
    assert.equal(pdf.officeUri, undefined);
  });

  it("downloads the CW link from the MA folder", async () => {
    const pdf = await resolveLinkedTodoFile(classDir, cwId, "prep.pdf");
    assert.equal(pdf.name, "prep.pdf");
    assert.equal(pdf.path, join(classDir, `.${maId}`, "prep.pdf"));
    const own = await resolveLinkedTodoFile(classDir, cwId, "local.docx");
    assert.equal(own, null);
    const missing = await resolveLinkedTodoFile(classDir, cwId, "missing.docx");
    assert.equal(missing, null);
  });

  it("cleanup", async () => {
    await rm(classDir, { recursive: true, force: true });
  });
});

describe("sortEducationProjects", () => {
  it("parses projectsTop names lowercase and skips paths", () => {
    assert.deepEqual(
      parseOrderedProjectPins(["PathIvy", "pathivy", "../x", "ϵStore"]),
      ["pathivy", "ϵstore"]
    );
  });

  it("puts newest lastOpened first", () => {
    const sorted = sortEducationProjects(
      [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
        { id: "c", name: "Gamma" },
      ],
      {
        openedAt: {
          a: "2026-08-01T00:00:00.000Z",
          c: "2026-08-20T00:00:00.000Z",
        },
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["c", "a", "b"]
    );
  });

  it("keeps leftover order among never-opened projects", () => {
    const sorted = sortEducationProjects([
      { id: "debate", name: "Debate", order: 4 },
      { id: "yanylevin", name: "YanYLevin", order: 1 },
      { id: "estore", name: "ϵStore", order: 3 },
    ]);
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["yanylevin", "estore", "debate"]
    );
  });

  it("pins projectsTop above recency, projectsBottom below", () => {
    const sorted = sortEducationProjects(
      [
        { id: "pathivy", name: "PathIvy" },
        { id: "estore", name: "ϵStore" },
        { id: "debate", name: "Debate" },
        { id: "sockethr", name: "ExampleCo" },
      ],
      {
        projectsTop: ["PathIvy"],
        projectsBottom: ["debate"],
        openedAt: {
          estore: "2026-08-29T00:00:00.000Z",
          sockethr: "2026-08-20T00:00:00.000Z",
        },
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["pathivy", "estore", "sockethr", "debate"]
    );
  });

  it("matches pins by folder id or name, case-insensitive", () => {
    const sorted = sortEducationProjects(
      [
        { id: "estore", name: "ϵStore" },
        { id: "jype-frontier-cascadia", name: "JYPE - Frontier Cascadia" },
      ],
      {
        projectsTop: ["ESTORE"],
        projectsBottom: ["JYPE - Frontier Cascadia"],
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["estore", "jype-frontier-cascadia"]
    );
  });

  it("lets projectsTop win when a name is in both lists", () => {
    const sorted = sortEducationProjects(
      [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
      {
        projectsTop: ["b"],
        projectsBottom: ["b", "a"],
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["b", "a"]
    );
  });

  it("skips missing pin names", () => {
    const sorted = sortEducationProjects(
      [{ id: "a", name: "Alpha", order: 2 }],
      { projectsTop: ["gone", "Alpha"], projectsBottom: ["also-gone"] }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["a"]
    );
  });

  it("puts a create timestamp above leftover order, below projectsTop", () => {
    const sorted = sortEducationProjects(
      [
        { id: "old", name: "Old", order: 1 },
        { id: "fresh", name: "Fresh" },
        { id: "pinned", name: "Pinned" },
      ],
      {
        projectsTop: ["pinned"],
        openedAt: { fresh: "2026-08-30T00:00:00.000Z" },
      }
    );
    assert.deepEqual(
      sorted.map((p) => p.id),
      ["pinned", "fresh", "old"]
    );
  });
});

describe("mergeCreateOpenedAt", () => {
  it("fills birthtime for new projects that have no leftover order", () => {
    const merged = mergeCreateOpenedAt(
      { clicked: "2026-08-01T00:00:00.000Z" },
      [
        { id: "clicked", _birthMs: 1 },
        { id: "fresh", _birthMs: Date.parse("2026-08-30T12:00:00.000Z") },
        { id: "legacy", order: 2, _birthMs: Date.parse("2026-08-30T12:00:00.000Z") },
      ]
    );
    assert.equal(merged.clicked, "2026-08-01T00:00:00.000Z");
    assert.equal(merged.fresh, "2026-08-30T12:00:00.000Z");
    assert.equal(merged.legacy, undefined);
  });
});

describe("class highlight lead", () => {
  const defaultDay = [
    { period: "A", startMin: 8 * 60 + 30, endMin: 9 * 60 + 40 },
    { period: "B", startMin: 9 * 60 + 55, endMin: 11 * 60 + 5 },
    { period: "C", startMin: 12 * 60 + 25, endMin: 13 * 60 + 35 },
    { period: "D", startMin: 13 * 60 + 50, endMin: 15 * 60 },
  ];
  const ahDay = [
    { period: "A", startMin: 9 * 60 + 10, endMin: 9 * 60 + 40 },
    { period: "B", startMin: 9 * 60 + 50, endMin: 10 * 60 + 20 },
    { period: "C", startMin: 10 * 60 + 30, endMin: 11 * 60 },
    { period: "D", startMin: 11 * 60 + 10, endMin: 11 * 60 + 40 },
    { period: "E", startMin: 11 * 60 + 45, endMin: 12 * 60 + 15 },
    { period: "F", startMin: 13 * 60 + 5, endMin: 13 * 60 + 35 },
  ];

  it("highlights the first period 10 minutes before 08:30", () => {
    assert.equal(meetingHighlightStartMin(defaultDay, 0), 8 * 60 + 20);
    assert.equal(activeMeetingAt(defaultDay, 8 * 60 + 20)?.period, "A");
    assert.equal(activeMeetingAt(defaultDay, 8 * 60 + 19), null);
  });

  it("uses a 10-minute lead on 15-minute passing", () => {
    assert.equal(meetingHighlightStartMin(defaultDay, 1), 9 * 60 + 45);
    assert.equal(isMeetingHighlighted(defaultDay, 0, 9 * 60 + 40), false);
    assert.equal(activeMeetingAt(defaultDay, 9 * 60 + 44), null);
    assert.equal(activeMeetingAt(defaultDay, 9 * 60 + 45)?.period, "B");
  });

  it("highlights after lunch for 10 minutes, not the whole lunch", () => {
    assert.equal(meetingHighlightStartMin(defaultDay, 2), 12 * 60 + 15);
    assert.equal(activeMeetingAt(defaultDay, 11 * 60 + 5), null);
    assert.equal(activeMeetingAt(defaultDay, 12 * 60 + 14), null);
    assert.equal(activeMeetingAt(defaultDay, 12 * 60 + 15)?.period, "C");
  });

  it("uses the whole passing period when it is under 10 minutes", () => {
    assert.equal(meetingHighlightStartMin(ahDay, 4), 11 * 60 + 40);
    assert.equal(activeMeetingAt(ahDay, 11 * 60 + 40)?.period, "E");
    assert.equal(isMeetingHighlighted(ahDay, 3, 11 * 60 + 40), false);
  });
});

describe("stripTodoTagPrefix", () => {
  it("drops HW:/CW:/QA:/MA: prefixes", () => {
    assert.equal(stripTodoTagPrefix("HW: Signed Syllabus"), "Signed Syllabus");
    assert.equal(stripTodoTagPrefix("CW: Presentation"), "Presentation");
    assert.equal(stripTodoTagPrefix("QA: Constitution Quiz"), "Constitution Quiz");
    assert.equal(stripTodoTagPrefix("MA: Final Exam"), "Final Exam");
  });

  it("keeps the rest after a tag plus space", () => {
    assert.equal(stripTodoTagPrefix("MA #F2: Forces & Graphs of Motion"), "#F2: Forces & Graphs of Motion");
    assert.equal(stripTodoTagPrefix("MA Final: Presentación oral"), "Final: Presentación oral");
  });

  it("leaves titles without a tag prefix alone", () => {
    assert.equal(stripTodoTagPrefix("Summer Read"), "Summer Read");
    assert.equal(stripTodoTagPrefix(""), "");
  });
});

describe("partitionClassTodos", () => {
  it("keeps ordinary todos on home and splits hiddenFromHome", () => {
    const { home, classOnly } = partitionClassTodos([
      { id: "essay", name: "Essay" },
      { id: "yoga", name: "Yoga Class #3", hiddenFromHome: true },
      { id: "quiz", name: "Quiz", hiddenFromHome: false },
    ]);
    assert.deepEqual(
      home.map((t) => t.id),
      ["essay", "quiz"]
    );
    assert.deepEqual(
      classOnly.map((t) => t.id),
      ["yoga"]
    );
  });

  it("treats a missing list as empty", () => {
    assert.deepEqual(partitionClassTodos(null), { home: [], classOnly: [] });
    assert.deepEqual(partitionClassTodos(undefined), { home: [], classOnly: [] });
  });
});

describe("uiPanelDateKeys", () => {
  const schedule = {
    schoolStart: "2026-09-02",
    schoolEnd: "2027-06-11",
    closedDates: ["2026-09-03", "2026-09-04", "2026-09-07", "2026-09-18", "2026-09-21"],
    dayOverrides: {
      "2026-09-02": { allPeriods: true, label: "AH" },
    },
  };

  it("keeps today plus the next two school days", () => {
    assert.deepEqual(uiPanelDateKeys(schedule, "2026-09-14"), [
      "2026-09-14",
      "2026-09-15",
      "2026-09-16",
    ]);
  });

  it("skips weekend to the next two school days", () => {
    assert.deepEqual(uiPanelDateKeys(schedule, "2026-09-12"), [
      "2026-09-14",
      "2026-09-15",
    ]);
  });

  it("still includes following days on an A-H date", () => {
    assert.deepEqual(uiPanelDateKeys(schedule, "2026-09-02"), [
      "2026-09-02",
      "2026-09-08",
      "2026-09-09",
    ]);
  });

  it("skips a closed Friday to Monday", () => {
    assert.deepEqual(uiPanelDateKeys(schedule, "2026-09-17"), [
      "2026-09-17",
      "2026-09-22",
      "2026-09-23",
    ]);
  });
});

describe("publicDebateCase", () => {
  it("keeps a speech and drops a bad link", () => {
    const out = publicDebateCase({
      name: "Example",
      resolution: "Resolved: Justice requires open borders for human migration.",
      aff: {
        framework: { value: "Justice", criterion: "Util", text: ["Why."] },
        definitions: [{ term: "Open borders", text: "No quota." }],
        contentions: [
          {
            label: "C1",
            title: "The number",
            chain: ["Chain."],
            cards: [
              {
                tag: "Clemens 11: warrant",
                quote: "The line that says it.",
                source: "Clemens 2011",
                url: "https://example.com/paper.pdf",
                means: ["this means 3 billion times 7500."],
              },
              {
                tag: "Nope",
                quote: "No link",
                url: "javascript:alert(1)",
              },
            ],
          },
        ],
      },
    });
    assert.equal(out.aff.contentions[0].cards.length, 1);
    assert.equal(out.aff.contentions[0].cards[0].url, "https://example.com/paper.pdf");
    assert.equal(out.neg, undefined);
  });

  it("loads the open borders case with a direct link on every card", async () => {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(
      await readFile(
        new URL(
          "../education/you@example.com/projects/debate/cases/justice-requires-open-borders/case.json",
          import.meta.url
        ),
        "utf8"
      )
    );
    const out = publicDebateCase(raw);
    for (const side of ["aff", "neg"]) {
      const cards = out[side].contentions.flatMap((c) => c.cards);
      assert.ok(cards.length >= 4);
      for (const card of cards) {
        assert.match(card.url, /^https:\/\//);
        assert.ok(card.quote.length > 40);
        assert.ok(card.tag.includes(":"));
      }
    }
    assert.equal(out.aff.framework.value, "Justice");
    assert.equal(out.neg.framework.value, "Justice");
    assert.ok(out.aff.contentions[0].chain.length > 8);
    assert.ok(out.aff.definitions[0].points.length >= 2);
    assert.equal(out.aff.definitions[0].text, undefined);
    assert.equal(out.aff.blockfile, undefined);
    assert.ok(out.neg.blockfile.length >= 5);
    for (const block of out.neg.blockfile) {
      assert.equal(block.label, "A2");
      assert.ok(block.title.length > 4);
      assert.ok((block.cards || []).length >= 1);
      for (const card of block.cards) {
        assert.match(card.url, /^https:\/\//);
        assert.ok(card.quote.length > 40);
      }
    }
    for (const side of ["aff", "neg"]) {
      assert.ok(out[side].framework.cards.length >= 1);
      const defCards = out[side].definitions.flatMap((def) => def.cards || []);
      assert.ok(defCards.length >= 4);
      for (const card of defCards) {
        assert.match(card.url, /^https:\/\//);
        assert.ok(card.quote.length > 40);
      }
    }
  });
});
