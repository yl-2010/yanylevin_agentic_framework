import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isCursorAuthFailure,
  isCursorCapacityFailure,
  promptWithAuthRetry,
  createLaterAuthRetry,
  reloadCursorApiKeyFromEnv,
  scheduledPreferredDelaysMs,
  NIGHTLY_GROK_DELAYS_MS,
  CAPACITY_LATER_RETRY_MS,
  INTERACTIVE_MODEL_DELAYS_MS,
  INTERACTIVE_FALLBACK_DELAYS_MS,
  AUTO_MODEL_SELECTION,
  WORKING_LABEL_AUTO,
  WORKING_LABEL_DEFAULT,
  WORKING_LABEL_GROK,
  workingLabelForAttempt,
  formatLogValue,
  runWithModelFallback,
  evictLocalCursorExecutor,
  onLocalCursorExecutorEvict,
} from "./cursor-sdk-auth.js";

describe("isCursorAuthFailure", () => {
  it("matches the SDK logout-and-back-in error_code", () => {
    assert.equal(
      isCursorAuthFailure(null, {
        status: "error",
        error_code:
          "Authentication error If you are logged in, try logging out and back in.",
      }),
      true
    );
  });

  it("matches AuthenticationError by name", () => {
    const err = new Error("nope");
    err.name = "AuthenticationError";
    assert.equal(isCursorAuthFailure(err), true);
  });

  it("treats a fast empty status=error as auth (wait() omits error_code)", () => {
    assert.equal(
      isCursorAuthFailure(null, { status: "ERROR", result: "" }, 267),
      true
    );
  });

  it("does not treat a long failed run with no text as auth", () => {
    assert.equal(
      isCursorAuthFailure(null, { status: "error", result: "" }, 60_000),
      false
    );
  });

  it("does not treat a finished run as auth", () => {
    assert.equal(
      isCursorAuthFailure(null, { status: "finished", result: "ok" }, 200),
      false
    );
  });

  it("does not treat Grok high-load as auth", () => {
    const err = new Error(
      "High Load. We're experiencing high demand for Cursor Grok 4.6 right now. Please switch to Auto, another model, or try again in a few moments."
    );
    err.status = 429;
    assert.equal(isCursorAuthFailure(err), false);
  });
});

describe("isCursorCapacityFailure", () => {
  it("matches Grok high-load copy", () => {
    const err = new Error(
      "High Load. We're experiencing high demand for Cursor Grok 4.6 right now. Please switch to Auto, another model, or try again in a few moments. Request ID: c8996da1-9c20-4163-98da-ed60a22e067c"
    );
    assert.equal(isCursorCapacityFailure(err), true);
  });

  it("matches Auto high-load copy (no model name)", () => {
    const err = new Error(
      "High Load. We're experiencing high demand right now. Please try again in a few moments. Request ID: 46800628-4f46-418b-ae1b-7eebdbbc0a04"
    );
    assert.equal(isCursorCapacityFailure(err), true);
    assert.equal(isCursorAuthFailure(err), false);
  });
});

describe("retry schedules", () => {
  it("gives interactive agents a first send plus two Grok reconnects", () => {
    assert.deepEqual(INTERACTIVE_MODEL_DELAYS_MS, [0, 2000, 2000]);
    assert.equal(INTERACTIVE_FALLBACK_DELAYS_MS.length, 2);
  });

  it("gives nightly Grok jobs eight preferred-model attempts", () => {
    assert.equal(NIGHTLY_GROK_DELAYS_MS.length, 8);
    assert.equal(scheduledPreferredDelaysMs({ id: "grok-4.6" }).length, 8);
    assert.ok(scheduledPreferredDelaysMs({ id: "composer-2.5" }).length < 8);
  });

  it("waits 5 minutes three times before escalating nightly high-load retries", () => {
    const five = 5 * 60 * 1000;
    assert.deepEqual(CAPACITY_LATER_RETRY_MS.slice(0, 3), [five, five, five]);
    assert.ok(CAPACITY_LATER_RETRY_MS[3] > five);
  });
});

describe("workingLabelForAttempt", () => {
  it("uses Working on the first Grok attempt", () => {
    assert.equal(
      workingLabelForAttempt({
        model: { id: "grok-4.6" },
        isFallback: false,
        recreate: false,
      }),
      WORKING_LABEL_DEFAULT
    );
  });

  it("uses Grok reconnect copy on a Grok retry", () => {
    assert.equal(
      workingLabelForAttempt({
        model: { id: "grok-4.6" },
        isFallback: false,
        recreate: true,
      }),
      WORKING_LABEL_GROK
    );
  });

  it("uses Auto reconnect copy on fallback", () => {
    assert.equal(
      workingLabelForAttempt({
        model: { id: "auto" },
        isFallback: true,
        recreate: true,
      }),
      WORKING_LABEL_AUTO
    );
  });
});

describe("reloadCursorApiKeyFromEnv", () => {
  it("loads CURSOR_API_KEY from a dotenv file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-auth-"));
    const envPath = join(dir, ".env");
    const prev = process.env.CURSOR_API_KEY;
    try {
      await writeFile(envPath, 'CURSOR_API_KEY="cursor_test_reload"\n');
      const ok = await reloadCursorApiKeyFromEnv(envPath);
      assert.equal(ok, true);
      assert.equal(process.env.CURSOR_API_KEY, "cursor_test_reload");
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("promptWithAuthRetry", () => {
  it("retries on AuthenticationError then succeeds", async () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "cursor_test_retry";
    let n = 0;
    try {
      const { result, authFailed } = await promptWithAuthRetry({
        prefix: "test",
        delaysMs: [0, 1, 1],
        laterDelaysMs: [],
        fallbackModel: null,
        promptFn: async () => {
          n += 1;
          if (n === 1) {
            const err = new Error("nope");
            err.name = "AuthenticationError";
            throw err;
          }
          return { status: "finished", result: "ok" };
        },
      });
      assert.equal(n, 2);
      assert.equal(authFailed, false);
      assert.equal(result.status, "finished");
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });

  it("returns authFailed after exhausting retries", async () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "cursor_test_retry";
    try {
      const { authFailed, result } = await promptWithAuthRetry({
        prefix: "test",
        delaysMs: [0, 1],
        laterDelaysMs: [],
        fallbackModel: null,
        promptFn: async () => ({ status: "error", result: "" }),
      });
      assert.equal(authFailed, true);
      assert.equal(String(result?.status).toLowerCase(), "error");
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });

  it("falls back to auto after two Grok high-load failures", async () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "cursor_test_retry";
    /** @type {string[]} */
    const ids = [];
    try {
      const { result, usedFallback, capacityFailed } = await promptWithAuthRetry({
        prefix: "test",
        model: { id: "grok-4.6", params: [] },
        delaysMs: [0, 1],
        fallbackDelaysMs: [0],
        laterDelaysMs: [],
        promptFn: async (_key, model) => {
          ids.push(model.id);
          if (model.id !== "auto") {
            const err = new Error(
              "High Load. We're experiencing high demand for Cursor Grok 4.6 right now. Please switch to Auto."
            );
            err.status = 429;
            throw err;
          }
          return { status: "finished", result: "ok" };
        },
      });
      assert.deepEqual(ids, ["grok-4.6", "grok-4.6", "auto"]);
      assert.equal(usedFallback, true);
      assert.equal(capacityFailed, false);
      assert.equal(result.status, "finished");
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });

  it("waits then retries auto after auto high-load too", async () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "cursor_test_retry";
    let n = 0;
    const t0 = Date.now();
    try {
      const { result, usedFallback } = await promptWithAuthRetry({
        prefix: "test",
        model: { id: "grok-4.6", params: [] },
        delaysMs: [0, 0],
        fallbackDelaysMs: [0, 0],
        laterDelaysMs: [25],
        promptFn: async () => {
          n += 1;
          if (n < 5) {
            const err = new Error(
              "High Load. We're experiencing high demand right now. Please try again in a few moments."
            );
            err.status = 429;
            throw err;
          }
          return { status: "finished", result: "ok" };
        },
      });
      assert.equal(n, 5);
      assert.equal(usedFallback, true);
      assert.equal(result.status, "finished");
      assert.ok(Date.now() - t0 >= 20);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });
});

describe("createLaterAuthRetry", () => {
  it("schedules then clears same-day follow-ups", async () => {
    let runs = 0;
    const later = createLaterAuthRetry({
      prefix: "test",
      delaysMs: [20],
      run: async () => {
        runs += 1;
      },
    });
    later.schedule("2026-08-16");
    assert.equal(later.attempt, 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(runs, 1);
    later.clear();
    assert.equal(later.attempt, 0);
  });
});

describe("formatLogValue", () => {
  it("json-stringifies error objects instead of [object Object]", () => {
    assert.equal(formatLogValue({ code: "unauthenticated" }), '{"code":"unauthenticated"}');
    assert.equal(formatLogValue("plain"), "plain");
  });
});

describe("runWithModelFallback interactive ladder", () => {
  it("reconnects Grok twice then Auto twice", async () => {
    const prev = process.env.CURSOR_API_KEY;
    process.env.CURSOR_API_KEY = "cursor_test_retry";
    /** @type {{ id: string, recreate: boolean, isFallback: boolean }[]} */
    const calls = [];
    try {
      await runWithModelFallback({
        prefix: "test",
        preferredModel: { id: "grok-4.6", params: [] },
        delaysMs: [0, 0, 0],
        fallbackModel: AUTO_MODEL_SELECTION,
        fallbackDelaysMs: [0, 0],
        laterDelaysMs: [],
        onBeforeAttempt: async ({ model, recreate, isFallback }) => {
          calls.push({
            id: String(model.id),
            recreate: Boolean(recreate),
            isFallback: Boolean(isFallback),
          });
        },
        run: async () => ({ status: "error", result: "" }),
      });
      assert.deepEqual(calls, [
        { id: "grok-4.6", recreate: false, isFallback: false },
        { id: "grok-4.6", recreate: true, isFallback: false },
        { id: "grok-4.6", recreate: true, isFallback: false },
        { id: "auto", recreate: true, isFallback: true },
        { id: "auto", recreate: true, isFallback: true },
      ]);
    } finally {
      if (prev === undefined) delete process.env.CURSOR_API_KEY;
      else process.env.CURSOR_API_KEY = prev;
    }
  });
});

describe("evictLocalCursorExecutor", () => {
  it("notifies owners so they can drop disposed handles", async () => {
    let n = 0;
    const stop = onLocalCursorExecutorEvict(() => {
      n += 1;
    });
    try {
      await evictLocalCursorExecutor();
      assert.equal(n, 1);
    } finally {
      stop();
    }
  });
});
