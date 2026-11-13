import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createAgentWorkerServer } from "./agent-worker.js";
import {
  callAgentWorker,
  drainSseBuffer,
  startAgentWorkerBridge,
} from "./agent-worker-client.js";

/** Fake worker: sessions live here, like personal-agent.js does in the real one. */
function fakeWorker() {
  /** @type {Set<Function>} */
  const taps = new Set();
  const sessions = new Map([["s1", { status: "running", workingLabel: "Working" }]]);
  const handlers = {
    getRunningAgents: async () => ({
      ok: true,
      sessions: [...sessions].map(([sessionId, s]) => ({ sessionId, ...s })),
    }),
    getAgentState: (sid) => {
      const s = sessions.get(sid);
      if (!s) {
        const err = new Error("session not found");
        err.status = 404;
        throw err;
      }
      return { ok: true, sessionId: sid, ...s };
    },
  };
  const notify = (email, event, data) => {
    for (const fn of taps) fn(email, event, data);
  };
  const { server } = createAgentWorkerServer({
    handlers,
    onNotify: (fn) => {
      taps.add(fn);
      return () => taps.delete(fn);
    },
    heartbeatMs: 50,
  });
  return { server, notify, sessions };
}

async function listen(server, port = 0) {
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timed out");
}

describe("agent worker rpc", () => {
  it("returns results and keeps the handler's error status", async () => {
    const { server } = fakeWorker();
    const baseUrl = await listen(server);
    try {
      const running = await callAgentWorker("getRunningAgents", ["a@b.c"], {
        baseUrl,
        fetchImpl: fetch,
      });
      assert.equal(running.sessions[0].status, "running");
      await assert.rejects(
        callAgentWorker("getAgentState", ["nope", "a@b.c"], { baseUrl, fetchImpl: fetch }),
        (err) => err.status === 404 && /session not found/.test(err.message)
      );
    } finally {
      server.close();
    }
  });

  it("answers 503, never 404, while the worker is down", async () => {
    await assert.rejects(
      callAgentWorker("getAgentState", ["s1", "a@b.c"], {
        baseUrl: "http://127.0.0.1:9",
        fetchImpl: fetch,
      }),
      (err) => err.status === 503
    );
  });

  it("rejects methods outside the allowlist", async () => {
    await assert.rejects(callAgentWorker("disposeSession", []), /not allowed/);
  });
});

describe("agent worker event bridge", () => {
  it("parses SSE blocks and keeps the partial tail", () => {
    const seen = [];
    const rest = drainSseBuffer(
      'event: notify\ndata: {"a":1}\n\n: ping\n\nevent: notify\ndata: {"b"',
      (e, d) => seen.push([e, d])
    );
    assert.deepEqual(seen, [["notify", '{"a":1}']]);
    assert.equal(rest, 'event: notify\ndata: {"b"');
  });

  it("forwards status events and re-attaches after an API restart", async () => {
    const worker = fakeWorker();
    const baseUrl = await listen(worker.server);
    const got = [];
    const notify = (email, event, data) => got.push({ email, event, data });

    let bridge = startAgentWorkerBridge({ baseUrl, notify, retryMs: 50 });
    try {
      await waitFor(() => bridge.connected());
      worker.notify("yan@x.com", "change", { source: "agent", sessionId: "s1", status: "running" });
      await waitFor(() => got.length === 1);
      assert.equal(got[0].data.status, "running");

      // API process dies; the run keeps going in the worker.
      bridge.close();
      worker.notify("yan@x.com", "change", { source: "agent", sessionId: "s1", workingLabel: "Reading" });

      // New API process: state is still there and new events flow.
      bridge = startAgentWorkerBridge({ baseUrl, notify, retryMs: 50 });
      await waitFor(() => bridge.connected());
      const running = await callAgentWorker("getRunningAgents", ["yan@x.com"], {
        baseUrl,
        fetchImpl: fetch,
      });
      assert.deepEqual(running.sessions, [
        { sessionId: "s1", status: "running", workingLabel: "Working" },
      ]);
      worker.sessions.get("s1").status = "idle";
      worker.notify("yan@x.com", "change", { source: "agent", sessionId: "s1", status: "idle" });
      await waitFor(() => got.some((g) => g.data.status === "idle"));
    } finally {
      bridge.close();
      worker.server.closeAllConnections?.();
      worker.server.close();
    }
  });

  it("reconnects when the worker itself restarts", async () => {
    let worker = fakeWorker();
    const baseUrl = await listen(worker.server);
    const port = Number(new URL(baseUrl).port);
    const got = [];
    const bridge = startAgentWorkerBridge({
      baseUrl,
      notify: (email, event, data) => got.push(data),
      retryMs: 50,
    });
    try {
      await waitFor(() => bridge.connected());
      worker.server.closeAllConnections();
      worker.server.close();
      await waitFor(() => !bridge.connected());
      worker = fakeWorker();
      await listen(worker.server, port);
      await waitFor(() => bridge.connected());
      worker.notify("yan@x.com", "change", { status: "running" });
      await waitFor(() => got.length === 1);
    } finally {
      bridge.close();
      worker.server.closeAllConnections?.();
      worker.server.close();
    }
  });
});

describe("agent worker restart-when-idle", () => {
  it("waits for running chats to finish, then exits", async () => {
    let busy = 1;
    let exited = 0;
    const { server } = createAgentWorkerServer({
      handlers: {},
      onNotify: () => () => {},
      busy: () => busy,
      exit: () => {
        exited += 1;
      },
      idlePollMs: 20,
    });
    const baseUrl = await listen(server);
    try {
      const res = await fetch(`${baseUrl}/restart-when-idle`, { method: "POST" });
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.busySessions, 1);
      const health = await (await fetch(`${baseUrl}/health`)).json();
      assert.equal(health.restartPending, true);
      await new Promise((r) => setTimeout(r, 120));
      assert.equal(exited, 0);
      busy = 0;
      await waitFor(() => exited === 1);
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(exited, 1);
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
