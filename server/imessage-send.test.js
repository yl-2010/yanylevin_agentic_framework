import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  IMESSAGE_SEND_SCRIPT,
  findChatGuid,
  findNamedChat,
  normalizeHandle,
  resolveHandle,
  sendIMessage,
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
      /text is required/
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
});
