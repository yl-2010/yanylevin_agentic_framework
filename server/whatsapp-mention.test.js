import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWhatsAppOriginBlock,
  shouldTriggerWhatsAppAgent,
  whatsAppMessageKey,
} from "./whatsapp-mention.js";

describe("whatsapp mentions", () => {
  it("triggers on @agent and @agentg and skips the footer", () => {
    assert.equal(
      shouldTriggerWhatsAppAgent({
        text: "hey @agent",
        chat: "Birthday",
        chatJid: "123@g.us",
      }),
      true
    );
    assert.equal(
      shouldTriggerWhatsAppAgent({
        text: "@agentg what is this",
        chat: "Birthday",
        chatJid: "123@g.us",
      }),
      true
    );
    assert.equal(
      shouldTriggerWhatsAppAgent({
        text: "hey @agent\n\n// Sent by Yan's Personal Agent",
        chat: "Birthday",
        chatJid: "123@g.us",
      }),
      false
    );
    assert.equal(
      shouldTriggerWhatsAppAgent({
        text: "@agent",
        messageType: 14,
        chat: "Birthday",
        chatJid: "123@g.us",
      }),
      false
    );
    assert.equal(
      shouldTriggerWhatsAppAgent({
        text: "@agent",
        chatJid: "status@broadcast",
      }),
      false
    );
  });

  it("keys a row by stanza id", () => {
    assert.equal(whatsAppMessageKey({ guid: "abc" }), "wa:abc");
    assert.equal(whatsAppMessageKey({ id: 12 }), "waid:12");
  });

  it("names Yan, a JYPE member, and a guest", () => {
    const yan = formatWhatsAppOriginBlock(
      {
        fromMe: true,
        chat: "Birthday",
        chatJid: "123@g.us",
        text: "@agent",
      },
      { deliverFinal: true }
    );
    assert.match(yan, /Called by Yan on WhatsApp/);

    const jype = formatWhatsAppOriginBlock(
      {
        fromMe: false,
        chat: "Birthday",
        chatJid: "123@g.us",
        handle: "+15555550100",
        senderName: "Alex",
        text: "hey @agent",
      },
      {
        deliverFinal: true,
        guestCaller: {
          displayName: "Alex",
          slug: "alex-rivera",
          jypeMember: true,
          audience: { kind: "group", threadLabel: "Birthday" },
        },
      }
    );
    assert.match(jype, /Called by Alex on WhatsApp, not Yan/);
    assert.match(jype, /alex-rivera/);
    assert.match(jype, /JYPE member/);

    const other = formatWhatsAppOriginBlock(
      {
        fromMe: false,
        chat: "Birthday",
        chatJid: "123@g.us",
        handle: "+14255550100",
        senderName: "Sreekar",
        text: "@agent",
      },
      {
        deliverFinal: true,
        guestCaller: {
          displayName: "Sreekar",
          audience: { kind: "group", threadLabel: "Birthday" },
        },
      }
    );
    assert.match(other, /Called by Sreekar on WhatsApp, not Yan/);
    assert.match(other, /not a JYPE member/);
  });
});
