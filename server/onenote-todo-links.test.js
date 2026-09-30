import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONTENT_LIBRARY_GROUP,
  PERSONAL_GROUP,
  mergeOneNoteSites,
  pickOneNoteLinks,
  scoreTodoPage,
} from "./onenote-todo-links.js";

describe("scoreTodoPage", () => {
  it("matches calc problem sets and skips solutions, notes, and other days", () => {
    assert.ok(scoreTodoPage("problem set one", "Day 1 problem set") >= 75);
    assert.equal(scoreTodoPage("problem set one", "Day 2 problem set"), 0);
    assert.equal(scoreTodoPage("problem set one", "Day 1 solns"), 0);
    assert.equal(scoreTodoPage("problem set one", "Day 1"), 0);
    assert.equal(scoreTodoPage("problem set one", "Day 1 - preliminary ideas"), 0);
    assert.ok(scoreTodoPage("problem set two", "Day 2 problem set") >
      scoreTodoPage("problem set two", "Practice Problem set 2"));
    assert.ok(
      scoreTodoPage(
        "Day 5 work - intro to integration by parts",
        "Day 5 problem set - integration by parts"
      ) >= 75
    );
    assert.ok(
      scoreTodoPage(
        "Day 5 work - intro to integration by parts",
        "Day 5 - integration by parts"
      ) >= 75
    );
    assert.equal(
      scoreTodoPage("Day 5 work - intro to integration by parts", "Day 5"),
      0
    );
    assert.equal(
      scoreTodoPage(
        "Day 5 work - intro to integration by parts",
        "Notes - Day 5 - review Keisler problems"
      ),
      0
    );
    assert.equal(scoreTodoPage("excel activity", "Day 0 - practical excel classwork"), 0);
    assert.equal(scoreTodoPage("45 minute in-class quiz", "review for quiz"), 0);
    assert.ok(scoreTodoPage("The Road to Revolution", "The Road to Revolution") >= 75);
    assert.equal(
      scoreTodoPage("Constitutional Convention (Participation)", "Constitutional Convention"),
      0
    );
  });
});

describe("pickOneNoteLinks", () => {
  const pages = [
    {
      id: "p1",
      title: "Day 1 problem set",
      webUrl: "https://example.com/p1",
      clientUrl: "onenote:https://example.com/p1",
      group: PERSONAL_GROUP,
    },
    {
      id: "c1",
      title: "Day 1 problem set",
      webUrl: "https://example.com/c1",
      clientUrl: "onenote:https://example.com/c1",
      group: CONTENT_LIBRARY_GROUP,
    },
    {
      id: "c1s",
      title: "Day 1 solns",
      webUrl: "https://example.com/c1s",
      clientUrl: "onenote:https://example.com/c1s",
      group: CONTENT_LIBRARY_GROUP,
    },
    {
      id: "p5",
      title: "Day 5 problem set - integration by parts",
      webUrl: "https://example.com/p5",
      clientUrl: "onenote:https://example.com/p5",
      group: PERSONAL_GROUP,
    },
    {
      id: "c5",
      title: "Day 5 - integration by parts",
      webUrl: "https://example.com/c5",
      clientUrl: "onenote:https://example.com/c5",
      group: CONTENT_LIBRARY_GROUP,
    },
    {
      id: "c5b",
      title: "Day 5 problem set - integration by parts",
      webUrl: "https://example.com/c5b",
      clientUrl: "onenote:https://example.com/c5b",
      group: CONTENT_LIBRARY_GROUP,
    },
    {
      id: "collab",
      title: "Day 1 problem set",
      webUrl: "https://example.com/collab",
      clientUrl: "onenote:https://example.com/collab",
      group: "_Collaboration Space",
    },
  ];

  it("names the personal tile after the assignment and the teacher tile Content Library", () => {
    const [one, day5, quiz] = pickOneNoteLinks(
      [
        { name: "problem set one" },
        { name: "Day 5 work - intro to integration by parts" },
        { name: "45 minute in-class quiz" },
      ],
      pages
    );
    assert.equal(one.personal.name, "problem set one");
    assert.equal(one.personal.oneNote, "personal");
    assert.equal(one.personal.clientUrl, "onenote:https://example.com/p1");
    assert.equal(one.content.name, "Content Library: Day 1 problem set");
    assert.equal(one.content.oneNote, "content-library");
    assert.equal(day5.personal.name, "Day 5 work - intro to integration by parts");
    assert.equal(day5.personal.pageTitle, "Day 5 problem set - integration by parts");
    assert.equal(day5.content.name, "Content Library: Day 5 - integration by parts");
    assert.equal(quiz.personal, null);
    assert.equal(quiz.content, null);
  });

  it("prefers the Homework section when the same title is also in Class Notes", () => {
    const [one] = pickOneNoteLinks([{ name: "problem set one" }], [
      {
        id: "notes",
        title: "Day 1 problem set",
        webUrl: "https://example.com/notes",
        clientUrl: "onenote:https://example.com/notes",
        group: PERSONAL_GROUP,
        sectionName: "Class Notes",
      },
      {
        id: "hw",
        title: "Day 1 problem set",
        webUrl: "https://example.com/hw",
        clientUrl: "onenote:https://example.com/hw",
        group: PERSONAL_GROUP,
        sectionName: "Homework",
      },
    ]);
    assert.equal(one.personal.pageId, "hw");
  });

  it("gives a study-guide page to the study-guide todo", () => {
    const [qa, guide] = pickOneNoteLinks(
      [
        { name: "#1 - ESCRITO - AUDITIVO - Otoño 2026" },
        { name: "STUDY GUIDE: QA #1 ESCRITO - AUDITIVO - GUÍA DE ESTUDIO Otoño 2026" },
      ],
      [
        {
          id: "g",
          title: "QA #1 ESCRITO - AUDITIVO - GUÍA DE ESTUDIO Otoño 2026",
          webUrl: "https://example.com/g",
          clientUrl: "onenote:https://example.com/g",
          group: CONTENT_LIBRARY_GROUP,
        },
      ]
    );
    assert.equal(qa.content, null);
    assert.equal(guide.content?.pageTitle, "QA #1 ESCRITO - AUDITIVO - GUÍA DE ESTUDIO Otoño 2026");
  });

  it("keeps a study-guide site and replaces an old OneNote site", () => {
    const sites = mergeOneNoteSites(
      [
        { name: "Study guide", url: "https://yanylevin.com/g/" },
        {
          name: "old",
          url: "https://example.com/old",
          oneNote: "personal",
          pageId: "old",
        },
      ],
      [
        {
          name: "problem set one",
          url: "https://example.com/p1",
          oneNote: "personal",
          pageId: "p1",
          clientUrl: "onenote:https://example.com/p1",
        },
      ]
    );
    assert.deepEqual(
      sites.map((s) => s.name),
      ["Study guide", "problem set one"]
    );
  });
});
