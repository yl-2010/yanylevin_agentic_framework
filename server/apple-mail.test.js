import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  accountFromMailbox,
  assertDumpQuality,
  decodeQuotedPrintable,
  dumpAppleMail,
  emptyBodyRate,
  extractPlaintext,
  folderFromMailbox,
  formatDumpMessage,
  parseEmlx,
  shouldSkipMailbox,
  wrapEmlx,
} from "./apple-mail.js";

const execFileAsync = promisify(execFile);

function rfc822({ from, to, subject, contentType, encoding, body }) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: ${contentType}`,
    encoding ? `Content-Transfer-Encoding: ${encoding}` : null,
    "",
    body,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

describe("apple-mail MIME extract", () => {
  it("pulls words from HTML-only mail (the AppleScript-blank case)", () => {
    const raw = wrapEmlx(
      rfc822({
        from: "Rajasi Saha <rajasi@hotmail.com>",
        to: "you@example.com",
        subject: "EPS orientation",
        contentType: "text/html; charset=utf-8",
        body: "<html><body><p>Orientation is Tuesday in the gym. Bring forms.</p></body></html>",
      })
    );
    const got = extractPlaintext(parseEmlx(raw));
    assert.match(got.text, /Orientation is Tuesday in the gym/);
    assert.equal(got.imageOnly, false);
    assert.notEqual(got.text.trim(), "");
  });

  it("decodes quoted-printable plaintext", () => {
    const decoded = decodeQuotedPrintable("Caf=C3=A9 =3D coffee=\n tomorrow");
    assert.match(decoded, /Café = coffee tomorrow/);
    const got = extractPlaintext(
      rfc822({
        from: "a@b.com",
        to: "you@example.com",
        subject: "qp",
        contentType: "text/plain; charset=utf-8",
        encoding: "quoted-printable",
        body: "See you at =C2=A310am",
      })
    );
    assert.match(got.text, /See you at £10am/);
  });

  it("prefers text/plain in multipart/alternative", () => {
    const got = extractPlaintext(
      [
        "From: a@b.com",
        "To: you@example.com",
        "Subject: multi",
        "MIME-Version: 1.0",
        'Content-Type: multipart/alternative; boundary="bnd"',
        "",
        "--bnd",
        "Content-Type: text/plain; charset=utf-8",
        "",
        "Plain path wins",
        "--bnd",
        "Content-Type: text/html; charset=utf-8",
        "",
        "<p>HTML path loses</p>",
        "--bnd--",
        "",
      ].join("\n")
    );
    assert.match(got.text, /Plain path wins/);
    assert.doesNotMatch(got.text, /HTML path loses/);
  });

  it("marks image-only parts instead of an empty body", () => {
    const got = extractPlaintext(
      [
        "From: a@b.com",
        "To: you@example.com",
        "Subject: pic",
        "MIME-Version: 1.0",
        "Content-Type: image/jpeg",
        "Content-Transfer-Encoding: base64",
        "",
        "/9j/4AAQSkZJRgABAQAAAQABAAD/",
        "",
      ].join("\n")
    );
    assert.equal(got.imageOnly, true);
    assert.match(got.text, /image omitted/);
  });
});

describe("apple-mail dump helpers", () => {
  it("skips junk/trash/drafts and labels the three accounts", () => {
    assert.equal(shouldSkipMailbox("imap://x/Junk", "Junk"), true);
    assert.equal(shouldSkipMailbox("imap://x/INBOX", "INBOX"), false);
    assert.equal(accountFromMailbox("imap://yanylevin%40gmail.com@imap.gmail.com/INBOX"), "Google");
    assert.equal(
      accountFromMailbox("imap://yl-2010%40outlook.com@outlook.office365.com/Inbox"),
      "Exchange"
    );
    assert.equal(accountFromMailbox("imap://you@icloud.com@imap.mail.me.com/INBOX"), "iCloud");
    assert.equal(
      accountFromMailbox("ews://67592F32-78E7-44E7-9C07-1EE593CB804E/Inbox"),
      "Exchange"
    );
    assert.equal(
      accountFromMailbox("imap://9F21D157-E8EB-4142-8D54-CF78634B529F/[Gmail]/All Mail"),
      "Google"
    );
    assert.equal(
      folderFromMailbox(
        "ews://67592F32-78E7-44E7-9C07-1EE593CB804E/Sent%20Items",
        "ews://67592F32-78E7-44E7-9C07-1EE593CB804E/Sent%20Items"
      ),
      "Sent Items"
    );
  });

  it("fails the quality gate when empty-body rate is high", () => {
    assert.equal(emptyBodyRate({ withEmlx: 100, emptyBody: 4 }), 0.04);
    assert.doesNotThrow(() =>
      assertDumpQuality({ withEmlx: 100, emptyBody: 4, emptySamples: [] })
    );
    assert.throws(
      () => assertDumpQuality({ withEmlx: 20, emptyBody: 8, emptySamples: [1, 2] }),
      /empty-body rate/
    );
    assert.throws(() => assertDumpQuality({ withEmlx: 0, emptyBody: 0 }), /no \.emlx/);
  });

  it("formats a dump line the fill prompt can split on", () => {
    const line = formatDumpMessage({
      received: "2024-07-01T12:00:00.000Z",
      account: "Google",
      folder: "INBOX",
      from: "rajasi@hotmail.com",
      to: "you@example.com",
      subject: "Hello",
      body: "See you Tuesday",
    });
    assert.match(line, /^2024-07-01T12:00:00.000Z \| account=Google/);
    assert.match(line, /See you Tuesday/);
  });
});

describe("apple-mail dump end-to-end", () => {
  it("writes monthly files with real HTML-only bodies", async () => {
    const root = await mkdtemp(join(tmpdir(), "apple-mail-test-"));
    const mailRoot = join(root, "Mail");
    const db = join(root, "Envelope Index");
    const outDir = join(root, "out");
    const messagesDir = join(mailRoot, "Google", "INBOX.mbox", "Messages");
    await mkdir(messagesDir, { recursive: true });

    const html = wrapEmlx(
      rfc822({
        from: "Rajasi Saha <rajasi@hotmail.com>",
        to: "you@example.com",
        subject: "Bookstore",
        contentType: "text/html; charset=utf-8",
        body: "<div>Costco run after school. Grab the calculator.</div>",
      })
    );
    await writeFile(join(messagesDir, "1.emlx"), html);

    const appleDate = Date.parse("2024-09-15T17:00:00Z") / 1000 - 978307200;
    await execFileAsync("sqlite3", [
      db,
      `
      CREATE TABLE messages (ROWID INTEGER PRIMARY KEY, sender INTEGER, subject INTEGER, date_received REAL, mailbox INTEGER, deleted INTEGER);
      CREATE TABLE subjects (ROWID INTEGER PRIMARY KEY, subject TEXT);
      CREATE TABLE addresses (ROWID INTEGER PRIMARY KEY, address TEXT);
      CREATE TABLE mailboxes (ROWID INTEGER PRIMARY KEY, url TEXT, name TEXT);
      CREATE TABLE recipients (message INTEGER, type INTEGER, address INTEGER);
      INSERT INTO addresses VALUES (1, 'rajasi@hotmail.com');
      INSERT INTO addresses VALUES (2, 'you@example.com');
      INSERT INTO subjects VALUES (1, 'Bookstore');
      INSERT INTO mailboxes VALUES (1, 'imap://yanylevin%40gmail.com@imap.gmail.com/INBOX', 'INBOX');
      INSERT INTO messages VALUES (1, 1, 1, ${appleDate}, 1, 0);
      INSERT INTO recipients VALUES (1, 0, 2);
      `,
    ]);

    const manifest = await dumpAppleMail({ mailRoot, envelopeDb: db, outDir });
    assert.equal(manifest.messages, 1);
    assert.equal(manifest.withBody, 1);
    assert.equal(manifest.emptyBody, 0);
    assert.equal(manifest.files[0].month, "2024-09");
    const { readFile } = await import("node:fs/promises");
    const dumped = await readFile(join(outDir, "2024-09.txt"), "utf8");
    assert.match(dumped, /Costco run after school/);
    assert.match(dumped, /account=Google/);
    assert.match(dumped, /from=rajasi@hotmail.com/);
  });
});
