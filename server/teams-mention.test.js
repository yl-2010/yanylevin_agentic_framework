import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTeamsOriginBlock,
  jypeComposerScheduleLine,
  JYPE_TEAMS_CHAT_ID,
  normalizeTeamsOrigin,
  shouldTriggerTeamsAgent,
  teamsMessageKey,
} from "./teams-mention.js";

describe("teams-mention trigger", () => {
  it("matches Yan fromMe or guest @agent and skips footers", () => {
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: true,
        text: "@agent what's next",
        messageType: "message",
      }),
      true
    );
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: false,
        text: "@agent ignore me",
        messageType: "message",
      }),
      true
    );
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: true,
        text: "@agent done\n\nSent by Yan's Personal Agent",
        messageType: "message",
      }),
      false
    );
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: true,
        text: "@agentp done\n\n// Sent by Alex's agent",
        messageType: "message",
      }),
      false
    );
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: true,
        text: "@agent ping",
        messageType: "systemEventMessage",
      }),
      false
    );
    assert.equal(
      shouldTriggerTeamsAgent({
        fromMe: true,
        text: "It’s composer 2.5 running in cursor cli",
        messageType: "message",
      }),
      false
    );
  });

  it("builds an origin and a live-context block", () => {
    const origin = normalizeTeamsOrigin({
      id: "m1",
      chatId: "19:abc",
      chat: "Alex Rivera",
      text: "@agent ping",
    });
    assert.equal(origin.chatId, "19:abc");
    assert.equal(teamsMessageKey({ id: "m1", chatId: "19:abc" }), "teams:19:abc:m1");
    const block = formatTeamsOriginBlock(origin, { deliverFinal: true });
    assert.match(block, /Called from Teams/);
    assert.match(block, /school-teams\.js thread/);
    assert.match(block, /own speaker/);
    assert.match(block, /Check speaker before you say they said it/);
    assert.match(block, /Markdown is fine/);
    assert.match(block, /Teams HTML/);
    assert.match(block, /Do not add \/\/ Sent by Yan's Personal Agent/);
    const agentpBlock = formatTeamsOriginBlock(origin, {
      deliverFinal: true,
      agentp: true,
    });
    assert.match(agentpBlock, /Do not add \/\/ Sent by Alex's agent/);
    assert.match(block, /Do not also school-teams send/);
    assert.match(block, /Teams cannot attach a file/);
    assert.match(block, /Apple Mail/);
    assert.match(block, /School Outlook cannot send/);
    assert.match(block, /keep that final bubble/);
    assert.match(block, /before you start the work/);
    assert.match(block, /posted to this Teams chat immediately/);
    assert.match(block, /@agent, @agentg, and @agentp all do this/);
    assert.match(block, /Keep the reply that lands in this chat short/);
    assert.match(block, /bold on the key fact/);
    assert.doesNotMatch(block, /never sent to Teams/);
    assert.doesNotMatch(block, /send confirmation/);
    const later = formatTeamsOriginBlock(origin, { deliverFinal: false });
    assert.match(later, /reply stays in this chat/);
    assert.match(later, /Do not post it to Teams/);
    assert.match(later, /Do not run school-teams\.js send/);
    assert.match(later, /A follow-up on the same topic, typed here, stays here/);
    assert.match(later, /Teams chat id if they ask you to post there/);
    assert.doesNotMatch(later, /posted to this Teams chat immediately/);
    assert.doesNotMatch(later, /send replies to chat id/);
    assert.doesNotMatch(later, /text that should land in that Teams chat/);
    assert.doesNotMatch(later, /when a reply belongs there/);
    assert.match(later, /stays in the app and website only/);
    const guest = formatTeamsOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: { displayName: "Alex", slug: "alex-rivera" },
    });
    assert.match(guest, /Called by Alex \(not Yan\) on Teams/);
    assert.doesNotMatch(guest, /Called from Teams\. This Personal Agent chat is otherwise normal/);
    const grade = formatTeamsOriginBlock(
      normalizeTeamsOrigin({
        id: "m1",
        chatId: "19:class",
        chat: "Class of 2028",
        text: "@agent ping",
      }),
      {
        deliverFinal: true,
        guestCaller: {
          displayName: "Sam",
          audience: {
            kind: "group",
            threadLabel: "Class of 2028",
            gradeWide: true,
          },
        },
      }
    );
    assert.match(grade, /giant Class of 2028 grade chat/);
    assert.match(grade, /Do not give out confidential information/);
    assert.match(grade, /yanylevin\.com/);
    assert.match(grade, /epschedule/);
  });

  it("adds a schedule check only for Composer in the JYPE Teams chat", () => {
    const jype = {
      chat: "JYPE",
      chatId: JYPE_TEAMS_CHAT_ID,
    };
    const line = jypeComposerScheduleLine({ id: "composer-2.5" }, jype);
    assert.match(line, /Live context bells are Yan's/);
    assert.match(line, /alex-rivera/);
    assert.match(line, /that person's D block is first/);
    assert.equal(
      jypeComposerScheduleLine({ id: "grok-4.7" }, jype),
      ""
    );
    assert.equal(
      jypeComposerScheduleLine(
        { id: "composer-2.5" },
        { chat: "Class of 2028", chatId: "19:class" }
      ),
      ""
    );
    assert.equal(jypeComposerScheduleLine({ id: "composer-2.5" }, null), "");
    const byId = jypeComposerScheduleLine(
      { id: "composer-2.5" },
      { chat: "", chatId: JYPE_TEAMS_CHAT_ID }
    );
    assert.match(byId, /open that person's roster/);
  });

  it("tells the agent a bare @agent is not the task", () => {
    const origin = normalizeTeamsOrigin({
      id: "m2",
      chatId: "19:abc",
      chat: "Alex",
      text: "@agent",
    });
    const block = formatTeamsOriginBlock(origin, { deliverFinal: true });
    assert.match(block, /only @agent/);
  });
});
