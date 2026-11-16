import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGradeWatch,
  fillGradeWatchText,
  listPublicGradeWatches,
  pollGradeWatchesOnce,
  sortGradeWatchesNewestFirst,
  submissionIsPosted,
} from "./grade-watch.js";

const courseMap = {
  "3639038": "advanced-calculus",
  "3646086": "physics",
};
const assignments = [
  {
    id: 1,
    courseId: 3639038,
    course: "Advanced Calculus",
    title: "MA Nov 10",
    pointsPossible: 10,
    htmlUrl: "https://canvas.instructure.com/courses/3639038/assignments/1",
  },
  {
    id: 2,
    courseId: 3639038,
    course: "Advanced Calculus",
    title: "Quiz 3",
    pointsPossible: 10,
    htmlUrl: "https://canvas.instructure.com/courses/3639038/assignments/2",
  },
  {
    id: 3,
    courseId: 999,
    course: "Other",
    title: "Secret",
    pointsPossible: 5,
    htmlUrl: "https://canvas.instructure.com/courses/999/assignments/3",
  },
  {
    id: 4,
    courseId: 3646086,
    course: "Physics",
    title: "MA Nov 10",
    pointsPossible: 20,
    htmlUrl: "https://canvas.instructure.com/courses/3646086/assignments/4",
  },
];

function deps(root, extra = {}) {
  return {
    root,
    assignments,
    courseMap,
    fetchSubmission: async () => ({ score: null, grade: "", workflow_state: "graded" }),
    resolveImessage: async ({ to, chatGuid }) => ({
      to,
      chatGuid: chatGuid || "iMessage;+;yan",
    }),
    resolveTeams: async ({ chat }) => ({ chatId: "19:prasham", chatName: chat }),
    sendImessage: async () => ({ ok: true }),
    sendTeams: async () => ({ ok: true }),
    ...extra,
  };
}

describe("submissionIsPosted", () => {
  it("ignores a graded row with an empty score, including entered_score", () => {
    assert.equal(
      submissionIsPosted({
        workflow_state: "graded",
        score: null,
        entered_score: 10,
        grade: "",
        entered_grade: "10",
      }),
      false
    );
    assert.equal(submissionIsPosted({ workflow_state: "graded", score: null, grade: "" }), false);
    assert.equal(submissionIsPosted(null), false);
  });

  it("counts a real 0, a grade string, and excused", () => {
    assert.equal(submissionIsPosted({ score: 0, grade: "" }), true);
    assert.equal(submissionIsPosted({ score: null, grade: "A" }), true);
    assert.equal(submissionIsPosted({ excused: true, score: null, grade: "" }), true);
  });
});

describe("fillGradeWatchText", () => {
  it("fills known tokens and leaves an unknown or empty one", () => {
    const filled = fillGradeWatchText("{assignment} is {grade}. {score}/{points}. {nope}", {
      assignment: "Quiz 3",
      grade: "8/10",
      score: "8",
      points: "10",
      nope: "",
    });
    assert.equal(filled, "Quiz 3 is 8/10. 8/10. {nope}");
  });
});

describe("sortGradeWatchesNewestFirst", () => {
  it("puts the newest createdAt first", () => {
    const rows = sortGradeWatchesNewestFirst([
      { id: "a", createdAt: "2026-11-01T00:00:00.000Z" },
      { id: "c", createdAt: "2026-11-03T00:00:00.000Z" },
      { id: "b", createdAt: "2026-11-02T00:00:00.000Z" },
    ]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ["c", "b", "a"]
    );
  });
});

describe("createGradeWatch", () => {
  /** @type {string[]} */
  const dirs = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tempRoot() {
    const dir = await mkdtemp(join(tmpdir(), "grade-watch-"));
    dirs.push(dir);
    return dir;
  }

  it("rejects a course Yan is not taking and writes nothing", async () => {
    const dir = await tempRoot();
    const result = await createGradeWatch(
      {
        assignment: "https://canvas.instructure.com/courses/999/assignments/3",
        messages: [{ channel: "imessage", to: "Yan", text: "up" }],
      },
      deps(dir)
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /not one of Yan's Canvas courses/);
    assert.deepEqual(await listPublicGradeWatches({ root: dir }), []);
  });

  it("returns several matches and does not save", async () => {
    const dir = await tempRoot();
    const result = await createGradeWatch(
      {
        assignment: "MA Nov 10",
        messages: [{ channel: "imessage", to: "Yan", text: "up {grade}" }],
      },
      deps(dir)
    );
    assert.equal(result.ok, false);
    assert.equal(result.matches.length, 2);
    assert.deepEqual(await listPublicGradeWatches({ root: dir }), []);
  });

  it("lists newest watches first", async () => {
    const dir = await tempRoot();
    const first = await createGradeWatch(
      {
        assignment: "Quiz 3",
        messages: [{ channel: "imessage", to: "Yan", text: "first" }],
      },
      deps(dir, { now: "2026-11-01T00:00:00.000Z" })
    );
    const second = await createGradeWatch(
      {
        assignment: "MA Nov 10",
        course: "physics",
        messages: [{ channel: "teams", chat: "Alex", text: "second" }],
      },
      deps(dir, { now: "2026-11-02T00:00:00.000Z" })
    );
    assert.equal(first.watching, true);
    assert.equal(second.watching, true);
    const listed = await listPublicGradeWatches({ root: dir });
    assert.deepEqual(
      listed.map((row) => row.id),
      [second.id, first.id]
    );
  });

  it("sends once when the grade is already posted", async () => {
    const dir = await tempRoot();
    const sent = [];
    const result = await createGradeWatch(
      {
        assignment: "Quiz 3",
        messages: [{ channel: "imessage", to: "Yan", text: "Quiz is {grade}" }],
      },
      deps(dir, {
        fetchSubmission: async () => ({ score: 8, grade: "8", workflow_state: "graded" }),
        sendImessage: async (opts) => {
          sent.push(opts);
          return { ok: true };
        },
      })
    );
    assert.equal(result.sent, true);
    assert.equal(result.grade, "8/10");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Quiz is 8\/10/);
    assert.match(sent[0].text, /Sent by Yan's Personal Agent/);
    assert.deepEqual(await listPublicGradeWatches({ root: dir }), []);
  });

  it("does not send the first chat again after a partial failure", async () => {
    const dir = await tempRoot();
    /** @type {{ channel: string, text: string }[]} */
    const sent = [];
    let teamsFails = true;
    const created = await createGradeWatch(
      {
        assignment: "Quiz 3",
        messages: [
          { channel: "imessage", to: "Yan", text: "up {grade}" },
          { channel: "teams", chat: "Alex", text: "up {grade}" },
        ],
      },
      deps(dir)
    );
    assert.equal(created.watching, true);
    assert.equal(sent.length, 0);

    const shared = deps(dir, {
      fetchSubmission: async () => ({ score: 8, grade: "8", workflow_state: "graded" }),
      sendImessage: async (opts) => {
        sent.push({ channel: "imessage", text: opts.text });
        return { ok: true };
      },
      sendTeams: async (opts) => {
        if (teamsFails) throw new Error("teams down");
        sent.push({ channel: "teams", text: opts.text });
        return { ok: true };
      },
    });
    await pollGradeWatchesOnce(shared);
    assert.equal(sent.filter((row) => row.channel === "imessage").length, 1);
    assert.equal(sent.filter((row) => row.channel === "teams").length, 0);
    assert.equal((await listPublicGradeWatches({ root: dir })).length, 1);

    teamsFails = false;
    await pollGradeWatchesOnce(shared);
    assert.equal(sent.filter((row) => row.channel === "imessage").length, 1);
    assert.equal(sent.filter((row) => row.channel === "teams").length, 1);
    assert.equal(sent.find((row) => row.channel === "teams").text, "up 8/10");
    assert.deepEqual(await listPublicGradeWatches({ root: dir }), []);
  });

  it("returns the running watch instead of saving a second one", async () => {
    const dir = await tempRoot();
    const first = await createGradeWatch(
      {
        assignment: "Quiz 3",
        messages: [{ channel: "imessage", to: "Yan", text: "one" }],
      },
      deps(dir)
    );
    const second = await createGradeWatch(
      {
        assignment: "Quiz 3",
        messages: [{ channel: "imessage", to: "Yan", text: "two" }],
      },
      deps(dir)
    );
    assert.equal(second.existing, true);
    assert.equal(second.id, first.id);
    assert.equal((await listPublicGradeWatches({ root: dir })).length, 1);
  });
});
