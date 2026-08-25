import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createLocalIpcHandler } from "./local-ipc.js";

function mockReq(method, url, body) {
  const req = { method, url };
  if (body !== undefined) req.body = body;
  return req;
}

function mockRes() {
  /** @type {{ status: number, body: any }} */
  const out = { status: 0, body: null };
  return {
    out,
    writeHead(status) {
      out.status = status;
    },
    end(payload) {
      out.body = JSON.parse(String(payload));
    },
  };
}

describe("local ipc", () => {
  it("serves recent iMessage via injected reader", async () => {
    const handler = createLocalIpcHandler({
      recentMessages: async ({ since }) => [{ text: "hi", since }],
    });
    const res = mockRes();
    await handler(mockReq("GET", "/imessage/recent?since=2026-08-16"), res);
    assert.equal(res.out.status, 200);
    assert.equal(res.out.body[0].text, "hi");
    assert.equal(res.out.body[0].since, "2026-08-16");
  });

  it("sends iMessage via injected sender", async () => {
    let got = null;
    const handler = createLocalIpcHandler({
      sendIMessage: async (opts) => {
        got = opts;
        return { ok: true, to: "+14253260143" };
      },
    });
    const res = mockRes();
    await handler(
      mockReq("POST", "/imessage/send", { to: "Example Friend", text: "hi" }),
      res
    );
    assert.equal(res.out.status, 200);
    assert.equal(res.out.body.ok, true);
    assert.equal(got.to, "Example Friend");
    assert.equal(got.text, "hi");
  });

  it("starts context synthesis in the background", async () => {
    let called = false;
    const handler = createLocalIpcHandler({
      runContextSynthesis: async ({ force }) => {
        called = force === true;
        return { ok: true };
      },
    });
    const res = mockRes();
    await handler(mockReq("POST", "/jobs/context-synthesis"), res);
    assert.equal(res.out.status, 202);
    assert.equal(res.out.body.started, true);
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(called, true);
  });

  it("serves Screen Time summary via injected reader", async () => {
    const handler = createLocalIpcHandler({
      screenTimeSummary: async ({ days }) => ({ ok: true, days }),
    });
    const res = mockRes();
    await handler(mockReq("GET", "/screentime/summary?days=7"), res);
    assert.equal(res.out.status, 200);
    assert.equal(res.out.body.ok, true);
    assert.equal(res.out.body.days, "7");
  });

  it("exports iMessage via injected writer and returns stats only", async () => {
    let got = null;
    const handler = createLocalIpcHandler({
      exportPersonThread: async (opts) => {
        got = opts;
        return {
          ok: true,
          slug: opts.slug,
          messages: 12,
          files: [{ month: "2024-09", file: "2024-09.txt", lines: 12, bytes: 400 }],
        };
      },
    });
    const res = mockRes();
    await handler(
      mockReq("POST", "/imessage/export", {
        slug: "alex-rivera",
        handles: ["+15555550100"],
        since: "2024-08-21T00:00:00Z",
      }),
      res
    );
    assert.equal(res.out.status, 200);
    assert.equal(res.out.body.ok, true);
    assert.equal(res.out.body.messages, 12);
    assert.equal(got.slug, "alex-rivera");
    assert.deepEqual(got.handles, ["+15555550100"]);
    assert.equal(JSON.stringify(res.out.body).includes("hello prasham"), false);
  });
});
