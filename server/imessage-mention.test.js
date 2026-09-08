import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SENT_FOOTER,
  applyAgentSentFooter,
  formatIMessageOriginBlock,
  messageKey,
  messageMentionsAgent,
  normalizeIMessageOrigin,
  replyTargetForMessage,
  shouldOmitAgentFooter,
  shouldTriggerIMessageAgent,
} from "./imessage-mention.js";

describe("imessage-mention", () => {
  it("matches @agent / @Agent and not emails or bare agent", () => {
    assert.equal(messageMentionsAgent("@agent what's next"), true);
    assert.equal(messageMentionsAgent("hey @Agent do this"), true);
    assert.equal(messageMentionsAgent("@AGENT"), true);
    assert.equal(messageMentionsAgent("agent please"), false);
    assert.equal(messageMentionsAgent("foo@agent.com"), false);
    assert.equal(messageMentionsAgent("write @agency"), false);
  });

  it("triggers only on Yan fromMe texts with the token", () => {
    const base = {
      fromMe: true,
      text: "@agent add the essay",
      guid: "G1",
      chat: "Example Friend",
      chatId: "+14253260143",
      handle: "+14253260143",
    };
    assert.equal(shouldTriggerIMessageAgent(base), true);
    assert.equal(shouldTriggerIMessageAgent({ ...base, fromMe: false }), false);
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
    assert.match(block, /server delivers your final bubble/);
    assert.doesNotMatch(
      formatIMessageOriginBlock(origin, { deliverFinal: false }),
      /server delivers your final bubble/
    );
  });
});
