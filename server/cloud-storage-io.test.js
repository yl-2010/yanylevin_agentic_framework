import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  isTransientCloudError,
  runCloudStorageIo,
  withCloudRetry,
} from "./cloud-storage-io.js";

describe("cloud storage io", () => {
  it("treats File Provider errno -11 as transient", () => {
    const err = Object.assign(new Error("deadlock"), {
      errno: -11,
      code: "Unknown system error -11",
    });
    assert.equal(isTransientCloudError(err), true);
    assert.equal(isTransientCloudError(Object.assign(new Error("nope"), { code: "ENOENT" })), false);
    assert.equal(isTransientCloudError(new SyntaxError("bad json")), false);
  });

  it("runs nested work inline and queues a second caller", async () => {
    /** @type {string[]} */
    const order = [];
    const first = runCloudStorageIo(async () => {
      order.push("outer-start");
      await runCloudStorageIo(async () => {
        order.push("inner");
      });
      order.push("outer-end");
    });
    const second = runCloudStorageIo(async () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    assert.deepEqual(order, ["outer-start", "inner", "outer-end", "second"]);
  });

  it("retries a cloud path then succeeds", async () => {
    const path = join("/Users/yan/Library/CloudStorage/OneDrive", "class.json");
    let tries = 0;
    const value = await withCloudRetry(path, async () => {
      tries += 1;
      if (tries < 3) {
        throw Object.assign(new Error("busy"), { errno: -11, code: "EDEADLK" });
      }
      return "ok";
    });
    assert.equal(value, "ok");
    assert.equal(tries, 3);
  });
});
