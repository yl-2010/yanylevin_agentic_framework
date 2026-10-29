import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_DRAFTS_DIRNAME,
  DRAFT_TITLE_MAX,
  MAX_DRAFT_FILES,
  MAX_DRAFT_FILE_BYTES,
  MAX_DRAFT_TEXT,
  addDraftFile,
  assertDraftId,
  chatDraftsRoot,
  deleteDraft,
  draftTitle,
  getDraft,
  guessDraftMime,
  isValidDraftId,
  listDrafts,
  removeDraftFile,
  sanitizeDraftFilename,
  saveDraftText,
  takeDraftFiles,
} from "./chat-drafts.js";
import { JYPE_ACCESS_EMAILS } from "./identity.js";

const SID = "7f3a91c2-abcd-4ef0-8123-456789abcdef";

/** @type {string} */
let root;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chat-drafts-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function bytes(n, fill = 1) {
  return Buffer.alloc(n, fill);
}

describe("chatDraftsRoot", () => {
  it("keeps JYPE drafts per member inside the shared root", () => {
    const [first, second] = [...JYPE_ACCESS_EMAILS];
    const a = chatDraftsRoot(first, "jype");
    const b = chatDraftsRoot(second, "jype");
    assert.notEqual(a, b);
    assert.ok(a.endsWith(join(CHAT_DRAFTS_DIRNAME, "members", first)));
    assert.ok(!chatDraftsRoot(first).includes("members"));
  });
});

describe("draft ids", () => {
  it("accepts uuids and s-<sessionId>", () => {
    assert.equal(assertDraftId("0b5c1d2e-aaaa-4bbb-8ccc-123456789abc"), "0b5c1d2e-aaaa-4bbb-8ccc-123456789abc");
    assert.equal(assertDraftId(`s-${SID}`), `s-${SID}`);
    assert.equal(assertDraftId("a_B-9"), "a_B-9");
    assert.equal(isValidDraftId("x".repeat(80)), true);
  });

  it("rejects bad ids with 400", () => {
    for (const bad of ["", "a/b", "../x", "a.b", "x".repeat(81), "has space", null, 42]) {
      assert.throws(() => assertDraftId(bad), (err) => err.status === 400);
    }
  });

  it("rejects bad ids on every write path", async () => {
    await assert.rejects(saveDraftText(root, "../x", { text: "hi" }), (err) => err.status === 400);
    await assert.rejects(
      addDraftFile(root, "a.b", { name: "f.txt", data: bytes(1) }),
      (err) => err.status === 400
    );
    await assert.rejects(removeDraftFile(root, "a/b", "f1"), (err) => err.status === 400);
    await assert.rejects(deleteDraft(root, ""), (err) => err.status === 400);
    assert.deepEqual(await takeDraftFiles(root, "../etc"), []);
  });
});

describe("draftTitle", () => {
  it("uses the first non-blank line with whitespace collapsed", () => {
    assert.equal(draftTitle("  hello \t  world  \nsecond"), "hello world");
    assert.equal(draftTitle("\n\n   \n  later line "), "later line");
  });

  it("caps at 80 characters", () => {
    const t = draftTitle("a".repeat(200));
    assert.equal(t.length, DRAFT_TITLE_MAX);
  });

  it("falls back to the first file name, then Draft", () => {
    assert.equal(draftTitle("   ", [{ name: "notes.pdf" }, { name: "b.png" }]), "notes.pdf");
    assert.equal(draftTitle("", []), "Draft");
    assert.equal(draftTitle(undefined), "Draft");
  });
});

describe("file names and mime", () => {
  it("sanitizes like the agent upload path", () => {
    assert.equal(sanitizeDraftFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeDraftFilename("..hidden"), "hidden");
    assert.equal(sanitizeDraftFilename("a\\b\\c d?.png"), "c d_.png");
    assert.equal(sanitizeDraftFilename(""), "file");
    const long = sanitizeDraftFilename(`${"x".repeat(400)}.pdf`);
    assert.ok(long.length <= 180);
    assert.ok(long.endsWith(".pdf"));
  });

  it("guesses mime from the extension when missing", () => {
    assert.equal(guessDraftMime("", "a.PNG"), "image/png");
    assert.equal(guessDraftMime("application/octet-stream", "a.pdf"), "application/pdf");
    assert.equal(guessDraftMime("Text/Plain", "a.bin"), "text/plain");
    assert.equal(guessDraftMime("", "a.unknownext"), "application/octet-stream");
  });
});

describe("saveDraftText", () => {
  it("creates, updates, and returns the public draft shape", async () => {
    const d1 = await saveDraftText(root, "d1", { text: "First line\nmore" });
    assert.equal(d1.id, "d1");
    assert.equal(d1.sessionId, null);
    assert.equal(d1.text, "First line\nmore");
    assert.equal(d1.title, "First line");
    assert.deepEqual(d1.files, []);
    assert.ok(!Number.isNaN(Date.parse(d1.created)));
    assert.ok(Date.parse(d1.updated) >= Date.parse(d1.created));

    const d2 = await saveDraftText(root, "d1", { text: "Changed", sessionId: SID });
    assert.equal(d2.created, d1.created);
    assert.ok(Date.parse(d2.updated) > Date.parse(d1.updated));
    assert.equal(d2.sessionId, SID);

    const d3 = await saveDraftText(root, "d1", { text: "Again" });
    assert.equal(d3.sessionId, SID, "omitted sessionId keeps the old one");
    const d4 = await saveDraftText(root, "d1", { text: "Again", sessionId: null });
    assert.equal(d4.sessionId, null);

    const raw = JSON.parse(
      await readFile(join(root, CHAT_DRAFTS_DIRNAME, "d1.json"), "utf8")
    );
    assert.equal(raw.text, "Again");
    assert.deepEqual(await getDraft(root, "d1"), d4);
  });

  it("drops invalid session ids", async () => {
    const d = await saveDraftText(root, "d1", { text: "x", sessionId: "../bad" });
    assert.equal(d.sessionId, null);
  });

  it("deletes the draft when text is blank and there are no files", async () => {
    await saveDraftText(root, "d1", { text: "hi" });
    assert.equal(await saveDraftText(root, "d1", { text: "  \n\t " }), null);
    assert.equal(await getDraft(root, "d1"), null);
    assert.deepEqual(await listDrafts(root), []);
    assert.equal(await saveDraftText(root, "never", { text: "" }), null);
  });

  it("keeps a blank-text draft that still has files", async () => {
    await addDraftFile(root, "d1", { name: "a.txt", data: bytes(3) });
    const d = await saveDraftText(root, "d1", { text: "" });
    assert.ok(d);
    assert.equal(d.files.length, 1);
    assert.equal(d.title, "a.txt");
  });

  it("validates text", async () => {
    await assert.rejects(saveDraftText(root, "d1", {}), (err) => err.status === 400);
    await assert.rejects(
      saveDraftText(root, "d1", { text: "x".repeat(MAX_DRAFT_TEXT + 1) }),
      (err) => err.status === 400
    );
  });

  it("writes atomically without leaving tmp files", async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => saveDraftText(root, "d1", { text: `v${i}` }))
    );
    const names = await readdir(join(root, CHAT_DRAFTS_DIRNAME));
    assert.deepEqual(names, ["d1.json"]);
    assert.equal((await getDraft(root, "d1")).text, "v9");
  });
});

describe("draft files", () => {
  it("adds a file, creates the draft, stores bytes on disk", async () => {
    const { file, draft } = await addDraftFile(root, "d1", {
      name: "../My Notes?.pdf",
      mimeType: "",
      data: Buffer.from("hello"),
      sessionId: SID,
    });
    assert.match(file.id, /^[A-Za-z0-9_-]+$/);
    assert.equal(file.name, "My Notes_.pdf");
    assert.equal(file.mimeType, "application/pdf");
    assert.equal(file.size, 5);
    assert.equal(draft.sessionId, SID);
    assert.deepEqual(draft.files, [file]);
    assert.equal(draft.title, "My Notes_.pdf");
    assert.equal(Object.hasOwn(draft.files[0], "stored"), false);

    const stored = await readdir(join(root, CHAT_DRAFTS_DIRNAME, "d1"));
    assert.deepEqual(stored, [`${file.id}-My Notes_.pdf`]);

    const taken = await takeDraftFiles(root, "d1");
    assert.equal(taken.length, 1);
    assert.equal(taken[0].size, 5);
    assert.equal(await readFile(taken[0].path, "utf8"), "hello");
  });

  it("keeps every file when uploads run in parallel", async () => {
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        addDraftFile(root, "d1", { name: `f${i}.txt`, data: bytes(10) })
      )
    );
    const d = await getDraft(root, "d1");
    assert.equal(d.files.length, 6);
  });

  it("rejects empty bodies", async () => {
    await assert.rejects(
      addDraftFile(root, "d1", { name: "a.txt", data: Buffer.alloc(0) }),
      (err) => err.status === 400
    );
    await assert.rejects(
      addDraftFile(root, "d1", { name: "a.txt", data: "not a buffer" }),
      (err) => err.status === 400
    );
    assert.equal(await getDraft(root, "d1"), null);
  });

  it("enforces the file count limit", async () => {
    for (let i = 0; i < MAX_DRAFT_FILES; i++) {
      await addDraftFile(root, "d1", { name: `f${i}.txt`, data: bytes(1) });
    }
    await assert.rejects(
      addDraftFile(root, "d1", { name: "one-more.txt", data: bytes(1) }),
      (err) => err.status === 400 && /at most 16/.test(err.message)
    );
    assert.equal((await getDraft(root, "d1")).files.length, MAX_DRAFT_FILES);
  });

  it("enforces per-file and total size limits", async () => {
    await assert.rejects(
      addDraftFile(root, "d1", { name: "big.bin", data: bytes(MAX_DRAFT_FILE_BYTES + 1, 0) }),
      (err) => err.status === 400 && /exceeds 64MB/.test(err.message)
    );
    const half = Math.floor(MAX_DRAFT_FILE_BYTES / 2);
    await addDraftFile(root, "d1", { name: "a.bin", data: bytes(half, 0) });
    await addDraftFile(root, "d1", { name: "b.bin", data: bytes(half, 0) });
    await assert.rejects(
      addDraftFile(root, "d1", { name: "c.bin", data: bytes(1024, 0) }),
      (err) => err.status === 400 && /total size/.test(err.message)
    );
    const names = await readdir(join(root, CHAT_DRAFTS_DIRNAME, "d1"));
    assert.equal(names.length, 2, "rejected files leave nothing on disk");
  });

  it("removes a file and deletes the draft when nothing is left", async () => {
    const a = await addDraftFile(root, "d1", { name: "a.txt", data: bytes(2) });
    const b = await addDraftFile(root, "d1", { name: "b.txt", data: bytes(2) });

    const afterA = await removeDraftFile(root, "d1", a.file.id);
    assert.deepEqual(afterA.files.map((f) => f.id), [b.file.id]);
    const left = await readdir(join(root, CHAT_DRAFTS_DIRNAME, "d1"));
    assert.deepEqual(left, [`${b.file.id}-b.txt`]);

    const unknown = await removeDraftFile(root, "d1", "nope");
    assert.equal(unknown.files.length, 1, "unknown file id is a no-op");

    assert.equal(await removeDraftFile(root, "d1", b.file.id), null);
    assert.equal(await getDraft(root, "d1"), null);
    await assert.rejects(stat(join(root, CHAT_DRAFTS_DIRNAME, "d1")), { code: "ENOENT" });
    assert.equal(await removeDraftFile(root, "missing", "x"), null);
    await assert.rejects(removeDraftFile(root, "d1", "../x"), (err) => err.status === 400);
  });

  it("keeps a draft with text after its last file is removed", async () => {
    const { file } = await addDraftFile(root, "d1", { name: "a.txt", data: bytes(2) });
    await saveDraftText(root, "d1", { text: "still here" });
    const d = await removeDraftFile(root, "d1", file.id);
    assert.equal(d.text, "still here");
    assert.deepEqual(d.files, []);
  });

  it("skips files that vanished from disk when taking them", async () => {
    const { file } = await addDraftFile(root, "d1", { name: "a.txt", data: bytes(2) });
    await addDraftFile(root, "d1", { name: "b.txt", data: bytes(4) });
    await rm(join(root, CHAT_DRAFTS_DIRNAME, "d1", `${file.id}-a.txt`));
    const taken = await takeDraftFiles(root, "d1");
    assert.deepEqual(taken.map((f) => f.name), ["b.txt"]);
    assert.deepEqual(await takeDraftFiles(root, "unknown"), []);
  });
});

describe("listDrafts", () => {
  it("returns [] when the folder does not exist", async () => {
    assert.deepEqual(await listDrafts(root), []);
  });

  it("sorts by updated, newest first, and skips junk", async () => {
    await saveDraftText(root, "old", { text: "old" });
    await new Promise((r) => setTimeout(r, 5));
    await saveDraftText(root, "mid", { text: "mid" });
    await new Promise((r) => setTimeout(r, 5));
    await addDraftFile(root, "new", { name: "n.png", data: bytes(1) });
    await new Promise((r) => setTimeout(r, 5));
    await saveDraftText(root, "old", { text: "old, edited" });

    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, CHAT_DRAFTS_DIRNAME, "broken.json"), "{not json");
    await writeFile(join(root, CHAT_DRAFTS_DIRNAME, "x.json.abcd.tmp"), "{}");

    const drafts = await listDrafts(root);
    assert.deepEqual(drafts.map((d) => d.id), ["old", "new", "mid"]);
    assert.equal(drafts[1].title, "n.png");
    for (const d of drafts) {
      assert.deepEqual(Object.keys(d).sort(), [
        "created",
        "files",
        "id",
        "sessionId",
        "text",
        "title",
        "updated",
      ]);
    }
  });
});

describe("deleteDraft", () => {
  it("removes json and files and is idempotent", async () => {
    await addDraftFile(root, "d1", { name: "a.txt", data: bytes(2) });
    await saveDraftText(root, "d1", { text: "hi" });
    await deleteDraft(root, "d1");
    assert.equal(await getDraft(root, "d1"), null);
    assert.deepEqual(await readdir(join(root, CHAT_DRAFTS_DIRNAME)), []);
    await deleteDraft(root, "d1");
    await deleteDraft(root, "never-existed");
  });
});
