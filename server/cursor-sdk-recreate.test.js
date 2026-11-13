import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

/** Swap @cursor/sdk for a stub in this test process only. */
const stub = `
let n = 0;
export const disposed = [];
export const Agent = {
  async create() {
    const id = ++n;
    return { id, async [Symbol.asyncDispose]() { disposed.push(id); } };
  },
};
`;
const hooks = `
export async function resolve(spec, ctx, next) {
  if (spec === "@cursor/sdk") {
    return { url: "data:text/javascript," + encodeURIComponent(${JSON.stringify(stub)}), shortCircuit: true };
  }
  return next(spec, ctx);
}
`;

/** @type {typeof import("./cursor-sdk-auth.js")} */
let auth;
/** @type {{ disposed: number[] }} */
let sdk;

before(async () => {
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  process.env.CURSOR_API_KEY = process.env.CURSOR_API_KEY || "test-key";
  auth = await import("./cursor-sdk-auth.js");
  sdk = /** @type {any} */ (await import("@cursor/sdk"));
});

describe("recreateLocalCursorAgent", () => {
  it("replaces only the failing chat's agent", async () => {
    const model = { id: "auto" };
    const a = await auth.createLocalCursorAgent({ model, cwd: "/tmp" });
    const b = await auth.createLocalCursorAgent({ model, cwd: "/tmp" });
    let evicts = 0;
    const stop = auth.onLocalCursorExecutorEvict(() => {
      evicts += 1;
    });
    try {
      let attached = null;
      const fresh = await auth.recreateLocalCursorAgent({
        model,
        cwd: "/tmp",
        previous: a,
        attach: (agent) => {
          attached = agent;
        },
      });
      assert.equal(attached, fresh);
      assert.deepEqual(sdk.disposed, [a.id]);
      assert.equal(evicts, 0);
      assert.notEqual(fresh.id, b.id);
    } finally {
      stop();
    }
  });

  it("full evict still disposes every agent and tells owners", async () => {
    let evicts = 0;
    const stop = auth.onLocalCursorExecutorEvict(() => {
      evicts += 1;
    });
    try {
      await auth.evictLocalCursorExecutor();
      assert.equal(evicts, 1);
      assert.ok(sdk.disposed.length >= 3);
    } finally {
      stop();
    }
  });
});
