import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commentRow,
  newComments,
  pageRow,
  moduleRow,
  courseFileRow,
  formatCommentsMarkdown,
  persistCanvasContext,
  markCanvasCommentsSeen,
  readSeenCommentIds,
} from "./canvas-context.js";

describe("commentRow", () => {
  it("keeps teacher text and drops empty html", () => {
    const row = commentRow(
      {
        id: 9,
        author_id: 44,
        author_name: "Lane Seeley",
        comment: "<p>Nice diagram.</p>",
        created_at: "2026-09-18T20:00:00Z",
        assignment_id: 40335975,
      },
      {
        courseId: 3646086,
        course: "Physics (Fall)",
        assignmentName: "HW: Motion Diagram Warm-Up",
        selfUserId: 99,
      }
    );
    assert.equal(row.id, 9);
    assert.equal(row.author, "Lane Seeley");
    assert.equal(row.own, false);
    assert.equal(row.comment, "Nice diagram.");
    assert.equal(row.assignmentId, 40335975);
    assert.equal(
      commentRow({ id: 2, comment: "Line one<br>Line two" })?.comment,
      "Line one\nLine two"
    );
    assert.equal(commentRow({ id: 1, comment: "   " }), null);
  });
});

describe("newComments", () => {
  it("returns ids not already seen", () => {
    const fresh = newComments(
      [
        { id: 1, comment: "old" },
        { id: 2, comment: "new" },
      ],
      new Set([1])
    );
    assert.deepEqual(
      fresh.map((c) => c.id),
      [2]
    );
  });
});

describe("pageRow / moduleRow / courseFileRow", () => {
  it("skips unpublished pages and strips body html", () => {
    assert.equal(pageRow({ title: "Hidden", published: false, body: "x" }), null);
    const page = pageRow(
      { title: "Unit 1", url: "unit-1", published: true, body: "<p>Read this</p>", front_page: true },
      { courseId: 1, course: "Physics" }
    );
    assert.equal(page.body, "Read this");
    assert.equal(page.frontPage, true);
  });

  it("nests module items", () => {
    const mod = moduleRow(
      {
        id: 3,
        name: "Unit 2",
        state: "unlocked",
        items: [
          { title: "Warm-up", type: "Assignment", content_id: 10 },
          { title: "Locked pdf", type: "File", content_details: { locked: true } },
        ],
      },
      { courseId: 1, course: "Physics" }
    );
    assert.equal(mod.items.length, 2);
    assert.equal(mod.items[1].locked, true);
  });

  it("keeps folder + file name", () => {
    const file = courseFileRow(
      { id: 88, display_name: "slides.pdf", size: 12 },
      { courseId: 1, course: "Physics", folder: "Unit 1" }
    );
    assert.equal(file.name, "slides.pdf");
    assert.equal(file.folder, "Unit 1");
  });
});

describe("persistCanvasContext", () => {
  it("writes comments-new from unseen ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canvas-ctx-"));
    await persistCanvasContext(dir, {
      updatedAt: "2026-09-18T00:00:00.000Z",
      comments: [
        {
          id: 1,
          course: "Physics",
          author: "Seeley",
          assignment: "Warm-Up",
          assignmentId: 9,
          createdAt: "2026-09-17T00:00:00Z",
          comment: "old note",
        },
        {
          id: 2,
          course: "Physics",
          author: "Seeley",
          assignment: "Warm-Up",
          assignmentId: 9,
          createdAt: "2026-09-18T00:00:00Z",
          comment: "new note",
        },
      ],
      pages: [],
      modules: [],
      files: [],
    });
    const firstNew = await readFile(join(dir, "comments-new.md"), "utf8");
    assert.match(firstNew, /new note/);
    assert.match(firstNew, /old note/);
    await markCanvasCommentsSeen(dir, [{ id: 1 }, { id: 2 }]);
    const seen = await readSeenCommentIds(dir);
    assert.equal(seen.has(2), true);
    await persistCanvasContext(dir, {
      updatedAt: "2026-09-19T00:00:00.000Z",
      comments: [
        { id: 1, course: "Physics", author: "Seeley", comment: "old note" },
        { id: 2, course: "Physics", author: "Seeley", comment: "new note" },
      ],
      pages: [],
      modules: [],
      files: [],
    });
    const later = await readFile(join(dir, "comments-new.md"), "utf8");
    assert.match(later, /none since last successful nightly/);
    assert.match(formatCommentsMarkdown([]), /\(none\)/);
  });
});
