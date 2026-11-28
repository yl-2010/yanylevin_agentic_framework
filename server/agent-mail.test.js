import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_MAIL_RULE,
  ORCHESTRATOR_RULE,
  ORCHESTRATOR_STEER_NOTE,
  SUBAGENT_RULE,
  agentMailInterrupts,
  canMailThread,
  filterMailThreads,
  formatAgentMailBubble,
  incomingMailEffects,
  mailFamilyIds,
  channelAnswerNote,
  mailTurnNote,
  orchestratorMailNote,
  rolePrompt,
  unpinOrchestratorForMention,
} from "./agent-mail.js";

describe("formatAgentMailBubble", () => {
  it("puts the title on the first line, then a blank line, then the trimmed text", () => {
    assert.equal(
      formatAgentMailBubble("Calc homework", "  look at problem 4  "),
      'From "Calc homework":\n\nlook at problem 4'
    );
  });

  it("replaces double quotes in the title with single quotes", () => {
    assert.equal(
      formatAgentMailBubble('Say "hi" now', "yo"),
      `From "Say 'hi' now":\n\nyo`
    );
  });

  it("uses Chat when the title is empty", () => {
    assert.equal(formatAgentMailBubble("", "hello"), 'From "Chat":\n\nhello');
    assert.equal(formatAgentMailBubble("   ", "hello"), 'From "Chat":\n\nhello');
    assert.equal(formatAgentMailBubble(null, "hello"), 'From "Chat":\n\nhello');
  });
});

describe("agentMailInterrupts", () => {
  const sender = { role: "orchestrator", sessionId: "orch-1" };

  it("is true only for the orchestrator's own running subagent", () => {
    assert.equal(
      agentMailInterrupts(sender, {
        role: "subagent",
        sessionId: "sub-1",
        parentSessionId: "orch-1",
        status: "running",
      }),
      true
    );
    assert.equal(
      agentMailInterrupts(
        { role: "orchestrator", sessionId: 5 },
        {
          role: "subagent",
          parentSessionId: "5",
          status: "running",
        }
      ),
      true
    );
  });

  it("is false for a running orchestrator, an idle subagent, or someone else's subagent", () => {
    assert.equal(
      agentMailInterrupts(sender, {
        role: "orchestrator",
        sessionId: "orch-2",
        status: "running",
      }),
      false
    );
    assert.equal(
      agentMailInterrupts(sender, {
        role: "subagent",
        parentSessionId: "orch-1",
        status: "idle",
      }),
      false
    );
    assert.equal(
      agentMailInterrupts(sender, {
        role: "subagent",
        parentSessionId: "other",
        status: "running",
      }),
      false
    );
    assert.equal(
      agentMailInterrupts(
        {
          role: "subagent",
          sessionId: "sub-1",
          parentSessionId: "orch-1",
          status: "running",
        },
        { role: "orchestrator", sessionId: "orch-1", status: "running" }
      ),
      false
    );
    assert.equal(agentMailInterrupts(null, sender), false);
    assert.equal(agentMailInterrupts(sender, null), false);
  });
});

describe("canMailThread", () => {
  const rows = [
    { sessionId: "orch-1", parentSession: "", workspace: "" },
    { sessionId: "sub-1", parentSession: "orch-1", workspace: "" },
    { sessionId: "mailer-1", parentSession: "", workspace: "" },
    { sessionId: "random-1", parentSession: "stranger", workspace: "" },
    { sessionId: "jype-1", parentSession: "", workspace: "jype" },
  ];

  const guest = {
    role: "orchestrator",
    sessionId: "orch-1",
    workspace: "",
    mailScope: "family",
    childSessionIds: ["sub-1"],
    lastMailFromSessionId: "mailer-1",
  };

  it("lets a guest orchestrator mail its subagent and the thread that just mailed it", () => {
    const family = mailFamilyIds(guest, rows);
    assert.equal(family.has("orch-1"), true);
    assert.equal(family.has("sub-1"), true);
    assert.equal(family.has("mailer-1"), true);
    assert.equal(family.has("random-1"), false);

    assert.equal(
      canMailThread(guest, { sessionId: "sub-1", workspace: "" }, rows),
      true
    );
    assert.equal(
      canMailThread(guest, { sessionId: "mailer-1", workspace: "" }, rows),
      true
    );
    assert.equal(
      canMailThread(guest, { sessionId: "random-1", workspace: "" }, rows),
      false
    );
  });

  it("picks up a subagent from the row list when childSessionIds is empty", () => {
    const sender = { ...guest, childSessionIds: [] };
    assert.equal(
      canMailThread(sender, { sessionId: "sub-1", workspace: "" }, rows),
      true
    );
  });

  it("lets open scope mail any same-workspace thread, and blocks a different workspace", () => {
    const open = {
      role: "orchestrator",
      sessionId: "orch-1",
      workspace: "",
      mailScope: "open",
    };
    assert.equal(
      canMailThread(open, { sessionId: "random-1", workspace: "" }, rows),
      true
    );
    assert.equal(
      canMailThread(open, { sessionId: "jype-1", workspace: "jype" }, rows),
      false
    );
    assert.equal(
      canMailThread(
        { ...open, workspace: "jype" },
        { sessionId: "home-thread", workspace: "" },
        rows
      ),
      false
    );
    assert.equal(canMailThread(null, { sessionId: "random-1" }, rows), false);
    assert.equal(canMailThread(open, null, rows), false);
  });
});

describe("filterMailThreads", () => {
  it("keeps a hidden row for open scope, including a row with no workspace of its own", () => {
    const sender = {
      sessionId: "a",
      workspace: "jype",
      mailScope: "open",
    };
    const hidden = {
      sessionId: "hidden-1",
      workspace: "jype",
      hidden: true,
      title: "secret",
    };
    const prefiltered = { sessionId: "pre-1", hidden: true, title: "already scoped" };
    const otherHome = { sessionId: "home-1", workspace: "", hidden: true };
    const kept = filterMailThreads([hidden, prefiltered, otherHome], sender);
    assert.deepEqual(kept, [hidden, prefiltered]);
  });

  it("keeps only family session ids when mailScope is family", () => {
    const sender = {
      role: "subagent",
      sessionId: "sub-1",
      parentSessionId: "orch-1",
      workspace: "",
      mailScope: "family",
      lastMailFromSessionId: "mailer-1",
    };
    const rows = [
      { sessionId: "orch-1", parentSession: "" },
      { sessionId: "sub-1", parentSession: "orch-1" },
      { sessionId: "sib-1", parentSession: "orch-1", hidden: true },
      { sessionId: "mailer-1", parentSession: "" },
      { sessionId: "random-1", parentSession: "stranger", hidden: true },
    ];
    const kept = filterMailThreads(rows, sender).map((row) => row.sessionId);
    assert.deepEqual(kept, ["orch-1", "sub-1", "sib-1", "mailer-1"]);
  });
});

describe("incomingMailEffects", () => {
  it("skips pin, focus, and channel when the turn is mail", () => {
    assert.deepEqual(incomingMailEffects({ text: "hi" }), {
      pin: false,
      focus: false,
      channel: false,
    });
  });

  it("keeps pin, focus, and channel for a normal turn", () => {
    assert.deepEqual(incomingMailEffects(null), {
      pin: true,
      focus: true,
      channel: true,
    });
    assert.deepEqual(incomingMailEffects(""), {
      pin: true,
      focus: true,
      channel: true,
    });
  });
});

describe("mailTurnNote", () => {
  it("names the sender session and includes the stop sentence", () => {
    const note = mailTurnNote("sess-9");
    assert.match(note, /sess-9/);
    assert.match(note, /not part of the bubble/);
    assert.match(note, /message_agent/);
    assert.match(note, /If this is already the answer to what you asked, stop\./);
  });

  it("tells the orchestrator to post that piece now", () => {
    const note = orchestratorMailNote("sess-9");
    assert.match(note, /sess-9/);
    assert.match(note, /send_chat_message now/);
    assert.match(note, /Do not wait for other subagents/);
    assert.equal(note.includes("message_agent to that sessionId"), false);
  });
});

describe("channelAnswerNote", () => {
  it("keeps the latest chat lines and the short-reply rule", () => {
    const note = channelAnswerNote(
      "teams",
      ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"].join("\n")
    );
    assert.match(note, /The orchestrator will post this in Teams/);
    assert.match(note, /You do not send it/);
    assert.match(note, /A few sentences/);
    assert.equal(note.split("\n").includes("one"), false);
    assert.equal(note.split("\n").includes("two"), true);
    assert.equal(note.split("\n").includes("nine"), true);
    assert.equal(channelAnswerNote("", "hi"), "");
    assert.equal(channelAnswerNote("imessage", "").includes("Recent messages"), false);
  });
});

describe("unpinOrchestratorForMention", () => {
  it("clears pin flags only on an orchestrator", () => {
    const orchestrator = {
      role: "orchestrator",
      ephemeralPinned: true,
      agentDeferHide: true,
    };
    assert.equal(unpinOrchestratorForMention(orchestrator), true);
    assert.equal(orchestrator.ephemeralPinned, false);
    assert.equal(orchestrator.agentDeferHide, false);

    const subagent = {
      role: "subagent",
      ephemeralPinned: true,
      agentDeferHide: true,
    };
    assert.equal(unpinOrchestratorForMention(subagent), false);
    assert.equal(subagent.ephemeralPinned, true);
    assert.equal(subagent.agentDeferHide, true);
    assert.equal(unpinOrchestratorForMention(null), false);
  });
});

describe("role prompts", () => {
  it("returns the matching rule, or nothing for a normal thread", () => {
    assert.equal(rolePrompt({ role: "orchestrator" }), ORCHESTRATOR_RULE);
    assert.equal(rolePrompt({ role: "subagent" }), SUBAGENT_RULE);
    assert.equal(rolePrompt({ role: "user" }), "");
    assert.equal(rolePrompt(null), "");
    assert.match(ORCHESTRATOR_STEER_NOTE, /current task/);
    assert.match(ORCHESTRATOR_STEER_NOTE, /Do not post to Teams or iMessage/);
    assert.equal(AGENT_MAIL_RULE.includes("("), false);
    assert.equal(AGENT_MAIL_RULE.includes(")"), false);
    assert.equal(AGENT_MAIL_RULE.includes("\u2014"), false);
    assert.match(AGENT_MAIL_RULE, /message_agent/);
    assert.match(AGENT_MAIL_RULE, /list_agent_threads/);
    assert.match(SUBAGENT_RULE, /sendIMessage/);
    assert.match(ORCHESTRATOR_RULE, /Weather and a website are two jobs/);
    assert.equal(ORCHESTRATOR_RULE.includes("final reply on a mention turn is posted"), false);
    assert.match(ORCHESTRATOR_RULE, /Your final text is not posted/);
    assert.match(ORCHESTRATOR_RULE, /Do not wait for the other jobs/);
    assert.equal(ORCHESTRATOR_RULE.includes("wait if another job is still out"), false);
    assert.match(SUBAGENT_RULE, /mail the short result when you finish/);
    assert.match(SUBAGENT_RULE, /Do not mail a briefing/);
    assert.match(ORCHESTRATOR_RULE, /Do not paste the memo/);
    assert.match(ORCHESTRATOR_RULE, /Blue website, then make it red/);
    assert.match(ORCHESTRATOR_RULE, /Do not start a second subagent/);
    assert.match(ORCHESTRATOR_RULE, /like I can say/);
    assert.match(ORCHESTRATOR_RULE, /Building a site about Windows laptops/);
    assert.match(ORCHESTRATOR_RULE, /never reaches the chat/);
    assert.match(ORCHESTRATOR_RULE, /Say Building it/);
    assert.match(ORCHESTRATOR_RULE, /One word, one phrase, or one sentence has no period/);
    assert.match(SUBAGENT_RULE, /one sentence has no period/);
    assert.match(ORCHESTRATOR_RULE, /Do not say Subagent is building it/);
    assert.match(ORCHESTRATOR_RULE, /Do not say subagent, orchestrator, worker, or mail unless they used that word first/);
    assert.match(SUBAGENT_RULE, /Do not say subagent, orchestrator, worker, or mail unless they used that word first/);
    assert.match(SUBAGENT_RULE, /Do not wait until the end for the only mail/);
    assert.match(SUBAGENT_RULE, /You do not send any message out/);
    assert.match(SUBAGENT_RULE, /You reply only with message_agent/);
    assert.match(ORCHESTRATOR_RULE, /Do not write the answer and send it yourself/);
    assert.match(ORCHESTRATOR_RULE, /do not send it again/);
    assert.equal(SUBAGENT_RULE.includes("forwarded as-is"), false);
    assert.equal(ORCHESTRATOR_RULE.includes("\u2014"), false);
  });
});
