---
name: personal-school-teams
description: >-
  Read and send Yan's EPS Microsoft 365 Teams (owner@school.example) via
  node server/school-teams.js. Nightly context source and on-demand read/send.
  Yan only. 
disable-model-invocation: true
---

# School Teams — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is
Alex, skip this whole skill.

Account: `owner@school.example`. Same Chrome login as school Outlook
(`~/.yanylevin/school-mail/chrome-profile`). No Azure app. No API key.

This is 1:1 and group **chats** plus joined-team **channels**. CSA marks
Chat-tab 1:1s and Chat-tab group chats as hidden; the CLI still lists
them. Do not add the school account to Mail.app. Personal iMessage stays
on `.cursor/skills/personal-imessage/SKILL.md`.

Unnamed **send to a person** uses the waterfall in
`.cursor/skills/personal-agent/SKILL.md` (iMessage, then Teams, then email).
This skill is the Teams step, and for `on Teams` / a named team+channel.

## Commands

From the repo root:

```bash
node server/school-teams.js status
node server/school-teams.js chats --limit 20
node server/school-teams.js teams
node server/school-teams.js channels --team "Spanish 4"
node server/school-teams.js thread --chat "Alex"
node server/school-teams.js thread --team "Spanish 4" --channel "General"
node server/school-teams.js search "homework"
```

Output is JSON. Use `id` / `chatId` from chats when reading a thread. Do not
print tokens. Summarize. Do not dump huge HTML.

If `signedIn` is false or the payload says `not signed in`, Yan has to finish
login on the Mac Studio (visible Chrome, including 2FA):

```bash
node server/school-teams.js login
```

Chrome opens **Teams**, not Graph Explorer. Sign in as
`owner@school.example` if asked. The window closes when chat tokens
are captured (CSA list + IC3 messages). Graph Chat.Read is not used.

Cookies live in `~/.yanylevin/school-mail/`. Teams tokens live in
`~/.yanylevin/school-teams/session.json` (not in git). Never copy those
folders into the repo.

## Search

Prefer `search` or `thread --chat <name>` over paging every chat. Channel
posts: `--team` and `--channel` together.

## History fill

Do not run the full Composer fill unless Yan asks. That job is
`node --env-file=server/.env server/school-teams-fill.js` and
`.cursor/skills/brain-school-teams/SKILL.md`.

## Send

If destination and body are clear, send. **Do not ask for confirmation.**
Reply `Sent to … (Teams)`.  Never from location-history or
daily-briefing. Context-synthesis may send only when Yan's own message in that
run directed it.

The CLI appends `Sent by Yan's Personal Agent`. Do not write that line in
`--text`, and never put it in Personal Agent app or website bubbles. Same
parent skip as iMessage (Rajasi / Michael / `Rajasi and Michael`).

1:1 or group chat:

```bash
node server/school-teams.js send --chat "Alex" --text "Body here"
```

Class channel only when Yan named the team **and** channel:

```bash
node server/school-teams.js send --team "Spanish 4" --channel "General" --text "Body here"
```

Do not post to a class channel as a send-to-person fallback.

## @agent

Express polls school Teams **chats** (1:1 and group, not class channels)
for `@agent` / `@Agent`. Yan `fromMe` starts a normal Personal Agent chat.
The first user bubble is that Teams message.

Anyone can call `@agent` in a 1:1. Groups: only Alex, Example Friend, and
Example Neighbor. Everyone else in a group: ignore. Guest threads show in Yan's
app/website history as `From Name on Teams:` then a blank line then their
text. Live context says they called, not Yan. Same tools; closeness
decides what to share and what work to do. Reversible favors for close
people are fine. Never irreversible Mac deletes or overwrites for a
guest. A group reply is visible to everyone in that chat, so a personal
1:1 answer does not belong there. Do not name the model in the Teams reply.

Live context says it came from Teams. Read the surrounding thread before
answering. If the message is only `@agent`, that mention is not the task:
the thread is. Infer why they called you. Do not ask what they want unless
the thread is empty. `send_chat_message` intermediates stay in the app. The
server sends your final bubble to that same Teams chat, then replaces
the last app/website bubble with a short send confirmation. Do not also
`school-teams.js send` that same final text. Write the final as plain text:
no markdown, no `@agent`, no `Sent by Yan's Personal Agent`. The server adds
that footer on Teams only.

Later turns typed in the app are Yan. They do not auto-post unless you
send via this skill.
