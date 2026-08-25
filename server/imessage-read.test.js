import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  IMESSAGE_FETCH_MAX,
  IMESSAGE_TEXT_MAX,
  assertExportDir,
  clampLimit,
  defaultMessagesDb,
  expandAttachmentPath,
  exportPersonThread,
  formatExportLine,
  isPreviewableStill,
  monthKeyFromAt,
  normalizeMessageGuid,
  recentMessages,
  recentThread,
  resolveExportDir,
  rowToMessage,
  speakerWho,
  stageStillPreviews,
  tapbackAction,
  textFromAttributedBody,
} from "./imessage-read.js";

const execFileAsync = promisify(execFile);
const APPLE_EPOCH_S = 978_307_200;

function appleDate(d = new Date()) {
  return Math.floor((d.getTime() / 1000 - APPLE_EPOCH_S) * 1e9);
}

async function makeChatDb(sql) {
  const dir = await mkdtemp(join(tmpdir(), "imessage-read-"));
  const db = join(dir, "chat.db");
  await execFileAsync("sqlite3", [db, sql]);
  return db;
}

const SCHEMA = `
CREATE TABLE message (
  ROWID INTEGER PRIMARY KEY,
  guid TEXT,
  text TEXT,
  attributedBody BLOB,
  date INTEGER,
  is_from_me INTEGER DEFAULT 0,
  handle_id INTEGER,
  associated_message_guid TEXT,
  associated_message_type INTEGER DEFAULT 0,
  thread_originator_guid TEXT,
  cache_has_attachments INTEGER DEFAULT 0,
  is_audio_message INTEGER DEFAULT 0
);
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, display_name TEXT, chat_identifier TEXT);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
CREATE TABLE attachment (
  ROWID INTEGER PRIMARY KEY,
  filename TEXT,
  mime_type TEXT,
  uti TEXT,
  total_bytes INTEGER,
  is_sticker INTEGER DEFAULT 0,
  transfer_name TEXT,
  emoji_image_short_description TEXT
);
INSERT INTO handle(ROWID, id) VALUES (1, '+14253260143');
INSERT INTO chat(ROWID, display_name, chat_identifier) VALUES (1, 'Example Friend', '+14253260143');
`;

describe("imessage-read", () => {
  it("defaults to ~/Library/Messages/chat.db", () => {
    const prev = process.env.IMESSAGE_DB_PATH;
    delete process.env.IMESSAGE_DB_PATH;
    try {
      assert.match(defaultMessagesDb(), /Library\/Messages\/chat\.db$/);
    } finally {
      if (prev != null) process.env.IMESSAGE_DB_PATH = prev;
    }
  });

  it("caps fetch at 1024 and text at 10000", () => {
    assert.equal(IMESSAGE_FETCH_MAX, 1024);
    assert.equal(IMESSAGE_TEXT_MAX, 10_000);
    assert.equal(clampLimit(80, 1024), 80);
    assert.equal(clampLimit(5000, 1024), 1024);
    assert.equal(clampLimit(undefined, 1024), 1024);
  });

  it("normalizes associated guids and tapback names", () => {
    assert.equal(
      normalizeMessageGuid("p:0/E372F719-3A71-4140-884C-3BD3BB1FB571"),
      "E372F719-3A71-4140-884C-3BD3BB1FB571"
    );
    assert.equal(
      normalizeMessageGuid("re:CHAT-ID:125D114F-5BDE-4804-BB89-303B9D2E191E"),
      "125D114F-5BDE-4804-BB89-303B9D2E191E"
    );
    assert.equal(tapbackAction(2001), "liked");
    assert.equal(tapbackAction(2000), "loved");
    assert.equal(tapbackAction(3000), "sticker");
  });

  it("only previews still photos, not stickers or video", () => {
    assert.equal(
      isPreviewableStill({ mime: "image/heic", filename: "a.heic", sticker: false }),
      true
    );
    assert.equal(
      isPreviewableStill({ mime: "image/jpeg", filename: "a.jpg", sticker: true }),
      false
    );
    assert.equal(
      isPreviewableStill({ mime: "video/quicktime", filename: "a.mov" }),
      false
    );
    assert.match(expandAttachmentPath("~/Library/Messages/Attachments/x.heic"), /Library\/Messages/);
  });

  it("keeps 10k characters of text", () => {
    const long = "a".repeat(12_000);
    const msg = rowToMessage({
      id: 1,
      text: long,
      is_from_me: 1,
      at: "2026-08-19 12:00:00",
      attachments_json: "[]",
    });
    assert.equal(msg.text.length, 10_000);
  });

  it("includes tapbacks, swipe-replies, and captionless photos", async () => {
    const t = appleDate();
    const db = await makeChatDb(`
      ${SCHEMA}
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id, cache_has_attachments)
        VALUES (1, 'ORIG-GUID', 'wait does it start tmmr', ${t - 200}, 1, 1, 0);
      INSERT INTO chat_message_join VALUES (1, 1);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id, associated_message_guid, associated_message_type)
        VALUES (2, 'TAP-GUID', '', ${t - 100}, 0, 1, 'p:0/ORIG-GUID', 2001);
      INSERT INTO chat_message_join VALUES (1, 2);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id, thread_originator_guid)
        VALUES (3, 'REPLY-GUID', 'only for today', ${t - 50}, 1, 1, 'ORIG-GUID');
      INSERT INTO chat_message_join VALUES (1, 3);
      INSERT INTO attachment(ROWID, filename, mime_type, total_bytes, is_sticker, transfer_name)
        VALUES (1, '~/Library/Messages/Attachments/pic.heic', 'image/heic', 1234, 0, 'IMG_1.heic');
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id, cache_has_attachments)
        VALUES (4, 'PIC-GUID', '', ${t}, 1, 1, 1);
      INSERT INTO chat_message_join VALUES (1, 4);
      INSERT INTO message_attachment_join VALUES (4, 1);
    `);
    const rows = await recentMessages({
      db,
      limit: 10,
      previewStills: 0,
    });
    const tap = rows.find((m) => m.id === 2);
    const reply = rows.find((m) => m.id === 3);
    const pic = rows.find((m) => m.id === 4);
    assert.equal(tap?.tapback?.action, "liked");
    assert.match(String(tap?.tapback?.on || ""), /wait does it start/i);
    assert.match(String(reply?.replyTo?.text || ""), /wait does it start/i);
    assert.equal(pic?.attachments?.[0]?.mime, "image/heic");
    assert.equal(pic?.attachments?.[0]?.bytes, 1234);
    assert.equal(pic?.text, "");
  });

  it("stages a jpeg preview and skips video", async () => {
    const dir = await mkdtemp(join(tmpdir(), "imessage-prev-"));
    const src = join(dir, "in.jpg");
    await writeFile(src, "fake-jpeg");
    const destDir = join(dir, "out");
    let copied = "";
    const messages = [
      {
        id: 9,
        at: "2026-08-19 12:00:00",
        attachments: [
          { filename: src, mime: "image/jpeg", sticker: false },
          { filename: "/tmp/clip.mov", mime: "video/quicktime", sticker: false },
        ],
      },
    ];
    await stageStillPreviews(messages, {
      dir: destDir,
      copyFile: async (from, to) => {
        copied = to;
        await writeFile(to, "ok");
      },
    });
    assert.match(copied, /9-0\.jpg$/);
    assert.equal(messages[0].attachments[0].previewPath, copied);
    assert.equal(messages[0].attachments[1].previewPath, undefined);
  });

  it("keeps export dumps under /tmp/yanylevin-imessage-export", () => {
    assert.equal(
      resolveExportDir("alex-rivera"),
      "/tmp/yanylevin-imessage-export/alex-rivera"
    );
    assert.throws(() => assertExportDir("/tmp/other"), /must be under/);
    assert.throws(() => assertExportDir("$HOME/yanylevin_agentic_framework/tmp"), /must be under/);
  });

  it("formats export lines without dropping tapbacks", () => {
    const line = formatExportLine(
      {
        at: "2024-09-01 12:00:00",
        fromMe: false,
        chat: "JYPE",
        chatId: "chat123",
        text: "on my way",
        tapback: { action: "liked", on: "ok" },
      },
      ["+15555550100"]
    );
    assert.match(line, /^2024-09-01T12:00:00.000Z \| JYPE \| them \|/);
    assert.match(line, /\[liked\] ok/);
    assert.match(line, /on my way/);
    assert.equal(monthKeyFromAt("2024-09-01 12:00:00"), "2024-09");
  });

  it("pulls iMessage text out of attributedBody when text is empty", () => {
    const shortBody = "We could watch a movie";
    const shortBytes = Buffer.from(shortBody, "utf8");
    const short = Buffer.concat([
      Buffer.from("NSString\x01\x94\x84\x01+"),
      Buffer.from([shortBytes.length]),
      shortBytes,
    ]);
    assert.equal(textFromAttributedBody(short), shortBody);
    const longBody = "It’s a little bit more than a paragraph:\n\nHello";
    const longBytes = Buffer.from(longBody, "utf8");
    const long = Buffer.concat([
      Buffer.from("NSString\x01\x94\x84\x01+"),
      Buffer.from([0x81, longBytes.length & 0xff, (longBytes.length >> 8) & 0xff]),
      longBytes,
    ]);
    assert.equal(textFromAttributedBody(long.toString("hex")), longBody);
    const objBody = "\uFFFCSnap’s emailing me";
    const objBytes = Buffer.from(objBody, "utf8");
    const withObj = Buffer.concat([
      Buffer.from("NSString\x01\x94\x84\x01+"),
      Buffer.from([objBytes.length]),
      objBytes,
    ]);
    assert.equal(textFromAttributedBody(withObj), "Snap’s emailing me");
  });

  it("exports attributedBody-only rows as real text, not (empty)", async () => {
    const t = appleDate(new Date("2024-10-01T01:44:21Z"));
    const body = "We could watch a movie";
    const blob = Buffer.concat([
      Buffer.from("NSString\x01\x94\x84\x01+"),
      Buffer.from([Buffer.byteLength(body)]),
      Buffer.from(body, "utf8"),
    ]);
    const db = await makeChatDb(`
      ${SCHEMA}
      INSERT INTO message(ROWID, guid, text, attributedBody, date, is_from_me, handle_id)
        VALUES (40, 'BODY-ONLY', NULL, X'${blob.toString("hex")}', ${t}, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 40);
    `);
    const manifest = await exportPersonThread({
      slug: "test-attributed-body",
      handles: ["+14253260143"],
      since: "2024-01-01T00:00:00Z",
      db,
    });
    const dump = await readFile(`${manifest.outDir}/2024-10.txt`, "utf8");
    assert.match(dump, /We could watch a movie/);
    assert.doesNotMatch(dump, /\(empty\)/);
  });

  it("labels fromMe export lines as yan even when handle is the other person", () => {
    const line = formatExportLine(
      {
        at: "2024-09-01 12:00:00",
        fromMe: true,
        chat: "Nikita Vidolova",
        chatId: "+12066976688",
        handle: "+12066976688",
        text: "refund hasn't landed",
      },
      ["+12066976688"]
    );
    assert.match(line, /\| 1:1 \| yan \|/);
    assert.equal(
      speakerWho(
        {
          fromMe: true,
          handle: "+12066976688",
          chatId: "+12066976688",
        },
        ["+12066976688"]
      ),
      "yan"
    );
  });

  it("labels Yan as who=yan on 1:1 fromMe JSON rows", () => {
    const msg = rowToMessage({
      is_from_me: 1,
      handle_id: "+12066976688",
      chat_identifier: "+12066976688",
      chat_name: "Nikita Vidolova",
      text: "refund hasn't landed",
      at: "2026-08-24 06:33:25",
    });
    assert.equal(msg.who, "yan");
    assert.equal(msg.fromMe, true);
    assert.equal(msg.handle, "+12066976688");
  });

  it("labels the other person as them on 1:1 inbound JSON rows", () => {
    const msg = rowToMessage({
      is_from_me: 0,
      handle_id: "+12066976688",
      chat_identifier: "+12066976688",
      chat_name: "Nikita Vidolova",
      text: "ok",
      at: "2026-08-24 06:33:25",
    });
    assert.equal(msg.who, "them");
    assert.equal(msg.fromMe, false);
  });

  it("labels other senders by handle in group dumps", () => {
    const line = formatExportLine(
      {
        at: "2024-09-01 12:00:00",
        fromMe: false,
        chat: "JYPE",
        chatId: "chat123",
        handle: "+14253260143",
        text: "wait",
      },
      ["+15555550100"]
    );
    assert.match(line, /\| JYPE \| \+14253260143 \| wait/);
  });

  it("sharedChats export includes other people in the same group", async () => {
    const t = appleDate(new Date("2024-09-24T12:00:00Z"));
    const db = await makeChatDb(`
      ${SCHEMA}
      CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
      INSERT INTO handle(ROWID, id) VALUES (2, '+15555550100');
      INSERT INTO chat(ROWID, display_name, chat_identifier) VALUES (2, 'JYPE', 'chat-jype');
      INSERT INTO chat_handle_join VALUES (2, 1);
      INSERT INTO chat_handle_join VALUES (2, 2);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (30, 'G1', 'prasham hi', ${t}, 0, 2);
      INSERT INTO chat_message_join VALUES (2, 30);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (31, 'G2', 'jeffery hi', ${t + 100}, 0, 1);
      INSERT INTO chat_message_join VALUES (2, 31);
    `);
    const manifest = await exportPersonThread({
      slug: "test-shared-chats",
      handles: ["+15555550100"],
      since: "2024-09-01T00:00:00Z",
      db,
      sharedChats: true,
    });
    assert.equal(manifest.messages, 2);
    const body = await readFile(`${manifest.outDir}/2024-09.txt`, "utf8");
    assert.match(body, /prasham hi/);
    assert.match(body, /jeffery hi/);
    assert.match(body, /\+14253260143/);
  });

  it("pages a person export into monthly /tmp files", async () => {
    const t1 = appleDate(new Date("2024-09-01T12:00:00Z"));
    const t2 = appleDate(new Date("2024-09-02T12:00:00Z"));
    const t3 = appleDate(new Date("2024-10-01T12:00:00Z"));
    const db = await makeChatDb(`
      ${SCHEMA}
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (10, 'A', 'sep one', ${t1}, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 10);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (11, 'B', 'sep two', ${t2}, 1, 1);
      INSERT INTO chat_message_join VALUES (1, 11);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (12, 'C', 'oct hi', ${t3}, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 12);
    `);
    const manifest = await exportPersonThread({
      slug: "test-jeffery-export",
      handles: ["+14253260143"],
      since: "2024-01-01T00:00:00Z",
      db,
      pageSize: 2,
    });
    assert.equal(manifest.ok, true);
    assert.equal(manifest.messages, 3);
    assert.equal(manifest.pages >= 2, true);
    assert.deepEqual(
      manifest.files.map((f) => f.month),
      ["2024-09", "2024-10"]
    );
    const sep = await readFile(
      `${manifest.outDir}/2024-09.txt`,
      "utf8"
    );
    assert.match(sep, /sep one/);
    assert.match(sep, /sep two/);
    assert.doesNotMatch(sep, /oct hi/);
    assert.equal(manifest.files.some((f) => "text" in f), false);
  });

  it("filters recentThread by since", async () => {
    const old = appleDate(new Date("2024-01-01T12:00:00Z"));
    const fresh = appleDate(new Date("2026-08-01T12:00:00Z"));
    const db = await makeChatDb(`
      ${SCHEMA}
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (20, 'OLD', 'old ping', ${old}, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 20);
      INSERT INTO message(ROWID, guid, text, date, is_from_me, handle_id)
        VALUES (21, 'NEW', 'new ping', ${fresh}, 0, 1);
      INSERT INTO chat_message_join VALUES (1, 21);
    `);
    const rows = await recentThread("+14253260143", {
      db,
      since: "2026-01-01T00:00:00Z",
      previewStills: 0,
    });
    assert.equal(rows.length, 1);
    assert.match(rows[0].text, /new ping/);
  });
});
