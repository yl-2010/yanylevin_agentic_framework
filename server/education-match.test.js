import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findMatchingDate,
  findMatchingTodo,
  formatEducationActionIndex,
  isSameEducationDate,
  isSameEducationTodo,
  loadEducationActionIndex,
  namesAreSimilar,
  normalizeEducationName,
  sharesSignificantToken,
} from "./education-match.js";

describe("normalizeEducationName", () => {
  it("treats advisor/advisory and year suffixes as the same event name", () => {
    assert.equal(normalizeEducationName("Advisory conference"), "advisor conference");
    assert.equal(
      normalizeEducationName("Advisor conferences 2026–27"),
      "advisor conference"
    );
    assert.equal(
      normalizeEducationName("Advisor conferences 2026-27"),
      "advisor conference"
    );
  });
});

describe("namesAreSimilar", () => {
  it("matches the nightly duplicate pair", () => {
    assert.equal(
      namesAreSimilar("Advisory conference", "Advisor conferences 2026–27"),
      true
    );
  });

  it("matches a longer first-day title against the short one", () => {
    assert.equal(
      namesAreSimilar("First day of school (11th grade)", "First day of school"),
      true
    );
  });

  it("does not match orientation day 1 vs day 2", () => {
    assert.equal(
      namesAreSimilar("Fall Orientation Day 1", "Fall Orientation Day 2"),
      false
    );
  });

  it("does not match unrelated same-day events", () => {
    assert.equal(namesAreSimilar("Homecoming", "Fall colors hike"), false);
  });
});

describe("isSameEducationDate", () => {
  const orig = {
    parent: "user-level",
    name: "Advisory conference",
    date: "2026-08-27",
    time: "14:00",
  };

  it("matches the duplicate on the same parent and day", () => {
    assert.equal(
      isSameEducationDate(orig, {
        parent: "user-level",
        name: "Advisor conferences 2026–27",
        date: "2026-08-27",
        time: "14:00",
      }),
      true
    );
  });

  it("does not match last year's first day", () => {
    assert.equal(
      isSameEducationDate(
        {
          parent: "user-level",
          name: "First day of school (11th grade)",
          date: "2026-09-02",
        },
        {
          parent: "user-level",
          name: "First day of school",
          date: "2025-09-03",
        }
      ),
      false
    );
  });

  it("does not match a different parent", () => {
    assert.equal(
      isSameEducationDate(orig, {
        parent: "class:advisory",
        name: "Advisor conferences 2026–27",
        date: "2026-08-27",
      }),
      false
    );
  });

  it("matches same slot when names share a significant token", () => {
    assert.equal(
      sharesSignificantToken("Yan advisor slot", "Advisory conference"),
      true
    );
    assert.equal(
      isSameEducationDate(orig, {
        parent: "user-level",
        name: "Yan advisor slot",
        date: "2026-08-27",
        time: "14:00",
      }),
      true
    );
  });

  it("does not match the same clock time for unrelated names", () => {
    assert.equal(
      isSameEducationDate(orig, {
        parent: "user-level",
        name: "Dentist",
        date: "2026-08-27",
        time: "14:00",
      }),
      false
    );
  });

  it("findMatchingDate returns the original row", () => {
    const hit = findMatchingDate(
      {
        parent: "user-level",
        name: "Advisor conferences 2026–27",
        date: "2026-08-27",
      },
      [orig]
    );
    assert.equal(hit, orig);
  });
});

describe("isSameEducationTodo", () => {
  const essay = {
    parent: "class:lit",
    name: "Essay",
    dueDate: "2026-09-12",
    dueTime: "23:59",
  };

  it("matches a similar title on the same due date", () => {
    assert.equal(
      isSameEducationTodo(essay, {
        parent: "class:lit",
        name: "Essay (draft)",
        dueDate: "2026-09-12",
      }),
      false
    );
    assert.equal(
      isSameEducationTodo(essay, {
        parent: "class:lit",
        name: "Lit essay",
        dueDate: "2026-09-12",
      }),
      false
    );
    assert.equal(
      isSameEducationTodo(essay, {
        parent: "class:lit",
        name: "Essay",
        dueDate: "2026-09-12",
      }),
      true
    );
  });

  it("treats missing dueDate as the same undated todo", () => {
    assert.equal(
      isSameEducationTodo(
        { parent: "user-level", name: "Call PathIvy", dueDate: "" },
        { parent: "user-level", name: "Call PathIvy" }
      ),
      true
    );
  });

  it("findMatchingTodo returns the row", () => {
    assert.equal(
      findMatchingTodo({ parent: "class:lit", name: "Essay", dueDate: "2026-09-12" }, [
        essay,
      ]),
      essay
    );
  });
});

describe("loadEducationActionIndex", () => {
  it("lists dates and open todos, skipping fixtures and done todos", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-match-"));
    try {
      await mkdir(join(root, "dates", "advisory-conference"), { recursive: true });
      await writeFile(
        join(root, "dates", "advisory-conference", "date.json"),
        JSON.stringify({
          name: "Advisory conference",
          date: "2026-08-27",
          time: "14:00",
        })
      );
      await mkdir(join(root, "dates", "_example-college-night"), { recursive: true });
      await writeFile(
        join(root, "dates", "_example-college-night", "date.json"),
        JSON.stringify({
          name: "College night",
          date: "2026-10-01",
          fixture: true,
        })
      );
      await mkdir(join(root, "todos", "open-call"), { recursive: true });
      await writeFile(
        join(root, "todos", "open-call", "todo.json"),
        JSON.stringify({ name: "Call PathIvy", dueDate: "2026-08-28", done: false })
      );
      await mkdir(join(root, "todos", "done-one"), { recursive: true });
      await writeFile(
        join(root, "todos", "done-one", "todo.json"),
        JSON.stringify({ name: "Done already", dueDate: "2026-08-01", done: true })
      );
      await mkdir(join(root, "classes", "lit", "dates", "quiz"), { recursive: true });
      await writeFile(
        join(root, "classes", "lit", "class.json"),
        JSON.stringify({ name: "Lit", period: "F", trimester: "year" })
      );
      await writeFile(
        join(root, "classes", "lit", "dates", "quiz", "date.json"),
        JSON.stringify({ name: "Quiz", date: "2026-09-10" })
      );
      await mkdir(join(root, "projects", "pathivy", "dates", "webinar"), {
        recursive: true,
      });
      await writeFile(
        join(root, "projects", "pathivy", "project.json"),
        JSON.stringify({ name: "PathIvy" })
      );
      await writeFile(
        join(root, "projects", "pathivy", "dates", "webinar", "date.json"),
        JSON.stringify({
          name: "PathIvy webinar",
          date: "2026-08-23",
          time: "16:00",
        })
      );

      const index = await loadEducationActionIndex(root);
      assert.equal(index.dates.length, 3);
      assert.equal(index.todos.length, 1);
      assert.match(index.text, /Advisory conference/);
      assert.match(index.text, /user-level dates\/advisory-conference/);
      assert.match(index.text, /class:lit classes\/lit\/dates\/quiz/);
      assert.match(index.text, /project:pathivy/);
      assert.match(index.text, /Call PathIvy/);
      assert.doesNotMatch(index.text, /College night/);
      assert.doesNotMatch(index.text, /Done already/);
      assert.equal(
        findMatchingDate(
          {
            parent: "user-level",
            name: "Advisor conferences 2026–27",
            date: "2026-08-27",
          },
          index.dates
        )?.path,
        "dates/advisory-conference"
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("formatEducationActionIndex says None when empty", () => {
    const text = formatEducationActionIndex([], []);
    assert.match(text, /never a new slug/);
    assert.match(text, /None/);
  });
});
