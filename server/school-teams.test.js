import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBackwardLink,
  fetchRecentChatMessages,
  formatDumpMessage,
  groupMessagesByMonth,
  shouldSkipTeamsDumpMessage,
  TEAMS_CLOUD,
  buildChatMessagesUrl,
  buildChatsUrl,
  buildSendChatBody,
  buildSendChatUrl,
  chatDisplayName,
  ensureSelfChat,
  fromMeOf,
  isCsaToken,
  isTeamsSelfChat,
  isGraphAudience,
  isIc3Token,
  isTeamsAuthError,
  isTeamsToken,
  normalizeChat,
  messageText,
  normalizeMessage,
  parseArgs,
  includeCsaChat,
  pickByName,
  pickChat,
  runSchoolTeams,
  teamsScopes,
} from "./school-teams.js";
import { applyAgentSentFooter } from "./imessage-mention.js";
import { shouldTriggerTeamsAgent } from "./teams-mention.js";

function fakeJwt(payload) {
  const h = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.sig`;
}

describe("school-teams parseArgs", () => {
  it("parses chat send flags", () => {
    const a = parseArgs(["send", "--chat", "Alex", "Dhruva", "--text", "On", "it"]);
    assert.equal(a.cmd, "send");
    assert.equal(a.chat, "Alex Rivera");
    assert.equal(a.text, "On it");
  });

  it("parses team and channel", () => {
    const a = parseArgs([
      "thread",
      "--team",
      "Spanish",
      "4",
      "--channel",
      "General",
      "--limit",
      "8",
    ]);
    assert.equal(a.team, "Spanish 4");
    assert.equal(a.channel, "General");
    assert.equal(a.limit, 8);
  });

  it("joins search words until a flag", () => {
    const a = parseArgs(["search", "hw", "tonight", "--limit", "3"]);
    assert.equal(a.query, "hw tonight");
    assert.equal(a.limit, 3);
  });

  it("rejects unknown flags", () => {
    assert.throws(() => parseArgs(["chats", "--nope"]), /unknown arg/);
  });

  it("keeps --via off the message text", () => {
    const a = parseArgs([
      "send",
      "--chat",
      "Alex",
      "--text",
      "On it",
      "--via",
      "nightly-actions",
    ]);
    assert.equal(a.via, "nightly-actions");
    assert.equal(a.text, "On it");
  });

  it("parses dump --full", () => {
    const a = parseArgs(["dump", "--full", "--since", "2024-04-01", "--out", "/tmp/x"]);
    assert.equal(a.cmd, "dump");
    assert.equal(a.full, true);
    assert.equal(a.since, "2024-04-01");
    assert.equal(a.out, "/tmp/x");
  });
});

describe("school-teams tokens", () => {
  it("accepts a Graph token with Chat.Read", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "User.Read Chat.Read Chat.ReadWrite",
      preferred_username: "owner@school.example",
    });
    assert.equal(isGraphAudience(token), true);
    assert.equal(isTeamsToken(token), true);
    assert.ok(teamsScopes(token).includes("Chat.Read"));
  });

  it("rejects a Graph token that only has channel scopes", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "ChannelMessage.Read.All ChannelMessage.Send Team.ReadBasic.All ChatMessage.Send",
    });
    assert.equal(isTeamsToken(token), false);
  });

  it("rejects Graph mail tokens without Chat scopes", () => {
    const token = fakeJwt({
      aud: "https://graph.microsoft.com",
      scp: "Mail.Read User.Read",
    });
    assert.equal(isTeamsToken(token), false);
  });

  it("rejects Skype-audience tokens as the chat token", () => {
    const token = fakeJwt({
      aud: "https://api.spaces.skype.com",
      scp: "Chat.Read",
    });
    assert.equal(isGraphAudience(token), false);
    assert.equal(isTeamsToken(token), false);
  });

  it("accepts an IC3 Teams.AccessAsUser token", () => {
    const token = fakeJwt({
      aud: "https://ic3.teams.office.com",
      scp: "Teams.AccessAsUser.All",
      preferred_username: "owner@school.example",
    });
    assert.equal(isIc3Token(token), true);
    assert.equal(isTeamsToken(token), true);
  });

  it("accepts a CSA chatsvcagg token", () => {
    const token = fakeJwt({
      aud: "https://chatsvcagg.teams.microsoft.com",
      scp: "user_impersonation",
    });
    assert.equal(isCsaToken(token), true);
    assert.equal(isTeamsToken(token), false);
  });
});

describe("school-teams urls and shapes", () => {
  it("builds CSA/IC3 chat URLs", () => {
    assert.match(buildChatsUrl(), /\/api\/csa\/amer\/api\/v3\/teams\/users\/me\/updates/);
    assert.match(
      buildChatMessagesUrl("19:abc@thread.v2"),
      /\/api\/chatsvc\/amer\/v1\/users\/ME\/conversations\/19%3Aabc/
    );
    assert.equal(
      buildSendChatUrl("19:x"),
      `${TEAMS_CLOUD}/api/chatsvc/amer/v1/users/ME/conversations/19%3Ax/messages`
    );
  });

  it("names a 1:1 from the other member when topic is empty", () => {
    const name = chatDisplayName({
      topic: "",
      members: [
        { displayName: "Yan Levin", email: "owner@school.example" },
        { displayName: "Alex Rivera", email: "friend@school.example" },
      ],
    });
    assert.equal(name, "Alex Rivera");
  });

  it("replaces the (chat) placeholder once members are named", () => {
    const name = chatDisplayName({
      name: "(chat)",
      title: "",
      members: [
        { name: "Yan Levin", email: "owner@school.example", objectId: "a" },
        { name: "Alex Rivera", email: "friend@school.example", objectId: "b" },
      ],
    });
    assert.equal(name, "Alex Rivera");
  });

  it("marks one-on-one CSA chats", () => {
    const row = normalizeChat({
      id: "19:x",
      isOneOnOne: true,
      title: "",
      members: [
        { displayName: "Yan Levin", email: "owner@school.example", objectId: "a" },
        { displayName: "Alex Rivera", email: "friend@school.example", objectId: "b" },
      ],
      lastMessage: { content: "hi", originalArrivalTime: "2026-09-09T12:00:00Z" },
    });
    assert.equal(row.chatType, "oneOnOne");
    assert.equal(row.name, "Alex Rivera");
  });

  it("normalizes a chat message", () => {
    const row = normalizeMessage(
      {
        id: "m1",
        createdDateTime: "2026-09-09T12:00:00Z",
        messageType: "message",
        body: { contentType: "html", content: "<p>Hello</p>" },
        from: {
          user: {
            displayName: "Yan Levin",
            userPrincipalName: "owner@school.example",
          },
        },
      },
      { chatId: "c1", chat: "Alex", kind: "chat" }
    );
    assert.equal(row.fromMe, true);
    assert.equal(row.text, "Hello");
    assert.equal(row.chat, "Alex");
    assert.equal(row.speaker, "Yan");
    assert.equal(row.at, "2026-09-09T12:00:00.000Z");
    assert.match(String(row.atLocal), /PT$/);
  });

  it("picks a unique chat name", () => {
    const rows = [{ name: "Alex Rivera" }, { name: "Alex GC" }];
    assert.equal(pickByName(rows, "prasham dhruva").match.name, "Alex Rivera");
    assert.equal(pickByName(rows, "prasham").ambiguous.length, 2);
  });

  it("keeps hidden Chat-tab 1:1s and groups, drops deleted threads", () => {
    assert.equal(includeCsaChat({ isOneOnOne: true, hidden: true }), true);
    assert.equal(includeCsaChat({ isOneOnOne: false, hidden: true }), true);
    assert.equal(includeCsaChat({ isOneOnOne: false, hidden: false }), true);
    assert.equal(includeCsaChat({ isOneOnOne: true, isConversationDeleted: true }), false);
    assert.equal(includeCsaChat({ isOneOnOne: false, isConversationDeleted: true }), false);
  });

  it("prefers a 1:1 when a group also matches the person", () => {
    const chats = [
      {
        id: "g1",
        name: "Stearns Advisory",
        chatType: "group",
        members: [{ name: "Alex Rivera", email: "friend@school.example" }],
      },
      {
        id: "19:prasham",
        name: "Alex Rivera",
        chatType: "oneOnOne",
        members: [{ name: "Alex Rivera", email: "friend@school.example" }],
      },
    ];
    assert.equal(pickChat(chats, "Alex").match.id, "19:prasham");
    assert.equal(pickChat(chats, "friend@school.example").match.id, "19:prasham");
  });

  it("names Chat with yourself Me and treats it as a 1:1", () => {
    const row = normalizeChat({
      id: "48:notes",
      threadType: "streamofnotes",
      title: "",
      members: [{ displayName: "Yan Levin", email: "owner@school.example" }],
    });
    assert.equal(row.chatType, "oneOnOne");
    assert.equal(row.name, "Me");
    assert.equal(isTeamsSelfChat(row), true);
    assert.equal(isTeamsSelfChat({ chatId: "48:notes" }), true);
  });

  it("pins 48:notes when CSA omitted it", () => {
    const chats = [
      {
        id: "19:prasham",
        name: "Alex Rivera",
        chatType: "oneOnOne",
        members: [{ name: "Alex Rivera", email: "friend@school.example" }],
      },
    ];
    const pinned = ensureSelfChat(chats, {
      email: "owner@school.example",
      name: "Yan Levin",
    });
    assert.equal(pinned[0].id, "48:notes");
    assert.equal(pinned[0].name, "Me");
    assert.equal(pickChat(pinned, "myself").match.id, "48:notes");
    assert.equal(pickChat(pinned, "me").match.id, "48:notes");
    assert.equal(pickChat(pinned, "48:notes").match.id, "48:notes");
    assert.equal(pickChat(pinned, "owner@school.example").match.id, "48:notes");
    assert.equal(pickChat(pinned, "Yan Levin").match.id, "48:notes");
    assert.equal(pickChat(pinned, "Alex").match.id, "19:prasham");
  });

  it("treats IC3 from as fromMe when the from URL contains the oid", () => {
    const oid = "4e03777e-4fc0-4313-bbd0-aaaaaaaaaaaa";
    assert.equal(
      fromMeOf(
        {
          from: `https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/contacts/8:orgid:${oid}`,
        },
        { objectId: oid }
      ),
      true
    );
  });

  it("applies the agent footer on send bodies", () => {
    const body = applyAgentSentFooter("On it", { chat: "Alex", platform: "teams" });
    assert.equal(body, "On it\n\n// Sent by Yan's Personal Agent");
  });

  it("builds an IC3 send body as RichText/Html so desktop keeps newlines", () => {
    const body = buildSendChatBody("On it");
    assert.equal(body.messagetype, "RichText/Html");
    assert.equal(body.contenttype, "text");
    assert.equal(body.content, "<p>On it</p>");
    assert.match(String(body.clientmessageid), /^\d+$/);
  });

  it("turns markdown newlines and bold into Teams HTML", () => {
    const body = buildSendChatBody("**Hi**\nthere");
    assert.equal(body.messagetype, "RichText/Html");
    assert.equal(body.content, "<p><strong>Hi</strong><br>there</p>");
  });

  it("treats IC3 from 8:orgid as fromMe", () => {
    const oid = "4e03777e-4fc0-4313-bbd0-aaaaaaaaaaaa";
    assert.equal(
      fromMeOf({ from: `8:orgid:${oid}` }, { objectId: oid }),
      true
    );
    assert.equal(
      fromMeOf({ from: "8:orgid:someone-else" }, { objectId: oid }),
      false
    );
  });

  it("normalizes an IC3 chat message", () => {
    const oid = "4e03777e-4fc0-4313-bbd0-aaaaaaaaaaaa";
    const row = normalizeMessage(
      {
        id: "m2",
        messagetype: "Text",
        content: "<p>Hello</p>",
        from: `8:orgid:${oid}`,
        imdisplayname: "Yan Levin",
        originalarrivaltime: "2026-09-09T12:00:00.0000000Z",
      },
      { chatId: "c1", chat: "Alex", kind: "chat", self: { objectId: oid } }
    );
    assert.equal(row.fromMe, true);
    assert.equal(row.text, "Hello");
    assert.equal(row.messageType, "message");
    assert.equal(row.chat, "Alex");
  });

  it("drops a quoted parent so a reply does not inherit @agent", () => {
    const html =
      '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="1777952706097"><strong itemprop="mri" itemid="8:orgid:x">Connor West</strong><span itemprop="time" itemid="1777952706097"></span><p itemprop="preview">@agent what model are you and in what harness</p></blockquote>\n<p>It’s composer 2.5 running in cursor cli</p>';
    const text = messageText({ body: { contentType: "html", content: html } });
    assert.equal(text.includes("@agent"), false);
    assert.match(text, /composer 2\.5/i);
    const row = normalizeMessage(
      {
        id: "reply1",
        messageType: "message",
        body: { contentType: "html", content: html },
        from: {
          user: {
            displayName: "Yan Levin",
            userPrincipalName: "owner@school.example",
          },
        },
      },
      { chat: "Class of 2028", chatId: "19:class" }
    );
    assert.equal(shouldTriggerTeamsAgent(row), false);
    const ic3 = messageText({ contenttype: "text", content: html });
    assert.equal(ic3.includes("@agent"), false);
    assert.match(ic3, /composer 2\.5/i);
  });

  it("still triggers when the new reply text itself has @agent", () => {
    const html =
      '<blockquote itemscope="" itemtype="http://schema.skype.com/Reply"><strong itemprop="mri">Connor West</strong><p itemprop="preview">what model are you</p></blockquote><p>@agent what model are you and in what harness</p>';
    const row = normalizeMessage({
      id: "reply2",
      messageType: "message",
      body: { contentType: "html", content: html },
    });
    assert.match(row.text, /@agent what model/);
    assert.equal(shouldTriggerTeamsAgent(row), true);
  });
});

describe("school-teams history dump", () => {
  it("only follows chatsvc backwardLink on Teams hosts", () => {
    const ok = extractBackwardLink({
      _metadata: {
        backwardLink:
          "https://teams.cloud.microsoft/api/chatsvc/amer/v1/users/ME/conversations/19:x/messages?startTime=1",
      },
    });
    assert.match(ok, /\/api\/chatsvc\/amer\/v1\/users\/ME\/conversations\/19:x\/messages/);
    assert.equal(
      extractBackwardLink({
        _metadata: { backwardLink: "https://evil.example/api/chatsvc/x/messages" },
      }),
      ""
    );
    assert.equal(
      extractBackwardLink({
        _metadata: { backwardLink: "https://teams.cloud.microsoft/api/mt/amer/beta/users/1" },
      }),
      ""
    );
  });

  it("skips control and empty messages", () => {
    assert.equal(shouldSkipTeamsDumpMessage({ messageType: "Event/Call", text: "call" }), true);
    assert.equal(shouldSkipTeamsDumpMessage({ messageType: "message", text: "" }), true);
    assert.equal(shouldSkipTeamsDumpMessage({ messageType: "message", text: "hw tonight" }), false);
  });

  it("formats a monthly dump row", () => {
    const text = formatDumpMessage({
      at: "2026-05-13T18:00:00.000Z",
      kind: "chat",
      chat: "Alex Rivera",
      chatType: "oneOnOne",
      from: "Alex Rivera",
      fromEmail: "friend@school.example",
      fromMe: false,
      text: "you free",
    });
    assert.match(text, /^2026-05-13T18:00:00.000Z \| kind=chat \| chat=Alex Rivera/);
    assert.match(text, /speaker=Alex/);
    assert.match(text, /from=Alex Rivera <friend@school.example>/);
    assert.match(text, /fromMe=false/);
    assert.match(text, /atLocal=/);
    assert.match(text, /\nyou free\n/);
    assert.doesNotMatch(text, /fromAgent=true/);
  });

  it("labels an agent footer as speaker Agent while fromMe stays true", () => {
    const oid = "4e03777e-4fc0-4313-bbd0-aaaaaaaaaaaa";
    const row = normalizeMessage(
      {
        id: "m-agent",
        messagetype: "RichText/Html",
        contenttype: "text",
        content:
          "<p>Calc is limits.</p><p><em>// Sent by Yan's Personal Agent</em></p>",
        from: `8:orgid:${oid}`,
        imdisplayname: "Yan Levin",
        originalarrivaltime: "2026-10-12T18:00:00.000Z",
      },
      {
        chatId: "c1",
        chat: "JYPE",
        kind: "chat",
        self: { objectId: oid },
        textMax: 12,
      }
    );
    assert.equal(row.fromMe, true);
    assert.equal(row.fromAgent, true);
    assert.equal(row.speaker, "Agent");
    assert.equal(row.text.includes("Sent by"), false);
    const dumped = formatDumpMessage({
      at: "2026-10-12T18:00:00.000Z",
      kind: "chat",
      chat: "JYPE",
      chatType: "group",
      from: "Yan Levin",
      fromEmail: "owner@school.example",
      fromMe: true,
      text: "Calc is limits.\n\n// Sent by Yan's Personal Agent",
    });
    assert.match(dumped, /speaker=Agent/);
    assert.match(dumped, /fromMe=true/);
    assert.match(dumped, /fromAgent=true/);
  });

  it("groups dump rows by month", () => {
    const months = groupMessagesByMonth([
      { at: "2025-12-31T23:00:00.000Z", text: "a" },
      { at: "2026-01-01T00:00:00.000Z", text: "b" },
    ]);
    assert.deepEqual(
      months.map(([k, rows]) => [k, rows.length]),
      [
        ["2025-12", 1],
        ["2026-01", 1],
      ]
    );
  });
});

describe("school-teams auth errors", () => {
  it("treats 401 and login failures as auth errors", () => {
    const unauthorized = new Error("Teams API 401: User is not authorized.");
    unauthorized.status = 401;
    assert.equal(isTeamsAuthError(unauthorized), true);
    assert.equal(isTeamsAuthError(new Error("timed out waiting for Teams chat tokens")), true);
    assert.equal(isTeamsAuthError(new Error("Teams API 500: boom")), false);
  });

  it("retries recent chat fetch once after 401", async () => {
    let resolves = 0;
    let lists = 0;
    const err = new Error("Teams API 401: User is not authorized.");
    err.status = 401;
    const rows = [{ id: "m1", text: "hi" }];
    const out = await fetchRecentChatMessages({
      resolveSession: async (opts) => {
        resolves += 1;
        if (resolves === 1) assert.equal(opts.allowStale, false);
        if (resolves === 2) assert.equal(opts.refresh, true);
        return { token: `t${resolves}` };
      },
      listRecent: async (session) => {
        lists += 1;
        if (lists === 1) throw err;
        assert.equal(session.token, "t2");
        return rows;
      },
    });
    assert.equal(resolves, 2);
    assert.equal(lists, 2);
    assert.equal(out, rows);
  });

  it("does not refresh when the caller passed a session", async () => {
    const err = new Error("Teams API 401: User is not authorized.");
    err.status = 401;
    await assert.rejects(
      () =>
        fetchRecentChatMessages({
          session: { token: "x" },
          resolveSession: async () => {
            throw new Error("should not resolve");
          },
          listRecent: async () => {
            throw err;
          },
        }),
      /401/
    );
  });
});

describe("school-teams status", () => {
  it("reports signedOut on an empty profile dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-teams-"));
    try {
      const r = await runSchoolTeams(["status"], { root: dir });
      assert.equal(r.ok, true);
      assert.equal(r.signedIn, false);
      assert.equal(r.account, "owner@school.example");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("chats without a session returns not signed in", async () => {
    const dir = await mkdtemp(join(tmpdir(), "school-teams-"));
    try {
      const r = await runSchoolTeams(["chats"], { root: dir });
      assert.equal(r.ok, false);
      assert.equal(r.error, "not signed in");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
