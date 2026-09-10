import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatTeamsOriginBlock,
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
        text: "@agent ping",
        messageType: "systemEventMessage",
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
    assert.match(block, /Do not add Sent by Yan's Personal Agent/);
    assert.match(block, /Do not also school-teams send/);
    assert.match(block, /send confirmation/);
    const later = formatTeamsOriginBlock(origin, { deliverFinal: false });
    assert.match(later, /Later app turns do not auto-post/);
    const guest = formatTeamsOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: { displayName: "Alex", slug: "alex-rivera" },
    });
    assert.match(guest, /Called by Alex \(not Yan\) on Teams/);
    assert.doesNotMatch(guest, /Called from Teams\. This Personal Agent chat is otherwise normal/);
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
