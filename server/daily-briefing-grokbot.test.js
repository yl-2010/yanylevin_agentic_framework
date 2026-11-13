import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  agentRecapDraftPath,
  briefingRunner,
  briefingTodoPath,
  buildAgentRecapPrompt,
  buildNewsPrompt,
  buildUnslopPrompt,
  newsDraftPath,
} from "./daily-briefing-agent.js";
import {
  buildBundle,
  main,
  validateBriefingTodo,
  validateNewsDraft,
  validateRecapDraft,
} from "./daily-briefing-grokbot.js";

function newsCap(id, extra = {}) {
  return {
    id,
    category: "tech",
    title: "Headline",
    body: "Two short sentences.",
    vote: null,
    citations: [{ name: "The Verge", url: "https://www.theverge.com/x" }],
    ...extra,
  };
}

const RECAP = {
  id: "agent-recap",
  title: "Agent Recap",
  category: "other",
  noVote: true,
  vote: null,
  body: "URGENT:\n- canvas sync did not run\n\nQuiet night otherwise.",
};

function todo(extra = {}) {
  return {
    name: "November 13th Daily Briefing",
    kind: "dailyBriefing",
    dueDate: "2026-11-13",
    dueTime: "07:00",
    done: false,
    showInDates: false,
    createdAt: "2026-11-13T14:02:00.000Z",
    capsules: [RECAP, ...Array.from({ length: 10 }, (_, i) => newsCap(`story-${i}`))],
    citations: [
      { name: "AP", url: "https://apnews.com/a" },
      { name: "Reuters", url: "https://www.reuters.com/b" },
      { name: "the Verge", url: "https://www.theverge.com/c" },
    ],
    ...extra,
  };
}

describe("briefingRunner", () => {
  it("defaults to cursor", () => {
    assert.equal(briefingRunner({}), "cursor");
    assert.equal(briefingRunner({ DAILY_BRIEFING_RUNNER: "cursor" }), "cursor");
    assert.equal(briefingRunner({ DAILY_BRIEFING_RUNNER: "nonsense" }), "cursor");
  });

  it("accepts grokbot spellings", () => {
    for (const value of ["grokbot", "GrokBot", "grok-bot", " grok_bot ", "grok"]) {
      assert.equal(briefingRunner({ DAILY_BRIEFING_RUNNER: value }), "grokbot", value);
    }
  });
});

describe("grokbot bundles", () => {
  const ctx = {
    dateKey: "2026-11-13",
    timezone: "America/Los_Angeles",
    dueTime: "07:00",
    force: false,
    scriptCmd: "node server/daily-briefing-grokbot.js",
    nightlyStatusPath: "/nonexistent/nightly.json",
  };

  it("carries the exact Cursor prompt for each phase", async () => {
    const news = await buildBundle({ ...ctx, phase: "news" });
    assert.equal(news.prompt, buildNewsPrompt(ctx));
    assert.deepEqual(news.writes.map((w) => w.path), [newsDraftPath("2026-11-13")]);
    assert.match(news.doneCommand, /phase-done --phase news --date 2026-11-13/);

    const recap = await buildBundle({ ...ctx, phase: "agent-recap" });
    assert.equal(recap.prompt, buildAgentRecapPrompt(ctx));
    assert.deepEqual(recap.writes.map((w) => w.path), [agentRecapDraftPath("2026-11-13")]);

    const unslop = await buildBundle({ ...ctx, phase: "unslop", force: true });
    assert.equal(unslop.prompt, buildUnslopPrompt({ ...ctx, force: true }));
    assert.equal(unslop.writes[0].path, briefingTodoPath("2026-11-13"));
    assert.match(unslop.writes[1].path, /daily-briefing\/taste\.md$/);
    assert.match(unslop.doneCommand, /finalize --date 2026-11-13/);
    assert.match(unslop.replaces, /composer/);
  });
});

describe("grokbot validation", () => {
  it("accepts a good news draft and warns on count", () => {
    const ok = validateNewsDraft({ capsules: [newsCap("a"), newsCap("b")], citations: [{ name: "AP", url: "https://apnews.com" }] });
    assert.equal(ok.ok, true);
    assert.equal(ok.warnings.length, 1);
  });

  it("rejects missing citations, bad ids, votes, and categories", () => {
    const bad = validateNewsDraft({
      capsules: [newsCap("Bad Id"), newsCap("x", { citations: [] }), newsCap("y", { vote: "up" }), newsCap("z", { category: "sports" })],
      citations: [],
    });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /kebab/.test(e)));
    assert.ok(bad.errors.some((e) => /capsules\[1\]: citations/.test(e)));
    assert.ok(bad.errors.some((e) => /vote must be null/.test(e)));
    assert.ok(bad.errors.some((e) => /category/.test(e)));
    assert.equal(validateNewsDraft([]).ok, false);
  });

  it("checks the agent recap card", () => {
    assert.equal(validateRecapDraft(RECAP).ok, true);
    const bad = validateRecapDraft({ ...RECAP, noVote: false, citations: [{ name: "x", url: "https://x" }] });
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length, 2);
  });

  it("accepts the final todo schema", () => {
    const result = validateBriefingTodo(todo(), { dateKey: "2026-11-13", dueTime: "07:00" });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
  });

  it("rejects a todo that drifts from the schema", () => {
    const capsules = [newsCap("first"), RECAP];
    const result = validateBriefingTodo(
      todo({ dueDate: "2026-11-12", tag: "HW", showInDates: true, capsules, citations: [{ name: "Reuters", url: "https://r.com" }, { name: "AP", url: "https://a.com" }] }),
      { dateKey: "2026-11-13", dueTime: "07:00" }
    );
    assert.equal(result.ok, false);
    for (const re of [/dueDate/, /tag/, /showInDates/, /capsules\[0\]: id must be "agent-recap"/, /alphabetical/]) {
      assert.ok(result.errors.some((e) => re.test(e)), String(re));
    }
  });

  it("keeps thumbs on a forced rebuild", () => {
    const capsules = [RECAP, newsCap("a", { vote: "up" }), newsCap("b", { vote: "down" })];
    assert.equal(validateBriefingTodo(todo({ capsules }), { dateKey: "2026-11-13", dueTime: "07:00" }).ok, false);
    assert.equal(validateBriefingTodo(todo({ capsules, done: true }), { dateKey: "2026-11-13", dueTime: "07:00", force: true }).ok, true);
  });
});

describe("grokbot cli", () => {
  it("rejects unknown commands and bad phases", async () => {
    await assert.rejects(() => main(["explode"]), /unknown command/);
    await assert.rejects(() => main(["phase-done", "--phase", "unslop"]), /phase-done needs/);
  });
});
