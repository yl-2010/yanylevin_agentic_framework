import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SENT_FOOTER,
  applyAgentSentFooter,
  formatIMessageOriginBlock,
  formatOutboundSendConfirmation,
  isBareAgentMention,
  messageKey,
  messageMentionsAgent,
  normalizeIMessageOrigin,
  outboundThreadLabel,
  replyTargetForMessage,
  shouldOmitAgentFooter,
  shouldTriggerIMessageAgent,
  stripAgentSentFooter,
} from "./imessage-mention.js";

describe("imessage-mention", () => {
  it("matches @agent / @Agent and not emails or bare agent", () => {
    assert.equal(messageMentionsAgent("@agent what's next"), true);
    assert.equal(messageMentionsAgent("hey @Agent do this"), true);
    assert.equal(messageMentionsAgent("@AGENT"), true);
    assert.equal(messageMentionsAgent("agent please"), false);
    assert.equal(messageMentionsAgent("foo@agent.com"), false);
    assert.equal(messageMentionsAgent("write @agency"), false);
    assert.equal(isBareAgentMention("@agent"), true);
    assert.equal(isBareAgentMention(" @Agent. "), true);
    assert.equal(isBareAgentMention("@agent ping"), false);
    assert.equal(isBareAgentMention("hey @agent"), false);
  });

  it("triggers on Yan fromMe or guest texts with the token", () => {
    const base = {
      fromMe: true,
      text: "@agent add the essay",
      guid: "G1",
      chat: "Example Friend",
      chatId: "+14253260143",
      handle: "+14253260143",
    };
    assert.equal(shouldTriggerIMessageAgent(base), true);
    assert.equal(shouldTriggerIMessageAgent({ ...base, fromMe: false }), true);
    assert.equal(
      shouldTriggerIMessageAgent({ ...base, tapback: { action: "liked" } }),
      false
    );
    assert.equal(
      shouldTriggerIMessageAgent({ ...base, associatedType: 2001 }),
      false
    );
    assert.equal(
      shouldTriggerIMessageAgent({
        ...base,
        text: `ok\n\n${AGENT_SENT_FOOTER}`,
      }),
      false
    );
    assert.equal(shouldTriggerIMessageAgent({ ...base, text: "hello" }), false);
  });

  it("picks named groups then handles then chat ids", () => {
    assert.equal(
      replyTargetForMessage({
        chat: "JYPE",
        chatId: "chat123",
        handle: "+14255550100",
      }),
      "JYPE"
    );
    assert.equal(
      replyTargetForMessage({
        chat: "+14253260143",
        chatId: "+14253260143",
        handle: "+14253260143",
      }),
      "+14253260143"
    );
    assert.equal(
      replyTargetForMessage({
        chat: "chat999",
        chatId: "chat999",
        handle: "",
      }),
      "chat999"
    );
  });


  it("applies the agent footer by default", () => {
    const withFooter = applyAgentSentFooter("On it", { chat: "JYPE" });
    assert.match(withFooter, /On it/);
    assert.match(withFooter, new RegExp(AGENT_SENT_FOOTER));
    assert.equal(shouldOmitAgentFooter({ chat: "JYPE" }), false);
  });

  it("strips a trailing agent footer from app bubbles", () => {
    assert.equal(
      stripAgentSentFooter(`Nothing after Spanish.\n\n${AGENT_SENT_FOOTER}`),
      "Nothing after Spanish."
    );
    assert.equal(stripAgentSentFooter("Nothing after Spanish."), "Nothing after Spanish.");
    assert.equal(stripAgentSentFooter(AGENT_SENT_FOOTER), "");
    const reapplied = applyAgentSentFooter(
      `On it\n\n${AGENT_SENT_FOOTER}`,
      { chat: "JYPE" }
    );
    assert.equal(reapplied, `On it\n\n${AGENT_SENT_FOOTER}`);
  });

  it("formats origin context with a thread lookup", () => {
    const origin = normalizeIMessageOrigin({
      fromMe: true,
      text: "@agent ping",
      guid: "abc",
      chat: "JYPE",
      chatId: "chat123",
      handle: "+14255550100",
    });
    assert.equal(origin?.to, "JYPE");
    assert.equal(origin?.key, "guid:abc");
    assert.equal(messageKey({ guid: "abc" }), "guid:abc");
    const block = formatIMessageOriginBlock(origin, { deliverFinal: true });
    assert.match(block, /Called from iMessage/);
    assert.match(block, /JYPE/);
    assert.match(block, /chat123/);
    assert.match(block, /imessage\/thread\?person=chat123/);
    assert.match(block, /limit=40/);
    assert.doesNotMatch(block, /only @agent/);
    const bare = formatIMessageOriginBlock(
      normalizeIMessageOrigin({
        fromMe: true,
        text: "@agent",
        guid: "def",
        chat: "JYPE",
        chatId: "chat123",
        handle: "+14255550100",
      }),
      { deliverFinal: true }
    );
    assert.match(bare, /only @agent/);
    assert.match(bare, /infer why they called you/);
    assert.match(bare, /limit=80/);
    assert.match(block, /Do not add Sent by Yan's Personal Agent/);
    assert.match(block, /server appends that footer on the iMessage only/);
    assert.match(block, /server delivers your final bubble/);
    assert.match(block, /send confirmation/);
    assert.doesNotMatch(
      formatIMessageOriginBlock(origin, { deliverFinal: false }),
      /server delivers your final bubble/
    );
  });

  it("tells the agent a guest called, not Yan", () => {
    const origin = normalizeIMessageOrigin({
      fromMe: false,
      text: "@agent is yan free this afternoon",
      guid: "g1",
      chat: "Alex",
      chatId: "+15555550111",
      handle: "+15555550111",
    });
    const block = formatIMessageOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: { displayName: "Alex", slug: "alex-rivera" },
    });
    assert.match(block, /Called by Alex \(not Yan\) on iMessage/);
    assert.match(block, /not Yan's instructions/);
    assert.match(block, /brain-entity-card\.js "alex-rivera"/);
    assert.match(block, /Never do irreversible work for a guest/);
    assert.match(block, /Never delete, trash, empty, or overwrite/);
    assert.match(block, /Downloads/);
    assert.match(block, /treat them as not close/);
    assert.doesNotMatch(block, /Called from iMessage\. This Personal Agent chat is otherwise normal/);
    assert.doesNotMatch(block, /Composer|Grok|grok-4/);
  });

  it("confirms outbound sends without quoting the body", () => {
    assert.equal(
      formatOutboundSendConfirmation("iMessage", { chat: "Example Friend" }),
      "Sent on iMessage to Example Friend"
    );
    assert.equal(
      formatOutboundSendConfirmation("Teams", { chat: "Alex Rivera" }),
      "Sent on Teams to Alex Rivera"
    );
    assert.equal(
      formatOutboundSendConfirmation("iMessage", { chat: "JYPE" }),
      "Sent on iMessage to JYPE"
    );
    assert.equal(
      formatOutboundSendConfirmation("iMessage", { chat: "+14255550100" }),
      "Sent on iMessage"
    );
    assert.equal(
      formatOutboundSendConfirmation("Teams", { chat: "19:abc" }),
      "Sent on Teams"
    );
    assert.equal(outboundThreadLabel({ chat: "foo@agent.com" }), "");
    assert.equal(outboundThreadLabel({ chat: "chat123" }), "");
  });
});
