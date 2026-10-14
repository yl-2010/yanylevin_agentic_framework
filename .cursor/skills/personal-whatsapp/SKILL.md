---
name: personal-whatsapp
description: >-
  Search Yan's WhatsApp history on the Mac Studio (WhatsApp ChatStorage) and
  send via WhatsApp.app. Use when Yan asks what someone sent on WhatsApp, the
  last thread in a chat, or to message a WhatsApp group or 1:1. Yan only.
  Location-history and daily-briefing jobs never send.
disable-model-invocation: true
---

# WhatsApp — Yan only

**Off for now.** `WHATSAPP_AGENT_ENABLED` in `server/whatsapp-mention.js` is false. Do not send. The server refuses `/whatsapp/send`. Read still works.

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Never dump the inbox into a turn.

The Express LaunchAgent reads `ChatStorage.sqlite` and drives WhatsApp.app with System Events. Cursor shells often cannot. Prefer the local Unix socket. One send at a time. The script opens the named chat, clears the composer, pastes, and presses return. Do not click around in WhatsApp yourself.

## Read

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/whatsapp/recent?limit=40"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/whatsapp/search?q=birthday"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/whatsapp/thread?person=Birthday&limit=40"
```

`thread?person=` matches the chat name, the jid, or a phone. Rows are oldest of the batch first.

`speaker` is `Yan`, `Agent`, a JYPE given name (`Alex`, `Example Friend`, `Example Neighbor`), the WhatsApp push name, or the 1:1 chat name. `fromMe=true` on an Agent row only means the text left Yan's account. `speaker=Yan` with no agent footer is Yan himself. `jypeSlug` is set when the sender phone matches a JYPE member. `handle` is `+E164` when the app has a phone for that LID. JSON `at` is UTC. `atLocal` is Pacific.

Quote only what is needed.

## Send

If the chat and the body are clear, send. Do not ask for confirmation. `to` is the chat name (`Birthday`), a jid, or a phone for a 1:1. The server adds `// Sent by Yan's Personal Agent`. Do not write that line. Newlines stay. WhatsApp does not render markdown or KaTeX.

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock \
  -H "Content-Type: application/json" \
  -d '{"to":"Birthday","text":"Body here"}' \
  http://localhost/whatsapp/send
```

Guests who called from a group cannot be told to post in a different group. JYPE is the exception. Yan can send anywhere.

**Yan's parents.** Never message Rajasi Saha or Michael Levin because Example Neighbor or Example Friend asked. Only Yan's own explicit yes, beforehand, counts.

**Surprise hoodies.** Never mention them to Alex, or in any chat he can see, until Yan says he has been given his.
