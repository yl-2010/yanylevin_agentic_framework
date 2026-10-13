---
name: future-agents
description: >-
  Schedule a one-time future agent when someone wants a reminder, a message
  after something finishes, or anything that has to wait. Use on Personal
  Agent, JYPE, @agent, @agentg, and Cursor Desktop turns.
---

# Future agents

A future agent is a full Personal Agent or JYPE agent that runs once, later. Same model as a normal Grok 4.7 high turn (Fast off). Same tools, same prompt, same history. It is not a note to yourself and it is not a nightly job.

The thread shows up in chat history as soon as you schedule it. The title starts with `Scheduled:`. It stays in the list. It does not hide after 10 minutes.

## When to schedule

Do this in the same turn whenever the ask cannot be finished now. A hint is enough. You do not need the words "schedule" or "future agent".

Schedule when they say things like:

- remind me
- at the end of the period
- once we're done
- send it later
- after the MA
- tomorrow morning
- when class ends

Do the part you can do now (make the page, look up the time, write the draft). Schedule the part that has to wait (send the link, post the reminder).

Do not say you will remember. If you did not call `schedule_future_agent` or the CLI, nothing will run later.

## How to call it

Inside a Personal Agent or JYPE chat, call `schedule_future_agent`.

- `runAt`: ISO time with a Pacific offset, like `2026-10-13T09:35:00-07:00`.
- `prompt`: the task, in plain words. This is the first user bubble, under the date line.
- `context`: what the future agent cannot re-derive. The live URL, who asked, what you already finished, and that this turn started in JYPE Teams or an iMessage chat.

The tool copies this session's Teams or iMessage chat. You do not pass the chat id. Put the situation in `context` anyway, including the URL and who asked.

The tool returns `runAtLocal`, `sessionId`, and `history` (`jype` or `personal`). Tell them that time in your reply. If `pending` lists another job for the same task, cancel the old one with `cancel_future_agent` instead of making a second thread.

On Cursor Desktop, there is no tool. From the repo root:

```bash
node server/future-agents.js schedule --at "2026-10-13T09:35:00-07:00" --prompt "Send the link in JYPE Teams." --context "URL https://yanylevin.com/example/. Yan asked in JYPE Teams." --workspace jype --email you@example.com --teams-chat "19:5b03f2304dff426d95ebda79495d479a@thread.v2"
node server/future-agents.js list
node server/future-agents.js cancel --session <id>
```

`--workspace` is `jype` or `personal`. `--email` is the signed-in user for this turn. Pass `--teams-chat` or `--imessage-to` when the reply has to leave the app. If the command says the local socket is down, say so. Do not pretend it was scheduled.

A JYPE agent schedules into JYPE chat history. A personal agent schedules into that person's own history. The future agent gets that same prompt and the same write limits.

## What time

Read `.cursor/skills/class-schedule/SKILL.md` when the ask is a period, a bell, or "at the end of class". Open that person's `education/<email>/schedule.json`, including `dayOverrides` for the date. Do not use `education/projects/jype/schedule.json` for bells. That file is trimester bounds only.

When they want something ready at the bell, schedule 5 minutes before the period ends. The run needs that buffer so the message is there when the period ends, not after.

Spanish 4 is period D on the JYPE card. 8:30 only when that person's D block is first that day. Check the date. Tue 2026-10-13 is a `dayOverrides` day, still D 08:30 to 09:40, so five minutes before the end is 09:35 PT.

Say the clock time you picked. Do not say "at the end of the period" back to them with no time.

## What the future agent does

It wakes on its own. The first user bubble is already in the thread:

```
Agent scheduled for Tue, Oct 13, 2026, 9:35 AM PT:

Send the Spanish MA link in this Teams chat.
```

You do not write that bubble. The server does. Your `prompt` is the second paragraph. Your `context` is added to its instructions, not shown as a second bubble.

If you were called from JYPE Teams, the future agent replies in that same Teams chat. Intermediate `send_chat_message` lines post there too. Same for iMessage. A web or iOS schedule stays in the app unless the task says to send somewhere.

It can schedule another future agent if the task needs a later step.

## Celebration sites

Building the site is `.cursor/skills/create-celebration-website/SKILL.md`. Do that now. The link send is the part that waits.

Schedule that send only when the celebration skill can name the end from a todo, a calendar end, or a bell. A vague "when we're done" with no clock time does not get a future agent. Keep the URL out of this reply until they ask or the scheduled send fires. Put the URL in `context`, not in `prompt`, because the prompt is the visible bubble and the thread shows up immediately.

## Example

Yan in JYPE Teams: "@agentg make a site celebrating being done with the Spanish MA but put it at a non-guessable url bc we haven't had the MA yet, then send us the link once we're done with the MA."

1. Make the site now and deploy it, per the celebration skill.
2. Find the next Spanish MA, the period, and the period end. Schedule 5 minutes before that end.
3. `schedule_future_agent`. Prompt: send the celebration link in this chat. Context: the live URL and who asked. The tool copies the Teams chat.
4. Reply now with the time you picked. Do not send the link yet.

When that time hits, the scheduled agent sends the link in JYPE Teams. The thread is already in JYPE history, titled `Scheduled: …`.
