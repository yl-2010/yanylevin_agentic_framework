import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  chatHistoryDirRel,
  chatHistoryFileRel,
  chatHistoryGroup,
  chatHistoryIsUnread,
  fallbackChatTitle,
  formatChatHistoryHint,
  formatChatHistoryMarkdown,
  groupChatHistory,
  listChatHistory,
  listRecentChatHistory,
  loadChatHistory,
  loadChatHistoryHint,
  loadChatLastReadMap,
  markChatHistoryRead,
  parseChatHistoryMessages,
  parseChatHistoryMeta,
  patchChatHistoryTitle,
  patchChatHistoryVisibility,
  persistChatHistory,
  applyChatTitleStarter,
  applyChatWorkingStatus,
  resolveChatStarter,
  reapplyChatTitleStarters,
  relativeChatAge,
  sanitizeChatTitle,
  sanitizeChatVisibility,
  sanitizeChatEphemeral,
  chatHistoryIsEphemeralHidden,
  EPHEMERAL_HIDE_MS,
  sanitizeSessionId,
} from "./education-chat-history.js";

const SID = "7f3a91c2-abcd-4ef0-8123-456789abcdef";
const EMAIL = "you@example.com";

describe("chat title starter", () => {
  it("skips Yan: on personal chats and keeps guest names", () => {
    assert.equal(resolveChatStarter({ email: EMAIL, starter: "Yan" }), "");
    assert.equal(
      resolveChatStarter({ email: EMAIL, starter: "Alex" }),
      "Alex"
    );
    assert.equal(
      resolveChatStarter({
        email: EMAIL,
        firstUserMessage: "From Example Friend on Teams:\n\n@agent hi",
      }),
      "Example Friend"
    );
    assert.equal(
      applyChatTitleStarter("API cost vs plan", { email: EMAIL, starter: "Yan" }),
      "API cost vs plan"
    );
    assert.equal(
      applyChatTitleStarter("Yan: API cost vs plan", { email: EMAIL }),
      "API cost vs plan"
    );
    assert.equal(
      applyChatTitleStarter("High school video grade F", {
        email: EMAIL,
        firstUserMessage: "From Example Friend on Teams:\n\n@agent the assignment",
      }),
      "Example Friend: High school video grade F"
    );
  });

  it("always prefixes JYPE with who started", () => {
    assert.equal(
      resolveChatStarter({
        workspace: "jype",
        email: EMAIL,
        starter: "Yan",
      }),
      "Yan"
    );
    assert.equal(
      applyChatTitleStarter("eBay SEO title", {
        workspace: "jype",
        email: EMAIL,
        starter: "Yan",
      }),
      "Yan: eBay SEO title"
    );
    assert.equal(
      applyChatTitleStarter("Alex: Alex English homework BS", {
        workspace: "jype",
        email: "you@example.com",
        starter: "Alex",
      }),
      "Alex: English homework BS"
    );
    assert.equal(
      applyChatTitleStarter("caber hard verb", {
        workspace: "jype",
        email: "neighbor@example.com",
      }),
      "Example Neighbor: caber hard verb"
    );
  });
});

describe("sanitizeSessionId", () => {
  it("keeps UUIDs and edu ids", () => {
    assert.equal(sanitizeSessionId(SID), SID);
    assert.equal(sanitizeSessionId("edu-m5k2abc"), "edu-m5k2abc");
  });

  it("rejects path junk", () => {
    assert.equal(sanitizeSessionId("../secret"), "");
    assert.equal(sanitizeSessionId("a/b"), "");
    assert.equal(sanitizeSessionId("short"), "");
  });
});

describe("paths", () => {
  it("aliases iCloud onto the Gmail folder", () => {
    assert.equal(
      chatHistoryDirRel("you@icloud.com"),
      `education/${EMAIL}/.chat-history`
    );
    assert.equal(
      chatHistoryFileRel("you@icloud.com", SID),
      `education/${EMAIL}/.chat-history/${SID}.md`
    );
  });
});

describe("format/parse markdown", () => {
  it("round-trips transcript text", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      startedAt: "2026-08-15T18:00:00.000Z",
      updatedAt: "2026-08-15T18:05:00.000Z",
      messages: [
        { role: "user", content: "add the calc HW", at: "2026-08-15T18:00:00.000Z" },
        { role: "assistant", content: "Added HW due Fri.", at: "2026-08-15T18:00:12.000Z" },
      ],
    });
    const meta = parseChatHistoryMeta(md);
    assert.equal(meta.session, SID);
    assert.equal(meta.email, EMAIL);
    assert.equal(meta.started, "2026-08-15T18:00:00.000Z");
    assert.equal(meta.preview, "add the calc HW");
    assert.equal(meta.visibility, "showing");
    assert.equal(meta.ephemeral, false);
    assert.match(md, /^visibility: showing$/m);
    assert.doesNotMatch(md, /^ephemeral:/m);
    assert.match(md, /## User — 2026-08-15T18:00:00.000Z/);
    assert.match(md, /Added HW due Fri\./);
  });

  it("treats a missing visibility line as showing", () => {
    const meta = parseChatHistoryMeta(
      [
        "# Personal Agent chat",
        `session: ${SID}`,
        `email: ${EMAIL}`,
        "started: 2026-08-15T18:00:00.000Z",
        "updated: 2026-08-15T18:05:00.000Z",
        "title: Old thread",
        "",
        "## User — 2026-08-15T18:00:00.000Z",
        "hello",
        "",
      ].join("\n")
    );
    assert.equal(meta.visibility, "showing");
    assert.equal(meta.title, "Old thread");
  });

  it("round-trips hidden visibility", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      visibility: "hidden",
      messages: [{ role: "user", content: "secret" }],
    });
    assert.match(md, /^visibility: hidden$/m);
    assert.equal(parseChatHistoryMeta(md).visibility, "hidden");
  });

  it("round-trips ephemeral @agent threads", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      ephemeral: true,
      messages: [{ role: "user", content: "@agent ping" }],
    });
    assert.match(md, /^ephemeral: true$/m);
    assert.equal(parseChatHistoryMeta(md).ephemeral, true);
  });

  it("treats a missing ephemeral line as permanent", () => {
    const meta = parseChatHistoryMeta(
      [
        "# Personal Agent chat",
        `session: ${SID}`,
        `email: ${EMAIL}`,
        "started: 2026-08-15T18:00:00.000Z",
        "updated: 2026-08-15T18:05:00.000Z",
        "visibility: showing",
        "",
        "## User — 2026-08-15T18:00:00.000Z",
        "@agent ping",
        "",
      ].join("\n")
    );
    assert.equal(meta.ephemeral, false);
  });

  it("round-trips a title with spaces", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      title: "Calc homework due Friday",
      messages: [{ role: "user", content: "add the calc HW" }],
    });
    const meta = parseChatHistoryMeta(md);
    assert.equal(meta.title, "Calc homework due Friday");
    assert.match(md, /^title: Calc homework due Friday$/m);
  });

  it("round-trips starter and workspace", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      title: "Yan: eBay SEO title",
      workspace: "jype",
      starter: "Yan",
      messages: [{ role: "user", content: "@agent ebay" }],
    });
    const meta = parseChatHistoryMeta(md);
    assert.equal(meta.workspace, "jype");
    assert.equal(meta.starter, "Yan");
    assert.match(md, /^workspace: jype$/m);
    assert.match(md, /^starter: Yan$/m);
  });

  it("parses messages and widget fences", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      messages: [
        { role: "user", content: "cafes nearby", at: "2026-08-15T18:00:00.000Z" },
        {
          role: "assistant",
          content: "Cafes nearby.",
          at: "2026-08-15T18:00:12.000Z",
          widgets: [
            {
              type: "map",
              pins: [{ id: "a", lat: 47.6, lng: -122.3, title: "A" }],
            },
          ],
        },
      ],
    });
    const messages = parseChatHistoryMessages(md);
    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "user");
    assert.equal(messages[0].content, "cafes nearby");
    assert.equal(messages[1].role, "assistant");
    assert.equal(messages[1].content, "Cafes nearby.");
    assert.equal(messages[1].widgets?.[0]?.type, "map");
    assert.equal(messages[1].widgets?.[0]?.pins?.[0]?.id, "a");
  });

  it("keeps consecutive assistant bubbles as separate messages", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      messages: [
        { role: "user", content: "add essay to English", at: "2026-08-16T01:00:00.000Z" },
        { role: "assistant", content: "Adding essay to English, due Fri", at: "2026-08-16T01:00:01.000Z" },
        { role: "assistant", content: "Done", at: "2026-08-16T01:00:08.000Z", endOfTurn: true },
      ],
    });
    assert.doesNotMatch(md, /end of turn/i);
    assert.doesNotMatch(md, /endOfTurn/);
    const messages = parseChatHistoryMessages(md);
    assert.equal(messages.length, 3);
    assert.equal(messages[1].content, "Adding essay to English, due Fri");
    assert.equal(messages[2].content, "Done");
    assert.equal(messages[2].role, "assistant");
  });

  it("strips a trailing agent footer from stored assistant bubbles", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      messages: [
        { role: "user", content: "@agent answer this", at: "2026-09-08T17:53:00.000Z" },
        {
          role: "assistant",
          content: "Nothing after Spanish.\n\nSent by Yan's Personal Agent",
          at: "2026-09-08T17:53:59.000Z",
        },
      ],
    });
    const messages = parseChatHistoryMessages(md);
    assert.equal(messages[1].content, "Nothing after Spanish.");
    assert.doesNotMatch(messages[1].content, /Sent by Yan's Personal Agent/);
  });

  it("appends widget fences on assistant turns", () => {
    const md = formatChatHistoryMarkdown({
      email: EMAIL,
      sessionId: SID,
      messages: [
        {
          role: "assistant",
          content: "Cafes nearby.",
          widgets: [
            {
              type: "map",
              pins: [{ id: "a", lat: 47.6, lng: -122.3, title: "A" }],
            },
          ],
        },
      ],
    });
    assert.match(md, /```widget map/);
    assert.match(md, /Cafes nearby\./);
  });
});

describe("formatChatHistoryHint", () => {
  it("always names the folder and current thread", () => {
    const hint = formatChatHistoryHint({
      email: EMAIL,
      currentSessionId: SID,
      recent: [],
    });
    assert.match(hint, /education\/you@example.com\/\.chat-history\//);
    assert.match(hint, new RegExp(`${SID}\\.md`));
    assert.match(hint, /Older threads: none yet/);
    assert.match(hint, /Grep\/Read/);
    assert.match(hint, /visibility: hidden/);
  });

  it("marks hidden older threads in the hint", () => {
    const hint = formatChatHistoryHint({
      email: EMAIL,
      currentSessionId: SID,
      recent: [
        {
          sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          updated: "2026-08-14T09:00:00.000Z",
          preview: "where is my phone",
          visibility: "hidden",
        },
      ],
    });
    assert.match(hint, /where is my phone  \(hidden\)/);
  });

  it("lists other threads and skips the current one", () => {
    const hint = formatChatHistoryHint({
      email: EMAIL,
      currentSessionId: SID,
      recent: [
        { sessionId: SID, updated: "2026-08-15T18:00:00.000Z", preview: "current" },
        {
          sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          updated: "2026-08-14T09:00:00.000Z",
          preview: "where is my phone",
        },
      ],
    });
    assert.match(hint, /where is my phone/);
    assert.doesNotMatch(hint, /  current$/m);
  });
});

describe("persist/list", () => {
  it("writes indefinitely and lists older sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      const older = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: older,
        messages: [{ role: "user", content: "old thread about calc" }],
      });
      const rel = await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [
          { role: "user", content: "new chat" },
          { role: "assistant", content: "Hi." },
        ],
      });
      assert.equal(rel, `education/${EMAIL}/.chat-history/${SID}.md`);
      const text = await readFile(join(root, rel), "utf8");
      assert.match(text, /new chat/);

      const recent = await listRecentChatHistory({
        root,
        email: EMAIL,
        excludeSessionId: SID,
      });
      assert.equal(recent.length, 1);
      assert.equal(recent[0].sessionId, older);
      assert.match(recent[0].preview, /old thread about calc/);

      const hint = await loadChatHistoryHint({
        root,
        email: EMAIL,
        currentSessionId: SID,
      });
      assert.match(hint, /old thread about calc/);
      assert.match(hint, new RegExp(`${SID}\\.md`));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps original started timestamp on rewrite", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [{ role: "user", content: "first", at: "2026-08-01T00:00:00.000Z" }],
      });
      const first = await readFile(
        join(root, chatHistoryFileRel(EMAIL, SID)),
        "utf8"
      );
      const started = parseChatHistoryMeta(first).started;
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [
          { role: "user", content: "first" },
          { role: "assistant", content: "ok" },
        ],
      });
      const second = await readFile(
        join(root, chatHistoryFileRel(EMAIL, SID)),
        "utf8"
      );
      assert.equal(parseChatHistoryMeta(second).started, started);
      assert.match(second, /## Assistant/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps title across rewrites and hydrates messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        title: "Calc homework",
        messages: [
          { role: "user", content: "add the calc HW" },
          {
            role: "assistant",
            content: "Added.",
            widgets: [
              {
                type: "map",
                pins: [{ id: "a", lat: 47.6, lng: -122.3, title: "A" }],
              },
            ],
          },
        ],
      });
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [
          { role: "user", content: "add the calc HW" },
          { role: "assistant", content: "Added, due Friday." },
        ],
      });
      const loaded = await loadChatHistory({ root, email: EMAIL, sessionId: SID });
      assert.equal(loaded?.title, "Calc homework");
      assert.equal(loaded?.messages.length, 2);
      assert.equal(loaded?.messages[1].content, "Added, due Friday.");

      const patched = await patchChatHistoryTitle({
        root,
        email: EMAIL,
        sessionId: SID,
        title: "Friday calc HW",
      });
      assert.equal(patched, "Friday calc HW");
      const again = await loadChatHistory({ root, email: EMAIL, sessionId: SID });
      assert.equal(again?.title, "Friday calc HW");

      const all = await listChatHistory({ root, email: EMAIL });
      assert.equal(all.length, 1);
      assert.equal(all[0].title, "Friday calc HW");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("strips Yan: on personal persist and prefixes guest @agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-starter-"));
    const guestSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        title: "Yan: API cost vs plan",
        starter: "Yan",
        messages: [{ role: "user", content: "what does the API cost" }],
      });
      const yan = await loadChatHistory({ root, email: EMAIL, sessionId: SID });
      assert.equal(yan?.title, "API cost vs plan");
      assert.equal(yan?.starter, "");

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: guestSid,
        title: "High school video grade F",
        starter: "Yan",
        messages: [
          {
            role: "user",
            content: "From Example Friend on Teams:\n\n@agent high school",
          },
        ],
      });
      const guest = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: guestSid,
      });
      assert.equal(guest?.title, "Example Friend: High school video grade F");
      assert.equal(guest?.starter, "Example Friend");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps Name: on JYPE persist and nightly reapply", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-jype-starter-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        workspace: "jype",
        starter: "Yan",
        title: "eBay SEO title",
        messages: [{ role: "user", content: "@agent ebay title" }],
      });
      const loaded = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        workspace: "jype",
      });
      assert.equal(loaded?.title, "Yan: eBay SEO title");
      assert.equal(loaded?.starter, "Yan");

      await patchChatHistoryTitle({
        root,
        email: EMAIL,
        sessionId: SID,
        workspace: "jype",
        title: "battery steps redo",
      });
      const wiped = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        workspace: "jype",
      });
      assert.equal(wiped?.title, "battery steps redo");

      const changed = await reapplyChatTitleStarters(
        [
          {
            email: EMAIL,
            sessionId: SID,
            workspace: "jype",
            starter: "Yan",
          },
        ],
        root
      );
      assert.equal(changed, 1);
      const restored = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        workspace: "jype",
      });
      assert.equal(restored?.title, "Yan: battery steps redo");
      assert.equal(restored?.starter, "Yan");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits hidden threads from the UI list but keeps the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    const hiddenSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [{ role: "user", content: "visible thread" }],
      });
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: hiddenSid,
        visibility: "hidden",
        messages: [{ role: "user", content: "hidden thread about calc" }],
      });
      const listed = await listChatHistory({ root, email: EMAIL });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].sessionId, SID);

      const recent = await listRecentChatHistory({ root, email: EMAIL });
      assert.equal(recent.length, 2);
      assert.ok(recent.some((row) => row.sessionId === hiddenSid && row.visibility === "hidden"));

      const loaded = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: hiddenSid,
      });
      assert.equal(loaded?.visibility, "hidden");
      assert.equal(loaded?.messages[0].content, "hidden thread about calc");

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: hiddenSid,
        messages: [
          { role: "user", content: "hidden thread about calc" },
          { role: "assistant", content: "still here" },
        ],
      });
      const again = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: hiddenSid,
      });
      assert.equal(again?.visibility, "hidden");
      assert.equal(again?.messages[1].content, "still here");
      assert.equal((await listChatHistory({ root, email: EMAIL })).length, 1);

      const shown = await patchChatHistoryVisibility({
        root,
        email: EMAIL,
        sessionId: hiddenSid,
        visibility: "showing",
      });
      assert.equal(shown, "showing");
      const restored = await listChatHistory({ root, email: EMAIL });
      assert.equal(restored.length, 2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("omits idle ephemeral @agent threads after 10 minutes", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    const keepSid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const finished = "2026-08-15T18:00:00.000Z";
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        ephemeral: true,
        messages: [
          { role: "user", content: "@agent ping", at: finished },
          { role: "assistant", content: "pong", at: finished },
        ],
      });
      const rel = chatHistoryFileRel(EMAIL, SID);
      const abs = join(root, rel);
      const text = await readFile(abs, "utf8");
      await writeFile(
        abs,
        text.replace(/^updated: .+$/m, `updated: ${finished}`),
        "utf8"
      );

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: keepSid,
        messages: [{ role: "user", content: "typed in the app" }],
      });

      const stillFresh = await listChatHistory({
        root,
        email: EMAIL,
        now: new Date("2026-08-15T18:09:00.000Z"),
      });
      assert.equal(stillFresh.length, 2);
      assert.ok(stillFresh.some((row) => row.sessionId === SID));

      const expired = await listChatHistory({
        root,
        email: EMAIL,
        now: new Date("2026-08-15T18:10:00.000Z"),
      });
      assert.equal(expired.length, 1);
      assert.equal(expired[0].sessionId, keepSid);

      const working = await listChatHistory({
        root,
        email: EMAIL,
        now: new Date("2026-08-15T18:30:00.000Z"),
        workingIds: new Set([SID]),
      });
      assert.equal(working.length, 2);

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        ephemeral: false,
        messages: [
          { role: "user", content: "@agent ping" },
          { role: "assistant", content: "pong" },
          { role: "user", content: "keep this" },
        ],
      });
      const pinned = await listChatHistory({
        root,
        email: EMAIL,
        now: new Date("2026-08-15T19:00:00.000Z"),
      });
      assert.equal(pinned.length, 2);
      assert.ok(pinned.some((row) => row.sessionId === SID));
      const loaded = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
      });
      assert.equal(loaded?.ephemeral, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ephemeral on later persists unless cleared", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        ephemeral: true,
        messages: [{ role: "user", content: "@agent ping" }],
      });
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [
          { role: "user", content: "@agent ping" },
          { role: "assistant", content: "pong" },
        ],
      });
      const loaded = await loadChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
      });
      assert.equal(loaded?.ephemeral, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("treats missing lastRead as read until a later persist snapshots it", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    const older = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    try {
      const rel = chatHistoryFileRel(EMAIL, older);
      const abs = join(root, rel);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(
        abs,
        formatChatHistoryMarkdown({
          email: EMAIL,
          sessionId: older,
          startedAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
          messages: [{ role: "user", content: "legacy thread" }],
        }),
        "utf8"
      );
      const listed = await listChatHistory({ root, email: EMAIL });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].unread, false);
      assert.equal((await loadChatLastReadMap({ root, email: EMAIL }))[older], undefined);

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: older,
        messages: [
          { role: "user", content: "legacy thread" },
          { role: "assistant", content: "done in background" },
        ],
      });
      const after = await listChatHistory({ root, email: EMAIL });
      assert.equal(after[0].unread, true);

      const at = await markChatHistoryRead({
        root,
        email: EMAIL,
        sessionId: older,
      });
      assert.ok(at);
      const read = await listChatHistory({ root, email: EMAIL });
      assert.equal(read[0].unread, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a brand-new thread read until later bubbles land", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [{ role: "user", content: "just started" }],
      });
      const first = await listChatHistory({ root, email: EMAIL });
      assert.equal(first[0].unread, false);
      const map = await loadChatLastReadMap({ root, email: EMAIL });
      assert.ok(map[SID]);

      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [
          { role: "user", content: "just started" },
          { role: "assistant", content: "working on it" },
        ],
      });
      const second = await listChatHistory({ root, email: EMAIL });
      assert.equal(second[0].unread, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not rewind lastRead to an older timestamp", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      const newer = await markChatHistoryRead({
        root,
        email: EMAIL,
        sessionId: SID,
        at: "2026-09-13T20:00:00.000Z",
      });
      const older = await markChatHistoryRead({
        root,
        email: EMAIL,
        sessionId: SID,
        at: "2026-09-13T19:00:00.000Z",
      });
      assert.equal(newer, "2026-09-13T20:00:00.000Z");
      assert.equal(older, "2026-09-13T20:00:00.000Z");
      const map = await loadChatLastReadMap({ root, email: EMAIL });
      assert.equal(map[SID], "2026-09-13T20:00:00.000Z");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("stays read when persist asks to markRead", async () => {
    const root = await mkdtemp(join(tmpdir(), "edu-chat-hist-"));
    try {
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        messages: [{ role: "user", content: "@agent ping" }],
      });
      await persistChatHistory({
        root,
        email: EMAIL,
        sessionId: SID,
        markRead: true,
        messages: [
          { role: "user", content: "@agent ping" },
          { role: "assistant", content: "done" },
        ],
      });
      const listed = await listChatHistory({ root, email: EMAIL });
      assert.equal(listed[0].unread, false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("clears unread when working", () => {
    const rows = applyChatWorkingStatus(
      [
        { sessionId: SID, unread: true },
        { sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", unread: true },
      ],
      new Set([SID])
    );
    assert.equal(rows[0].working, true);
    assert.equal(rows[0].unread, false);
    assert.equal(rows[1].working, false);
    assert.equal(rows[1].unread, true);
    assert.equal(chatHistoryIsUnread("2026-08-24T20:00:00.000Z", "2026-08-24T19:00:00.000Z"), true);
    assert.equal(chatHistoryIsUnread("2026-08-24T19:00:00.000Z", "2026-08-24T19:00:00.000Z"), false);
    assert.equal(chatHistoryIsUnread("2026-08-24T20:00:00.000Z", ""), false);
  });
});

describe("titles", () => {
  it("sanitizes agent replies", () => {
    assert.equal(sanitizeChatTitle('"Cafe hunt near Juanita"'), "Cafe hunt near Juanita");
    assert.equal(sanitizeChatTitle("Calc homework."), "Calc homework");
    assert.equal(sanitizeChatTitle("Hello — world"), "Hello - world");
    assert.equal(
      sanitizeChatTitle(
        "assuming prasham's gone until saturday, is there a day before school starts"
      ),
      "assuming prasham's gone until saturday,"
    );
  });

  it("falls back to the first prompt", () => {
    assert.equal(fallbackChatTitle("add the calc HW"), "add the calc HW");
  });

  it("defaults visibility to showing", () => {
    assert.equal(sanitizeChatVisibility(""), "showing");
    assert.equal(sanitizeChatVisibility("SHOWING"), "showing");
    assert.equal(sanitizeChatVisibility("hidden"), "hidden");
    assert.equal(sanitizeChatVisibility("nope"), "showing");
  });

  it("keeps Scheduled: outside the 40 character cap and skips the name prefix", () => {
    const long = "spanish mastery assessment link for the group chat";
    const titled = sanitizeChatTitle(`Scheduled: ${long} extra words that should fall off the end`);
    assert.ok(titled.startsWith("Scheduled: "));
    assert.ok(titled.length > 40);
    assert.ok(titled.slice("Scheduled: ".length).length <= 40);
    assert.equal(
      applyChatTitleStarter(titled, {
        email: EMAIL,
        workspace: "jype",
        starter: "Alex",
      }),
      titled
    );
  });

  it("treats only explicit true as ephemeral", () => {
    assert.equal(sanitizeChatEphemeral(""), false);
    assert.equal(sanitizeChatEphemeral("true"), true);
    assert.equal(sanitizeChatEphemeral("TRUE"), true);
    assert.equal(sanitizeChatEphemeral("false"), false);
    assert.equal(EPHEMERAL_HIDE_MS, 10 * 60 * 1000);
    assert.equal(
      chatHistoryIsEphemeralHidden(
        { sessionId: SID, ephemeral: true, updated: "2026-08-15T18:00:00.000Z" },
        new Date("2026-08-15T18:09:59.000Z")
      ),
      false
    );
    assert.equal(
      chatHistoryIsEphemeralHidden(
        { sessionId: SID, ephemeral: true, updated: "2026-08-15T18:00:00.000Z" },
        new Date("2026-08-15T18:10:00.000Z")
      ),
      true
    );
  });
});

describe("grouping", () => {
  const tz = "America/Los_Angeles";
  const now = new Date("2026-08-15T20:00:00.000Z");

  it("uses compact relative time", () => {
    assert.equal(relativeChatAge("2026-08-15T19:59:30.000Z", now), "now");
    assert.equal(relativeChatAge("2026-08-15T19:44:00.000Z", now), "16m");
    assert.equal(relativeChatAge("2026-08-15T18:00:00.000Z", now), "2h");
  });

  it("groups today, weekdays, and older", () => {
    const chats = [
      { sessionId: "a", updated: "2026-08-15T19:00:00.000Z" },
      { sessionId: "b", updated: "2026-08-14T19:00:00.000Z" },
      { sessionId: "c", updated: "2026-08-12T19:00:00.000Z" },
      { sessionId: "d", updated: "2026-07-01T19:00:00.000Z" },
    ];
    const sections = groupChatHistory(chats, now, tz);
    assert.equal(sections[0].label, "Today");
    assert.equal(sections[0].showAge, true);
    assert.equal(sections[1].label, "Yesterday");
    assert.equal(chatHistoryGroup("2026-08-12T19:00:00.000Z", now, tz).label, "Wednesday");
    assert.equal(sections.at(-1)?.label, "Older");
    assert.equal(sections.at(-1)?.chats[0].sessionId, "d");
  });

  it("keeps a Seattle morning chat in Today after UTC midnight", () => {
    const evening = new Date("2026-09-16T04:01:00.000Z");
    assert.equal(
      chatHistoryGroup("2026-09-15T15:00:00.000Z", evening, tz).label,
      "Today"
    );
    assert.equal(
      chatHistoryGroup("2026-09-15T06:30:00.000Z", evening, tz).label,
      "Yesterday"
    );
  });
});
