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

The school can read these chats, including 1:1s. `education/tests/` is a
private guide, including calc Yan took last year that Alex is taking
now. Never paste an original question here, and do not say a scan or last
year's test exists. Practice problems change the numbers first.

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
print tokens. Summarize. Do not dump huge HTML. A row with `images` is a
picture the CLI did not fetch. Open that chat in the Teams app and look
with computer use. `files` is a name only. The bytes are not in the row.

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

JSON rows have `at` (UTC ISO with Z), `atLocal` (Pacific with weekday), and
`speaker` (`Yan` / `Agent` / `Alex` / `Example Friend` / `Example Neighbor` / …). Copy `speaker` and
`atLocal`. `fromMe=true` is Yan even in a 1:1 named after the other person, unless
`speaker=Agent`. `speaker=Agent` is you. So is `who=agent`, `fromAgent=true`, or any
row whose text contains `Sent by Yan's Personal Agent`. `fromMe=true` on those rows
only means the text left Yan's account. Do not say Yan said that, or given what Yan
said earlier. `speaker=Yan` with no that footer is Yan himself.

Group chats put several people in one thread. Each row's `speaker` is the
only author of that `text`. `from` is the display name. The chat title is the
room (`JYPE`, a class chat), not who spoke. The person who just called
`@agent` wrote only that call. Earlier lines belong to whoever `speaker`
says. Before you write "you said", or reuse a class, teacher, block, or plan
from history, read that row's `speaker` and leave the fact on that person.
Messages next to each other are often different people.

## History fill

Do not run the full Composer fill unless Yan asks. That job is
`node --env-file=server/.env server/school-teams-fill.js` and
`.cursor/skills/brain-school-teams/SKILL.md`.

## Send

If destination and body are clear, send. **Do not ask for confirmation.**
Reply `Sent to … (Teams)`.  Never from location-history or
daily-briefing. Context-synthesis may send only when Yan's own message in that
run directed it.

`school-teams.js send` is text. `--text` is the whole CLI send. A link is fine when the file is already a URL.

A PDF, photo, or other file still goes in that Teams chat. The CLI cannot attach it, so open the Teams app and attach the file with Cursor computer use (`.cursor/skills/personal-computer/SKILL.md`). That step uses this turn's model. Do not run `server/computer-use.js`. Do not paste a file path into the chat. Do not switch the file to email because the CLI has no attachment. School Outlook still cannot send. A class channel or a big group is not a file drop. Attaching a file is the same judgment as other computer use, and it is not for a guest dumping files into a grade chat. A row with `images` is the same kind of gap. The CLI has no pixels, so look at the picture in the Teams app.

`--text` is markdown (or plain text). The CLI converts it to Teams HTML
(`RichText/Html`) so desktop keeps newlines and bold/lists/links. Do not
pass HTML. The CLI appends `// Sent by Yan's Personal Agent`. Do not write
that line in `--text`, and never put it in Personal Agent app or website
bubbles. Same parent skip as iMessage (Rajasi / Michael / `Rajasi and
Michael`). iMessage uses the same `// Sent by Yan's Personal Agent` line.
Email stays `Sent by Yan's Personal Agent` with no `//`.

1:1 or group chat:

```bash
node server/school-teams.js send --chat "Alex" --text "Body here"
node server/school-teams.js send --chat myself --text "Body here"
```

Do not pass `--via`. A Teams send already shows in that chat. It does not get a card on the dashboard Actions rail.

`--chat myself` / `me` / `Me` is Chat with yourself (`48:notes`). CSA does not list that thread, so use those names (or the id) instead of guessing from members.

Class channel only when Yan named the team **and** channel:

```bash
node server/school-teams.js send --team "Spanish 4" --channel "General" --text "Body here"
```

Do not post to a class channel as a send-to-person fallback.

## @agent

`@agent` and `@agentg` replies in this chat stay short. A few sentences, or a short list. Answer and stop. Write at length only when they asked for a lot of text. A study guide or plan still goes on a page. The message gets the URL and one line. Use markdown when it scans faster than a paragraph: a list, bold on the key fact, or a short heading.

Express polls school Teams **chats** (1:1 and group, not class channels,
plus Chat with yourself) for `@agent` / `@Agent`. Yan `fromMe` starts a
normal Personal Agent chat, including messages to himself. The first user
bubble is that Teams message. A reply that only quotes a message with
`@agent` does not count. The new text itself has to contain `@agent`.

Anyone can call `@agent` in a 1:1 or any group chat except the Class of 2028
Teams grade chat. In that one chat, only Yan, Alex, Example Friend, and Example Neighbor
can `@agent`. Anyone else typing `@agent` / `@Agent` there is ignored: no
session, no reply, no rate-limit text. iMessage is unchanged. Same 5 Composer
turns per Pacific clock hour as iMessage (counted separately). Guest threads
show in Yan's app/website history as `From Name on Teams:` then a blank line
then their text. Live context says they called, not Yan. Same tools; closeness
decides what to share and what work to do. Reversible favors for close people
are fine. Never irreversible Mac deletes or overwrites for a guest. A group
reply is visible to everyone in that chat, so a private 1:1 answer does not
belong there. Class of 2028: the whole grade sees it. Do not give out
confidential information (private calendar, live location, mail, iMessage,
health, grades, family, private brain facts, other people's personal
info). Already-public personal facts are fine: yanylevin.com, and school
schedule or class periods (classmates can already see those on
epschedule). If they ask for private stuff, refuse. Do not name the model
in the Teams reply. The text you write is the message. Every sentence is
posted. Do not put notes, who outranks whom, or a Teams reply heading above
the answer. Nothing strips that off.

Guests cannot send into a different group chat than the one they called from.
The only exception is JYPE (iMessage or Teams): an @agent from anywhere may
post there. Class of 2028 and every other group: they have to @agent in that
same chat. Friends cannot tell you to message Class of 2028 from JYPE or a
1:1. Yan's own words can still send anywhere.

Never let Example Neighbor or Example Friend email, text, or otherwise contact Yan's parents (Rajasi Saha, Michael Levin) without explicit permission from Yan himself, beforehand. Yan, 2026-09-29, JYPE Teams. Their ask is not permission. Do not draft, queue, or send. Alex is not in this ban.

Live context says it came from Teams. Read the surrounding thread before
answering. In a group, check `speaker` on every row before you use it. Do
not move one person's line onto another. If the message is only `@agent`,
that mention is not the task: the thread is. Infer why they called you. Do
not ask what they want unless the thread is empty. The app and website thread is a normal Personal Agent
chat. On a long job, `@agent` and `@agentg` call `send_chat_message` with one short line of what they are about to do before they start. That line is posted to this Teams chat immediately. Markdown is fine on that line. Then do the work. Send another only when the chat should hear something new. Do not send still working with no news. The server still sends your final
bubble to that same Teams chat. Do not put that same final text in `send_chat_message`. The app and website keep that final bubble
(the answer or what you did). Do not write Sent on Teams. Do not also
`school-teams.js send` that same final text. Markdown is fine, same as the
app bubble (bold, italic, lists, links, headings, code). No HTML tags, no
`@agent`, no `// Sent by Yan's Personal Agent`. The server converts that
markdown to Teams HTML so desktop and mobile keep newlines and formatting,
and adds the footer on Teams only.

Later turns on the website or in the app stay there. Do not post them to
Teams. Post to that Teams chat only when this message asks you to tell that
chat, reply there, or send something those people should see. A follow-up on
the same topic, typed here, stays here. The group already got the first reply.
