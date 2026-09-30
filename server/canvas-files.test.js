import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allocateFileName,
  canvasDownloadName,
  displayUploadName,
  isSpanishDecorationImage,
  pickSubmitFiles,
  pickCanvasSubmitKind,
  writeFileIntoFolder,
} from "./canvas-files.js";
import { parseCanvasFileRefs } from "./canvas-sync.js";

describe("parseCanvasFileRefs", () => {
  it("pulls file ids out of Canvas RCE HTML and attachments", () => {
    const html = `
      <a class="instructure_file_link"
         title="Ping Pong WS.pdf"
         href="https://canvas.instructure.com/courses/1/files/4029/download?wrap=1">Ping Pong WS.pdf</a>
      <a data-api-endpoint="https://canvas.instructure.com/api/v1/courses/1/files/88">ignore</a>
    `;
    const files = parseCanvasFileRefs(html, [
      { id: 88, display_name: "rubric.docx" },
      { id: 4029, filename: "Ping Pong WS.pdf" },
    ]);
    assert.deepEqual(files, [
      { id: 88, name: "rubric.docx" },
      { id: 4029, name: "Ping Pong WS.pdf" },
    ]);
  });

  it("skips empty html", () => {
    assert.deepEqual(parseCanvasFileRefs(""), []);
  });
});

describe("displayUploadName", () => {
  it("renames scanner junk and kebab-case, keeps a real title", () => {
    assert.equal(
      displayUploadName("Scanned Document 17.pdf", "Emperor diagnostic"),
      "Emperor diagnostic.pdf"
    );
    assert.equal(
      displayUploadName("motion-diagram_warmup.pdf"),
      "motion diagram warmup.pdf"
    );
    assert.equal(
      displayUploadName("When the Emperor Was Divine.pdf"),
      "When the Emperor Was Divine.pdf"
    );
    assert.equal(
      displayUploadName(
        "image-57b18e43-adb7-4bd1-b40c-8cc412a38c18.png",
        "STUDY GUIDE QA #1"
      ),
      "STUDY GUIDE QA 1.png"
    );
    assert.equal(
      displayUploadName("image-asldjfhasldjfbalsdj.jpg", "El dinosaurio"),
      "El dinosaurio.jpg"
    );
  });
});

describe("canvasDownloadName", () => {
  it("keeps a real teacher filename and renames image-random", () => {
    assert.equal(
      canvasDownloadName("Ping Pong WS.pdf", "Comparing Motion Diagrams", 1),
      "Ping Pong WS.pdf"
    );
    assert.equal(
      canvasDownloadName(
        "image-57b18e43-adb7-4bd1-b40c-8cc412a38c18.png",
        "STUDY GUIDE: QA #1 ESCRITO - AUDITIVO",
        9
      ),
      "STUDY GUIDE QA 1 ESCRITO - AUDITIVO.png"
    );
    assert.equal(
      canvasDownloadName("image-asldjfhasldjfbalsdj.png", "Practica", 3),
      "Practica.png"
    );
  });

  it("does not reuse a name another file already has", () => {
    const taken = new Set(["practica.png"]);
    assert.equal(allocateFileName("Practica.png", taken, ""), "Practica 2.png");
    assert.equal(
      allocateFileName("Practica.png", taken, "practica.png"),
      "Practica.png"
    );
  });
});

describe("isSpanishDecorationImage", () => {
  it("skips Spanish pasted images and keeps named files and other classes", () => {
    assert.equal(
      isSpanishDecorationImage(
        "spanish-4",
        "image-e8147842-2f41-4494-b5dc-05152c750e1b.png",
        "image/png"
      ),
      true
    );
    assert.equal(isSpanishDecorationImage("spanish-4", "image.png", "image/png"), true);
    assert.equal(
      isSpanishDecorationImage("spanish-4", "lectura pagina 1.png"),
      false
    );
    assert.equal(isSpanishDecorationImage("spanish-4", "Busca un articulo.pdf"), false);
    assert.equal(
      isSpanishDecorationImage(
        "physics",
        "image-e8147842-2f41-4494-b5dc-05152c750e1b.png"
      ),
      false
    );
  });
});

describe("pickSubmitFiles", () => {
  const rows = [
    { name: "todo.json" },
    { name: "worksheet.pdf" },
    { name: "Motion Diagram Warm Up.pdf" },
    { name: "CONTEXT.md" },
  ];

  it("skips teacher canvas files and property json", () => {
    const picked = pickSubmitFiles(rows, {
      canvasFileNames: ["worksheet.pdf"],
    });
    assert.equal(picked.ok, true);
    assert.equal(picked.reason, "single");
    assert.deepEqual(
      picked.files.map((f) => f.name),
      ["Motion Diagram Warm Up.pdf"]
    );
  });

  it("prefers a chat upload when several work files exist", () => {
    const picked = pickSubmitFiles(rows, {
      canvasFileNames: ["worksheet.pdf"],
      chatNames: ["Motion Diagram Warm Up.pdf"],
    });
    assert.equal(picked.reason, "chat");
    assert.equal(picked.files[0].name, "Motion Diagram Warm Up.pdf");
  });

  it("asks when two student files remain", () => {
    const picked = pickSubmitFiles(
      [
        { name: "draft.pdf" },
        { name: "final.pdf" },
      ],
      { canvasFileNames: [] }
    );
    assert.equal(picked.ok, false);
    assert.equal(picked.reason, "ambiguous");
  });

  it("returns none when the folder is only teacher files", () => {
    const picked = pickSubmitFiles([{ name: "worksheet.pdf" }], {
      canvasFileNames: ["worksheet.pdf"],
    });
    assert.equal(picked.ok, false);
    assert.equal(picked.reason, "none");
  });
});

describe("writeFileIntoFolder", () => {
  it("writes bytes through a temp rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-files-"));
    const src = join(dir, "src.pdf");
    await writeFile(src, "hello canvas");
    const dest = await writeFileIntoFolder(dir, "Motion Diagram Warm Up.pdf", src);
    assert.equal(dest, join(dir, "Motion Diagram Warm Up.pdf"));
    assert.equal(await readFile(dest, "utf8"), "hello canvas");
  });
});

describe("pickCanvasSubmitKind", () => {
  const both = ["online_text_entry", "online_upload"];

  it("prefers an attached file when upload is allowed", () => {
    assert.equal(
      pickCanvasSubmitKind({
        types: both,
        text: "paragraph",
        hasFile: true,
      }),
      "online_upload"
    );
  });

  it("submits text when that is what Yan gave", () => {
    assert.equal(
      pickCanvasSubmitKind({
        types: both,
        text: "paragraph",
        hasFile: false,
      }),
      "online_text_entry"
    );
  });

  it("submits a URL when allowed", () => {
    assert.equal(
      pickCanvasSubmitKind({
        types: ["online_url"],
        url: "https://example.com/doc",
      }),
      "online_url"
    );
  });

  it("asks for text when the assignment is text-only", () => {
    assert.equal(
      pickCanvasSubmitKind({ types: ["online_text_entry"] }),
      "need-text"
    );
  });

  it("rejects a file on a text-only assignment", () => {
    assert.equal(
      pickCanvasSubmitKind({
        types: ["online_text_entry"],
        hasFile: true,
      }),
      "not-online-upload"
    );
  });
});
