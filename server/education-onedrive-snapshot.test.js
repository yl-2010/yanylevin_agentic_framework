import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findSnapshotTodo,
  mergeClassRows,
  patchSnapshotTodo,
  readOnedriveSnapshot,
  resetOnedriveSnapshotState,
  writeOnedriveSnapshot,
} from "./education-onedrive-snapshot.js";

describe("onedrive class snapshot", () => {
  /** @type {string} */
  let dir;
  const prev = process.env.EDUCATION_ONEDRIVE_SNAPSHOT_DIR;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "edu-snap-"));
    process.env.EDUCATION_ONEDRIVE_SNAPSHOT_DIR = dir;
    resetOnedriveSnapshotState();
  });

  after(async () => {
    if (prev == null) delete process.env.EDUCATION_ONEDRIVE_SNAPSHOT_DIR;
    else process.env.EDUCATION_ONEDRIVE_SNAPSHOT_DIR = prev;
    resetOnedriveSnapshotState();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("keeps a todo the flaky walk did not return", () => {
    const prevRows = [
      {
        id: "physics",
        props: { name: "Physics" },
        todos: [
          { id: "hw-1", name: "One", _raw: { name: "One" } },
          { id: "hw-2", name: "Two", _raw: { name: "Two" } },
        ],
        dates: [],
        files: [{ name: "a.pdf" }, { name: "b.pdf" }],
      },
    ];
    const nextRows = [
      {
        id: "physics",
        props: { name: "Physics" },
        todos: [{ id: "hw-2", name: "Two renamed", _raw: { name: "Two renamed" } }],
        dates: [],
        files: [{ name: "a.pdf" }],
      },
    ];
    const merged = mergeClassRows(prevRows, nextRows, { incomplete: true });
    const todos = merged[0].todos.map((todo) => todo.id).sort();
    assert.deepEqual(todos, ["hw-1", "hw-2"]);
    assert.equal(merged[0].todos.find((todo) => todo.id === "hw-2").name, "Two renamed");
    assert.equal(merged[0].files.length, 2);
  });

  it("drops a removed todo after a clean walk", () => {
    const prevRows = [
      { id: "physics", todos: [{ id: "hw-1" }, { id: "hw-2" }], files: [] },
    ];
    const nextRows = [{ id: "physics", todos: [{ id: "hw-2" }], files: [] }];
    const merged = mergeClassRows(prevRows, nextRows, { incomplete: false });
    assert.deepEqual(
      merged[0].todos.map((todo) => todo.id),
      ["hw-2"]
    );
  });

  it("keeps the previous classes when the new walk came back empty", () => {
    const prevRows = [{ id: "physics", todos: [{ id: "hw-1" }] }];
    const merged = mergeClassRows(prevRows, [], { incomplete: true });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].id, "physics");
  });

  it("patches done onto the stored todo and reloads it", async () => {
    const email = "snapshot-test@example.com";
    await writeOnedriveSnapshot(email, {
      at: 1,
      rows: [
        {
          id: "physics",
          props: { name: "Physics" },
          todos: [
            {
              id: "hw-1",
              name: "One",
              done: false,
              _jsonPath: "/tmp/hw-1/.todo.json",
              _raw: { name: "One", done: false },
            },
          ],
          dates: [],
          files: [],
        },
      ],
      sourceClasses: [{ id: "physics", name: "Physics" }],
    });
    const raw = { name: "One", done: true, completedAt: "2026-10-25T00:00:00.000Z" };
    const patched = await patchSnapshotTodo(email, {
      classId: "physics",
      todoId: "hw-1",
      raw,
    });
    assert.equal(patched, true);
    resetOnedriveSnapshotState();
    const snap = await readOnedriveSnapshot(email);
    assert.equal(snap.rows[0].todos[0].done, true);
    assert.equal(snap.rows[0].todos[0]._raw.done, true);
    const found = await findSnapshotTodo(email, "physics", "hw-1");
    assert.equal(found.raw.done, true);
    assert.equal(found.jsonPath, "/tmp/hw-1/.todo.json");
  });
});
