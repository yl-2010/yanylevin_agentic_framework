import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isStubChatTitle,
  TITLE_MODEL,
  TITLE_MAX_TOKENS,
  titleFromAgentReply,
  titleSeedFromUserMessage,
  TITLE_PROMPT,
} from "./chat-title.js";
import { fallbackChatTitle } from "./education-chat-history.js";

describe("titleFromAgentReply", () => {
  it("keeps a short title", () => {
    assert.equal(titleFromAgentReply("Cafe hunt near Juanita"), "Cafe hunt near Juanita");
  });

  it("strips quotes and trailing punctuation", () => {
    assert.equal(titleFromAgentReply('"Friday calc homework."'), "Friday calc homework");
  });

  it("drops a cutoff harmony channel with no title", () => {
    assert.equal(titleFromAgentReply("<|channel|>final"), "");
    assert.equal(titleFromAgentReply("<|channel|>"), "");
  });

  it("keeps the final channel when the title is after the marker", () => {
    assert.equal(
      titleFromAgentReply("<|channel|>final<|message|>South Asian quiz"),
      "South Asian quiz"
    );
  });

  it("drops a Teams wrapper echo", () => {
    assert.equal(titleFromAgentReply("(Teams): what's southasianesh"), "");
  });

  it("leaves enough tokens for the reasoning channel", () => {
    assert.ok(TITLE_MAX_TOKENS >= 128);
  });

  it("uses keyword-style instructions", () => {
    assert.match(TITLE_PROMPT, /Keyword-style/);
    assert.match(TITLE_PROMPT, /24-36 characters/);
    assert.match(TITLE_PROMPT, /@agent/);
    assert.doesNotMatch(TITLE_PROMPT, /3 to 6 words/);
    assert.match(TITLE_PROMPT, /Do not prefix/);
    assert.doesNotMatch(TITLE_PROMPT, /Keep the person's name/);
    assert.equal(TITLE_MODEL, "openai/gpt-oss-20b");
  });
});

describe("titleSeedFromUserMessage", () => {
  it("strips the Teams guest wrapper and @agent", () => {
    assert.equal(
      titleSeedFromUserMessage(
        "From Alex on Teams:\n\n@agent can you do my history hw"
      ),
      "can you do my history hw"
    );
  });

  it("strips the iMessage guest wrapper", () => {
    assert.equal(
      titleSeedFromUserMessage(
        "From Example Friend on iMessage:\n\n@agent send a photo"
      ),
      "send a photo"
    );
  });

  it("strips a leading @agent on Yan fromMe texts", () => {
    assert.equal(titleSeedFromUserMessage("@agent add the calc HW"), "add the calc HW");
  });

  it("keeps a normal UI first message", () => {
    assert.equal(titleSeedFromUserMessage("what can i eat nearby"), "what can i eat nearby");
  });

  it("titles the task under a scheduled bubble, not the date line", () => {
    assert.equal(
      titleSeedFromUserMessage(
        "Agent scheduled for Tue, Oct 13, 2026, 9:35 AM PT:\n\nSend the Spanish MA link in this Teams chat."
      ),
      "Send the Spanish MA link in this Teams chat."
    );
  });
});

describe("isStubChatTitle", () => {
  const teams = "From Alex on Teams:\n\n@agent can you do my history hw";

  it("flags copied From Name on Teams titles", () => {
    assert.equal(
      isStubChatTitle("From Alex on Teams: @agent can you", teams),
      true
    );
  });

  it("flags a truncated first-message fallback", () => {
    const collapsed = teams.replace(/\s+/g, " ").trim();
    assert.equal(isStubChatTitle(fallbackChatTitle(collapsed), teams), true);
  });

  it("keeps a real keyword title", () => {
    assert.equal(isStubChatTitle("Alex history HW", teams), false);
  });

  it("flags a cleaned guest fallback", () => {
    assert.equal(
      isStubChatTitle("Alex (Teams): can you do my history", teams),
      true
    );
  });

  it("flags harmony leftovers and platform echoes", () => {
    assert.equal(isStubChatTitle("<|channel|>final", "hello"), true);
    assert.equal(isStubChatTitle("Alex: <|channel|>", "hello"), true);
    assert.equal(
      isStubChatTitle("Batu: (Teams): what's southasianesh", teams),
      true
    );
  });
});
