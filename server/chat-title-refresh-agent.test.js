import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHAT_TITLE_LOOKBACK_MS,
  CHAT_TITLE_REFRESH_BATCH_SIZE,
  CHAT_TITLE_REFRESH_EMAILS,
  CHAT_TITLE_REFRESH_MODEL_SPEC,
  buildChatTitleRefreshPrompt,
  chatTitleRefreshModelSpec,
  chunkArray,
  localStartOfTodayMs,
  nextChatTitleRefreshAt,
  selectChatTitleRefreshTargets,
  chatTitleRefreshGitPaths,
} from "./chat-title-refresh-agent.js";
import { TITLE_PROMPT } from "./chat-title.js";
import { formatChatHistoryMarkdown } from "./education-chat-history.js";

const META = {
  timezone: "America/Chicago",
  timezoneAfter: {
    on: "2026-08-27",
    timezone: "America/Los_Angeles",
  },
  nightlyAgentsLocalTime: "01:00",
  chatTitleRefreshLocalTime: "01:30",
  contextSynthesisLocalTime: "02:30",
};

describe("chat title refresh model", () => {
  it("uses composer-2.5 with Fast off", () => {
    assert.equal(CHAT_TITLE_REFRESH_MODEL_SPEC.id, "composer-2.5");
    const spec = chatTitleRefreshModelSpec();
    assert.equal(spec.id, "composer-2.5");
    assert.deepEqual(spec.params, [{ id: "fast", value: "false" }]);
    assert.doesNotMatch(spec.id, /fast/);
  });
});

describe("chat title refresh prompt", () => {
  it("points at the skill, keyword style, and listed paths", () => {
    const prompt = buildChatTitleRefreshPrompt({
      dateKey: "2026-08-18",
      timezone: "America/Chicago",
      chats: [
        {
          path: "education/you@example.com/.chat-history/aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001.md",
          email: "you@example.com",
          updated: "2026-08-17T20:00:00.000Z",
          title: "Nearby Places to Eat",
        },
      ],
    });
    assert.match(prompt, /chat-title-refresh skill/);
    assert.match(prompt, /Never spawn a Cursor cloud agent/);
    assert.match(prompt, /\.chat-history\/aaaa1111-bbbb-4ccc-8ddd-eeeeffff0001\.md/);
    assert.match(prompt, /Nearby Places to Eat/);
    assert.match(prompt, /Keyword-style/);
    assert.match(prompt, /Do not glob/);
    assert.doesNotMatch(prompt, /Backfill:/);
    assert.match(prompt, /Keyword-style/);
  });

  it("marks backfill vs nightly window", () => {
    const prompt = buildChatTitleRefreshPrompt({
      dateKey: "2026-08-18",
      timezone: "America/Chicago",
      backfill: true,
      chats: [],
    });
    assert.match(prompt, /Backfill:/);
    assert.doesNotMatch(prompt, /last 24 hours/);
  });
});

describe("chat title refresh schedule", () => {
  it("schedules 01:30 in the briefing timezone", () => {
    const now = new Date("2026-08-16T20:00:00-05:00");
    const when = nextChatTitleRefreshAt(META, now);
    assert.equal(when.toISOString(), "2026-08-17T06:30:00.000Z");
  });
});

describe("selectChatTitleRefreshTargets", () => {
  const now = new Date("2026-08-18T22:00:00.000Z");
  const sinceMs = now.getTime() - CHAT_TITLE_LOOKBACK_MS;
  const beforeMs = Date.parse("2026-08-18T05:00:00.000Z");
  const rows = [
    {
      sessionId: "today1111-bbbb-4ccc-8ddd-eeeeffff0001",
      updated: "2026-08-18T18:00:00.000Z",
      path: "today.md",
    },
    {
      sessionId: "yest2222-bbbb-4ccc-8ddd-eeeeffff0002",
      updated: "2026-08-17T23:00:00.000Z",
      path: "yesterday.md",
    },
    {
      sessionId: "old33333-bbbb-4ccc-8ddd-eeeeffff0003",
      updated: "2026-08-01T18:00:00.000Z",
      path: "old.md",
    },
  ];

  it("nightly keeps the last 24 hours", () => {
    const picked = selectChatTitleRefreshTargets(rows, { sinceMs });
    assert.deepEqual(
      picked.map((r) => r.path),
      ["today.md", "yesterday.md"]
    );
  });

  it("backfill keeps chats before local today", () => {
    const picked = selectChatTitleRefreshTargets(rows, {
      backfill: true,
      beforeMs,
    });
    assert.deepEqual(
      picked.map((r) => r.path),
      ["yesterday.md", "old.md"]
    );
  });
});

describe("localStartOfTodayMs", () => {
  it("uses briefing midnight", () => {
    const now = new Date("2026-08-18T22:00:00.000Z");
    const ms = localStartOfTodayMs(META, now);
    assert.equal(new Date(ms).toISOString(), "2026-08-18T05:00:00.000Z");
  });
});

describe("chunkArray", () => {
  it("splits at the batch size", () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    const batches = chunkArray(items, CHAT_TITLE_REFRESH_BATCH_SIZE);
    assert.equal(batches.length, 2);
    assert.equal(batches[0].length, CHAT_TITLE_REFRESH_BATCH_SIZE);
    assert.equal(batches[1].length, 4);
  });
});

describe("chat title refresh emails", () => {
  it("covers both education users", () => {
    assert.ok(CHAT_TITLE_REFRESH_EMAILS.includes("you@example.com"));
    assert.ok(CHAT_TITLE_REFRESH_EMAILS.includes("you@example.com"));
  });
});

describe("live title prompt style", () => {
  it("asks for keyword titles", () => {
    assert.match(TITLE_PROMPT, /Keyword-style/);
    assert.match(TITLE_PROMPT, /first user message/);
    assert.doesNotMatch(TITLE_PROMPT, /3 to 6 words/);
  });
});

describe("chatTitleRefreshGitPaths", () => {
  it("omits a user folder that does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-title-git-paths-"));
    try {
      await mkdir(
        join(dir, "education/you@example.com/.chat-history"),
        { recursive: true }
      );
      const paths = await chatTitleRefreshGitPaths(dir);
      assert.ok(paths.includes("education/you@example.com/.chat-history"));
      assert.ok(
        !paths.includes("education/you@example.com/.chat-history")
      );
      assert.ok(
        paths.includes(
          "education/you@example.com/daily-briefing/chat-title-refresh-state.json"
        )
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("formatChatHistoryMarkdown still stores titles", () => {
  it("keeps a short title line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chat-title-refresh-"));
    try {
      await mkdir(join(dir, "education/you@example.com/.chat-history"), {
        recursive: true,
      });
      const md = formatChatHistoryMarkdown({
        email: "you@example.com",
        sessionId: "7f3a91c2-abcd-4ef0-8123-456789abcdef",
        title: "Example Friend spelling",
        messages: [{ role: "user", content: "jeffery not jeffrey" }],
      });
      await writeFile(join(dir, "x.md"), md);
      assert.match(md, /title: Example Friend spelling/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
