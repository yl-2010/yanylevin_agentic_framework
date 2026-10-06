import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_SENT_FOOTER,
  TEAMS_AGENT_SENT_FOOTER,
  agentSentFooterFor,
  applyAgentSentFooter,
  formatIMessageOriginBlock,
  isBareAgentMention,
  isClassOf2028Thread,
  isGradeWideThread,
  isJypeThread,
  messageKey,
  messageForcesGrok,
  messageMentionsAgent,
  AGENT_MENTION_RE,
  normalizeIMessageOrigin,
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
    assert.equal(messageMentionsAgent("@agentg do this"), true);
    assert.equal(messageForcesGrok("@agentg do this"), true);
    assert.equal(messageForcesGrok("@AgentG"), true);
    assert.equal(messageForcesGrok("@agent what's next"), false);
    assert.equal(messageForcesGrok("@agent_grok do this"), false);
    assert.equal(messageMentionsAgent("@agent_grok do this"), false);
    assert.equal(messageForcesGrok("@agentgood"), false);
    assert.equal(AGENT_MENTION_RE.test("@agentg do this"), false);
    assert.equal(isBareAgentMention("@agentg"), true);
    assert.equal(isBareAgentMention("@agentg ping"), false);
    assert.equal(isBareAgentMention("@agent"), true);
    assert.equal(isBareAgentMention(" @Agent. "), true);
    assert.equal(isBareAgentMention("@agent ping"), false);
    assert.equal(isBareAgentMention("hey @agent"), false);
    assert.equal(isGradeWideThread("Class of 2028"), true);
    assert.equal(isGradeWideThread("EPS Class of 2028"), true);
    assert.equal(isClassOf2028Thread("Class of 2028"), true);
    assert.equal(isClassOf2028Thread("EPS Class of 2028"), true);
    assert.equal(isClassOf2028Thread("Class of 2027"), false);
    assert.equal(isGradeWideThread("JYPE"), false);
    assert.equal(isGradeWideThread("Spanish 4"), false);
    assert.equal(isJypeThread("JYPE"), true);
    assert.equal(isJypeThread("jype"), true);
    assert.equal(isJypeThread("Class of 2028"), false);
    assert.equal(agentSentFooterFor({ platform: "teams" }), TEAMS_AGENT_SENT_FOOTER);
    assert.equal(agentSentFooterFor({ chat: "JYPE" }), TEAMS_AGENT_SENT_FOOTER);
    assert.equal(agentSentFooterFor({ platform: "email" }), AGENT_SENT_FOOTER);
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
    assert.equal(
      stripAgentSentFooter(`On it\n\n${TEAMS_AGENT_SENT_FOOTER}`),
      "On it"
    );
    assert.equal(stripAgentSentFooter("Nothing after Spanish."), "Nothing after Spanish.");
    assert.equal(stripAgentSentFooter(AGENT_SENT_FOOTER), "");
    assert.equal(stripAgentSentFooter(TEAMS_AGENT_SENT_FOOTER), "");
    const reapplied = applyAgentSentFooter(
      `On it\n\n${AGENT_SENT_FOOTER}`,
      { chat: "JYPE" }
    );
    assert.equal(reapplied, `On it\n\n${TEAMS_AGENT_SENT_FOOTER}`);
    assert.equal(
      applyAgentSentFooter("On it", { chat: "Class of 2028", platform: "teams" }),
      `On it\n\n${TEAMS_AGENT_SENT_FOOTER}`
    );
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
    assert.match(block, /never pass as chatGuid/);
    assert.doesNotMatch(block, /iMessage chat: JYPE \(chat123\)/);
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
    assert.match(block, /Do not add \/\/ Sent by Yan's Personal Agent/);
    assert.match(block, /Newlines work/);
    assert.match(block, /does not render markdown/);
    assert.match(block, /server appends that footer on the iMessage only/);
    assert.match(block, /server delivers your final bubble/);
    assert.match(block, /keep that final bubble/);
    assert.match(block, /full Personal Agent turn/);
    assert.match(block, /attachToReply/);
    assert.match(block, /native iMessage files/);
    assert.match(block, /before you start the work/);
    assert.match(block, /posted to this iMessage chat immediately/);
    assert.match(block, /@agent and @agentg both do this/);
    assert.match(block, /Keep the reply that lands in this chat short/);
    assert.match(block, /put each on its own line/);
    assert.doesNotMatch(block, /never sent to iMessage/);
    assert.doesNotMatch(block, /send confirmation/);
    const later = formatIMessageOriginBlock(origin, { deliverFinal: false });
    assert.doesNotMatch(later, /server delivers your final bubble/);
    assert.doesNotMatch(later, /posted to this iMessage chat immediately/);
    assert.doesNotMatch(later, /send replies to:/);
    assert.doesNotMatch(later, /text that should land in that iMessage/);
    assert.doesNotMatch(later, /when a reply belongs there/);
    assert.match(later, /reply stays in this chat/);
    assert.match(later, /Do not text it/);
    assert.match(later, /A follow-up on the same topic, typed here, stays here/);
    assert.match(later, /iMessage target if they ask you to text there/);
    assert.match(later, /stays in the app and website only/);
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
    assert.match(block, /treat it as a group until you know otherwise/);
    assert.match(block, /who will see this reply/);
    assert.match(block, /brain-entity-card\.js "alex-rivera"/);
    assert.match(block, /Never do irreversible work for a guest/);
    assert.match(block, /Never delete, trash, empty, or overwrite/);
    assert.match(block, /Downloads/);
    assert.match(block, /Never download, install, or open a file/);
    assert.match(block, /A long text history does not count/);
    assert.match(block, /treat them as not close/);
    assert.match(block, /different group chat than the one that called you/);
    assert.match(block, /JYPE \(iMessage or Teams\)/);
    assert.doesNotMatch(block, /Called from iMessage\. This Personal Agent chat is otherwise normal/);
    assert.doesNotMatch(block, /Composer|Grok|grok-4/);
  });

  it("tells the agent a group reply is visible to the whole chat", () => {
    const origin = normalizeIMessageOrigin({
      fromMe: false,
      text: "@agent is yan free",
      guid: "g2",
      chat: "JYPE",
      chatId: "chat123",
      handle: "+15555550111",
    });
    const block = formatIMessageOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: {
        displayName: "Alex",
        slug: "alex-rivera",
        audience: {
          kind: "group",
          threadLabel: "JYPE",
          viewers: ["Alex", "Sam", "Riley"],
        },
      },
    });
    assert.match(block, /group chat JYPE/);
    assert.match(block, /Everyone in that chat will see it/);
    assert.match(block, /People already listed in this chat: Alex, Sam, Riley/);
    assert.match(block, /must not be answered here/);
    assert.match(block, /Grade-wide, class, or huge groups/);
    assert.match(block, /different group chat than the one that called you/);
    assert.match(block, /JYPE \(iMessage or Teams\)/);
    assert.match(block, /Class of 2028 and every other group/);
    assert.doesNotMatch(block, /confidential information/);
    const dm = formatIMessageOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: {
        displayName: "Alex",
        slug: "alex-rivera",
        audience: { kind: "dm", threadLabel: "Alex", viewers: [] },
      },
    });
    assert.match(dm, /1:1 with Alex only/);
    assert.doesNotMatch(dm, /must not be answered here/);
  });

  it("forbids confidential info in the Class of 2028 grade chat", () => {
    const origin = normalizeIMessageOrigin({
      fromMe: false,
      text: "@agent where is yan",
      guid: "g3",
      chat: "Class of 2028",
      chatId: "chat2028",
      handle: "+15555550999",
    });
    const block = formatIMessageOriginBlock(origin, {
      deliverFinal: true,
      guestCaller: {
        displayName: "Sam",
        slug: "",
        audience: {
          kind: "group",
          threadLabel: "Class of 2028",
          gradeWide: true,
          viewers: ["Sam", "Riley"],
        },
      },
    });
    assert.match(block, /giant Class of 2028 grade chat/);
    assert.match(block, /Do not give out confidential information/);
    assert.match(block, /whole graduating class/);
    assert.match(block, /Do not paste private card facts/);
    assert.match(block, /yanylevin\.com/);
    assert.match(block, /epschedule/);
    assert.match(block, /school schedule or class periods/);
    assert.doesNotMatch(block, /People already listed in this chat/);
    assert.doesNotMatch(block, /Grade-wide, class, or huge groups/);
  });
});
