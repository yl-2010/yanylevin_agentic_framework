import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IMESSAGE_SEND_SCRIPT,
  findChatGuid,
  findNamedChat,
  normalizeHandle,
  normalizeSendFiles,
  queueIMessageReplyFiles,
  resetIMessageReplyFiles,
  resolveHandle,
  sendIMessage,
  takeIMessageReplyFiles,
} from "./imessage-send.js";

describe("imessage-send", () => {
  it("normalizes US phones and leaves emails", () => {
    assert.equal(normalizeHandle("4253260143"), "+14253260143");
    assert.equal(normalizeHandle("(425) 326-0143"), "+14253260143");
    assert.equal(normalizeHandle("+1 425 326 0143"), "+14253260143");
    assert.equal(normalizeHandle("jeff@icloud.com"), "jeff@icloud.com");
    assert.equal(normalizeHandle("Example Friend"), "Example Friend");
  });

  it("resolves a unique contact name to a phone", async () => {
    const handle = await resolveHandle("Example Friend", {
      listContacts: async () => [
        { name: "Example Friend", first: "Example Friend", last: "Xu", phones: "+1 (425) 326-0143" },
        { name: "Alex Rivera", first: "Alex", phones: "+1 (425) 555-0100" },
      ],
    });
    assert.equal(handle, "+14253260143");
  });

  it("rejects missing fields without calling osascript", async () => {
    await assert.rejects(() => sendIMessage({ to: "", text: "hi" }), /to is required/);
    await assert.rejects(
      () => sendIMessage({ to: "+14253260143", text: "   " }),
      /text or files required/
    );
  });

  it("writes the body file and invokes osascript", async () => {
    /** @type {string[]|null} */
    let args = null;
    const result = await sendIMessage(
      { to: "+14253260143", text: "hello from test" },
      {
        resolveHandle: async () => "+14253260143",
        findChatGuid: async () => "iMessage;-;+14253260143",
        execFile: async (cmd, argv) => {
          assert.equal(cmd, "osascript");
          args = argv;
          const written = await readFile(argv[2], "utf8");
          assert.equal(written, "hello from test");
          return { stdout: "sent-chat\n", stderr: "" };
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.to, "+14253260143");
    assert.equal(result.via, "sent-chat");
    assert.equal(args?.[0], IMESSAGE_SEND_SCRIPT);
    assert.equal(args?.[1], "+14253260143");
    assert.equal(args?.[3], "iMessage;-;+14253260143");
    const body = await readFile(args[2], "utf8").catch(() => "");
    assert.equal(body, "", "temp body file should be removed");
  });

  it("returns chat guid from injected query", async () => {
    const guid = await findChatGuid("+14253260143", {
      queryMessages: async () => [{ guid: "iMessage;-;+14253260143" }],
    });
    assert.equal(guid, "iMessage;-;+14253260143");
  });

  it("matches an existing group by display name", async () => {
    const named = await findNamedChat("JYPE", {
      queryMessages: async () => [
        { guid: "iMessage;+;chat123", name: "JYPE", ident: "chat123" },
      ],
    });
    assert.equal(named?.guid, "iMessage;+;chat123");
    assert.equal(named?.name, "JYPE");
  });

  it("sends to a named group when Contacts has no match", async () => {
    /** @type {string[]|null} */
    let args = null;
    const result = await sendIMessage(
      { to: "JYPE", text: "OOOOOOOOOOOOOOO" },
      {
        resolveHandle: async () => {
          const err = new Error("no iMessage handle for JYPE");
          err.status = 400;
          throw err;
        },
        findNamedChat: async () => ({
          guid: "iMessage;+;chat123",
          name: "JYPE",
          ident: "chat123",
        }),
        execFile: async (cmd, argv) => {
          assert.equal(cmd, "osascript");
          args = argv;
          return { stdout: "sent-chat\n", stderr: "" };
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.to, "JYPE");
    assert.equal(result.chatGuid, "iMessage;+;chat123");
    assert.equal(args?.[3], "iMessage;+;chat123");
  });

  it("sends with an explicit chatGuid without Contacts", async () => {
    /** @type {string[]|null} */
    let args = null;
    const result = await sendIMessage(
      { to: "JYPE", text: "hi", chatGuid: "iMessage;+;chat123" },
      {
        resolveHandle: async () => {
          throw new Error("should not resolve");
        },
        execFile: async (cmd, argv) => {
          args = argv;
          return { stdout: "sent-chat\n", stderr: "" };
        },
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.to, "JYPE");
    assert.equal(args?.[3], "iMessage;+;chat123");
  });

  it("falls back to chat_identifier when the name is not a contact", async () => {
    const result = await sendIMessage(
      { to: "chat123", text: "hi" },
      {
        resolveHandle: async () => {
          const err = new Error("no iMessage handle for chat123");
          err.status = 400;
          throw err;
        },
        findNamedChat: async () => null,
        findChatGuid: async (q) => (q === "chat123" ? "iMessage;+;chat123" : ""),
        execFile: async () => ({ stdout: "sent-chat\n", stderr: "" }),
      }
    );
    assert.equal(result.ok, true);
    assert.equal(result.chatGuid, "iMessage;+;chat123");
  });

  it("normalizes file lists and queues @agent reply files", () => {
    assert.deepEqual(normalizeSendFiles([" /a.jpg ", "", "/b.pdf"]), [
      "/a.jpg",
      "/b.pdf",
    ]);
    resetIMessageReplyFiles();
    queueIMessageReplyFiles({ to: "JYPE", chatGuid: "iMessage;+;chat123" }, [
      "/tmp/a.jpg",
    ]);
    assert.deepEqual(takeIMessageReplyFiles({ to: "jype" }), ["/tmp/a.jpg"]);
    assert.deepEqual(takeIMessageReplyFiles({ to: "jype" }), []);
  });

  it("sends files first then text in one osascript call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yanylevin-imessage-file-"));
    const pic = join(dir, "pic.jpg");
    await writeFile(pic, Buffer.from("jpeg"));
    /** @type {string[]|null} */
    let args = null;
    try {
      const result = await sendIMessage(
        { to: "+14253260143", text: "caption", files: [pic] },
        {
          resolveHandle: async () => "+14253260143",
          findChatGuid: async () => "iMessage;-;+14253260143",
          execFile: async (cmd, argv) => {
            assert.equal(cmd, "osascript");
            args = argv;
            const written = await readFile(argv[2], "utf8");
            assert.equal(written, "caption");
            return { stdout: "sent-chat\n", stderr: "" };
          },
        }
      );
      assert.equal(result.ok, true);
      assert.equal(result.files.length, 1);
      assert.ok(result.files[0].endsWith("/pic.jpg"));
      assert.equal(args?.[0], IMESSAGE_SEND_SCRIPT);
      assert.equal(args?.[1], "+14253260143");
      assert.equal(args?.[3], "iMessage;-;+14253260143");
      assert.equal(args?.[4], result.files[0]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("sends files only when there is no text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "yanylevin-imessage-file-"));
    const pic = join(dir, "pic.jpg");
    await writeFile(pic, Buffer.from("jpeg"));
    try {
      const result = await sendIMessage(
        { to: "+14253260143", files: [pic] },
        {
          resolveHandle: async () => "+14253260143",
          findChatGuid: async () => "g",
          execFile: async (_cmd, argv) => {
            const written = await readFile(argv[2], "utf8");
            assert.equal(written, "");
            assert.ok(String(argv[4] || "").endsWith("/pic.jpg"));
            return { stdout: "sent-chat\n", stderr: "" };
          },
        }
      );
      assert.equal(result.ok, true);
      assert.equal(result.files.length, 1);
      assert.ok(result.files[0].endsWith("/pic.jpg"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a missing file without calling osascript", async () => {
    let called = false;
    await assert.rejects(
      () =>
        sendIMessage(
          { to: "+14253260143", files: ["/tmp/yanylevin-missing-imessage-file"] },
          {
            execFile: async () => {
              called = true;
              return { stdout: "sent-chat\n", stderr: "" };
            },
          }
        ),
      /file not found/
    );
    assert.equal(called, false);
  });
});
