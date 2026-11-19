import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBrainSnapshotHandler } from "./brain-site.js";

const response = () => ({
  headers: {}, statusCode: 200, body: undefined,
  setHeader(k, v) { this.headers[k] = v; },
  status(n) { this.statusCode = n; return this; },
  json(d) { this.body = d; },
  type(t) { this.contentType = t; return this; },
  send(t) { this.body = t; },
});
test("brain snapshot is Yan-only, no-store, and raw JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "yl-brain-test-"));
  try {
    const p = join(dir, "brain.json"), body = '{"nodes":[{"id":"yan"}],"edges":[]}';
    await writeFile(p, body);
    const handler = createBrainSnapshotHandler({ snapshotPath: p });
    for (const email of ["you@example.com", "you@icloud.com"]) {
      const res = response(); await handler({ user: { email } }, res);
      assert.equal(res.statusCode, 200); assert.equal(res.body, body);
      assert.equal(res.headers["Cache-Control"], "no-store");
      assert.equal(res.contentType, "application/json");
    }
    for (const email of ["you@example.com", "friend@example.com", "anyone@example.com", undefined]) {
      const res = response(); await handler({ user: { email } }, res);
      assert.equal(res.statusCode, 403); assert.equal(res.body.error, "forbidden");
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test("missing snapshot fails closed", async () => {
  const res = response();
  await createBrainSnapshotHandler({ snapshotPath: "/tmp/nonexistent-brain-snapshot-test.json" })({ user: { email: "you@example.com" } }, res);
  assert.equal(res.statusCode, 404); assert.equal(res.headers["Cache-Control"], "no-store");
});
