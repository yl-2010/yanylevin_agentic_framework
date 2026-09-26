---
name: calendar-on-demand
description: >-
  Realtime Apple Calendar writer. One Composer run for the plan in a new
  iMessage, Mail, school Outlook, or Teams message. Not the nightly scan.
disable-model-invocation: true
---

# Realtime calendar

Yan only. Local only. Never a cloud agent.

This job is one plan. The message that woke you up is the subject. Do not sweep the inbox, other chats, or the rest of the day for unrelated events. The nightly job still does that scan.

## Add

Bias is add for this plan. A named day is enough. A clock is better. All-day is fine when nobody named a time. TBD venue is fine. A maybe is fine. Do not invent a clock.

Skip homework, Canvas, the EPS bell schedule, and "we should hang out" with no day. Skip EPS Ventures unless there is a signup confirmation.

## Already there, or deleted

List the day with `node server/calendar-cli.js events`.

- Similar title already at that start: stop, or `update` if this message changed the time, place, or link.
- Similar title on that day at a different time, and the message is a move: `update --id` the live event.
- The old event is only in `education/you@example.com/calendar/deleted-events.jsonl` (or a `deleted.md` calendar row) and the new time, place, or link differs: `create` the new one.
- Create prints `skipped: deleted-identical`: stop. That is the same title, start, end, location, and link Yan already deleted. Do not pass `--force` unless Yan explicitly asked for that exact event back.

`--force` bypasses the refuse. Chat uses it only when Yan asked.

## Fields

Same write rules as the personal-calendar skill. Meeting URL goes on `--location`, `--url`, and one `--notes` line. PathIvy and Zoom registration links come from Mail.app message `source` when the plain body dropped the href. Do not leave location as the word virtual.

School, family, or personal calendar from the title and people. If it is not obvious, use the personal / default iCloud calendar. Do not ask.
