import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractBackwardLink,
  formatDumpMessage,
  groupMessagesByMonth,
  shouldSkipTeamsDumpMessage,
  TEAMS_CLOUD,
  buildChatMessagesUrl,
  buildChatsUrl,
  buildSendChatBody,
  buildSendChatUrl,
  chatDisplayName,
  fromMeOf,
  isCsaToken,
  isGraphAudience,
  isIc3Token,
  isTeamsToken,
  normalizeChat,
  normalizeMessage,
  parseArgs,
  includeCsaChat,
  pickByName,
  pickChat,
  runSchoolTeams,
  teamsScopes,
} from "./school-teams.js";
import { applyAgentSentFooter } from "./imessage-mention.js";

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
  });

  it("picks a unique chat name", () => {
    const rows = [{ name: "Alex Rivera" }, { name: "Alex GC" }];
    assert.equal(pickByName(rows, "prasham dhruva").match.name, "Alex Rivera");
    assert.equal(pickByName(rows, "prasham").ambiguous.length, 2);
  });

  it("keeps hidden 1:1 chats and drops hidden groups", () => {
    assert.equal(includeCsaChat({ isOneOnOne: true, hidden: true }), true);
    assert.equal(includeCsaChat({ isOneOnOne: false, hidden: true }), false);
    assert.equal(includeCsaChat({ isOneOnOne: false, hidden: false }), true);
    assert.equal(includeCsaChat({ isOneOnOne: true, isConversationDeleted: true }), false);
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

  it("applies the agent footer on send bodies", () => {
    const body = applyAgentSentFooter("On it", { chat: "Alex" });
    assert.equal(body, "On it\n\nSent by Yan's Personal Agent");
  });

  it("builds an IC3 send body without the footer (CLI applies that first)", () => {
    const body = buildSendChatBody("On it");
    assert.equal(body.messagetype, "Text");
    assert.equal(body.content, "On it");
    assert.match(String(body.clientmessageid), /^\d+$/);
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
    assert.match(text, /from=Alex Rivera <friend@school.example>/);
    assert.match(text, /fromMe=false/);
    assert.match(text, /\nyou free\n/);
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
