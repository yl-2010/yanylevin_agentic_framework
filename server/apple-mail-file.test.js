import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_CONFIDENCE,
  buildFileState,
  decideFileAction,
  destMailboxForAction,
  loadFileState,
  moveArgs,
  parseFileState,
  pollAppleMailFile,
} from "./apple-mail-file.js";
import { FILE_BODY_MAX, extractPlaintext, isFiledMailbox, isWatchMailbox } from "./apple-mail.js";

describe("mail watch folders", () => {
  it("watches inbox and junk, not colleges or drafts", () => {
    assert.equal(isWatchMailbox("imap://x/INBOX", "INBOX"), true);
    assert.equal(isWatchMailbox("imap://x/Junk", "Junk"), true);
    assert.equal(isWatchMailbox("imap://x/Spam", "Spam"), true);
    assert.equal(isWatchMailbox("ews://x/Junk Email", "Junk Email"), true);
    assert.equal(isWatchMailbox("imap://x/Colleges", "Colleges"), false);
    assert.equal(isWatchMailbox("imap://x/Drafts", "Drafts"), false);
    assert.equal(isFiledMailbox("imap://x/Colleges", "Colleges"), true);
    assert.equal(isFiledMailbox("imap://x/Security", "Security"), true);
  });
});

describe("decideFileAction", () => {
  it("files college and security above the confidence floor", () => {
    assert.equal(
      decideFileAction({ choice: "college", confidence: 0.9 }),
      "colleges"
    );
    assert.equal(
      decideFileAction({ choice: "security", confidence: 0.8 }),
      "security"
    );
    assert.equal(destMailboxForAction("colleges"), "Colleges");
    assert.equal(destMailboxForAction("security"), "Security");
  });

  it("leaves other and low-confidence mail in the inbox", () => {
    assert.equal(decideFileAction({ choice: "other", confidence: 0.99 }), "skip");
    assert.equal(
      decideFileAction({ choice: "college", confidence: MIN_CONFIDENCE - 0.2 }),
      "skip"
    );
    assert.equal(decideFileAction(null), "skip");
  });
});

describe("buildFileState", () => {
  it("hands Jev the full body plus headers", () => {
    const body = "Admissions tour this fall. ".repeat(20);
    const state = buildFileState({
      account: "Google",
      folder: "INBOX",
      from: "admit@stanford.edu",
      to: "you@example.com",
      subject: "Visit campus",
      received: "2026-09-20T12:00:00.000Z",
      messageId: "<a@stanford.edu>",
      body,
    });
    assert.equal(state.body, body);
    assert.equal(state.from, "admit@stanford.edu");
    assert.match(state.subject, /Visit campus/);
  });
});

describe("extractPlaintext max", () => {
  it("can keep a long body for Jev", () => {
    const long = "college spam paragraph\n".repeat(3000);
    const got = extractPlaintext(
      ["From: a@b.edu", "To: x@y.com", "Subject: hi", "", long].join("\n"),
      FILE_BODY_MAX
    );
    assert.ok(got.text.length > 20_000);
    assert.ok(got.text.length <= FILE_BODY_MAX);
  });
});

describe("moveArgs", () => {
  it("passes dest, account, mailbox, id, message-id", () => {
    assert.deepEqual(
      moveArgs({
        destMailbox: "Colleges",
        account: "Google",
        folder: "INBOX",
        id: 44,
        messageId: "<x@y>",
      }),
      ["Colleges", "Google", "INBOX", "44", "<x@y>"]
    );
  });
});

describe("pollAppleMailFile", () => {
  it("writes a watermark and does not file backlog", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mail-file-"));
    const path = join(dir, "state.json");
    const listed = [];
    const out = await pollAppleMailFile({
      statePath: path,
      now: () => new Date("2026-09-20T18:00:00.000Z"),
      listRecentAppleMail: async () => {
        listed.push(true);
        return [{ id: 1, subject: "old" }];
      },
      systemOne: async () => {
        throw new Error("should not classify on watermark");
      },
    });
    assert.equal(out.skipped, "watermark");
    assert.equal(listed.length, 0);
    const state = await loadFileState(path);
    assert.equal(state.lastAt, "2026-09-20T18:00:00.000Z");
  });

  it("moves college mail and leaves other", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mail-file-"));
    const path = join(dir, "state.json");
    await writeFile(
      path,
      JSON.stringify({ lastAt: "2026-09-20T17:00:00.000Z", seenIds: [] })
    );
    const moved = [];
    const rows = [
      {
        id: 1,
        account: "Google",
        folder: "INBOX",
        from: "admit@u.edu",
        subject: "Apply now",
        received: "2026-09-20T17:10:00.000Z",
        messageId: "<1@u.edu>",
        body: "Tour our campus this fall.",
      },
      {
        id: 2,
        account: "Exchange",
        folder: "Inbox",
        from: "friend@x.com",
        subject: "hw",
        received: "2026-09-20T17:11:00.000Z",
        messageId: "<2@x.com>",
        body: "did you finish the worksheet",
      },
    ];
    const out = await pollAppleMailFile({
      statePath: path,
      listRecentAppleMail: async () => rows,
      classifyMailRow: async (row) =>
        row.id === 1
          ? { choice: "college", confidence: 0.92 }
          : { choice: "other", confidence: 0.95 },
      moveAndMarkRead: async (row, dest) => {
        moved.push({ id: row.id, dest });
        return "moved";
      },
    });
    assert.equal(out.filed, 1);
    assert.equal(out.skipped, 1);
    assert.deepEqual(moved, [{ id: 1, dest: "Colleges" }]);
    const state = parseFileState(JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8")));
    assert.ok(state.seenIds.includes("mid:<1@u.edu>"));
    assert.ok(state.seenIds.includes("mid:<2@x.com>"));
  });
});
