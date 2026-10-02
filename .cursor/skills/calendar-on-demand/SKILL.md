---
name: calendar-on-demand
description: >-
  Realtime Apple Calendar writer. One Composer run when Jev flags a new
  iMessage, Mail, school Outlook, or Teams message. Composer decides if it
  is calendar-worthy. Not the nightly scan.
disable-model-invocation: true
---

# Realtime calendar

Yan only. Local only. Never a cloud agent.

This job is one plan. The message that woke you up is the subject. Do not sweep the inbox, other chats, or the rest of the day for unrelated events. The nightly job still does that scan.

## Worth adding

Jev only asked whether this message might be a plan. Jev is that classifier, not a person in the chat and not a guest. Never put Jev in the title, notes, or guest list. Name the event after the people in the thread. You still decide if it is calendar-worthy. Create nothing when it is not.

Look up the weekday on the list in the prompt. This Saturday is the first Saturday. Next Saturday is the second. Do not count days yourself.

Add an event he is actually showing up for. A hangout, meal, appointment, reservation, flight, or meeting with a day. TBD venue is fine when the plan is real. Look up the real start and end before you create. The personal-calendar skill has the rule. Pass `--all-day` only when the event has no clock. If you cannot find the time, create nothing.

Skip these even when they name a day:

- College spam. Recruitment and marketing from colleges, Scoir blasts, apply-now mail, and info sessions he did not register for. A date in the email is not an event.
- The weekly EPS college-visit list. School sends one about once a week. Do not add each visit. Only a visit Yan said he signed up for, or a form receipt for that visit. The announcement is not a signup.
- Education todos, homework, Canvas, due dates, and other dashboard items. Those stay on the education dashboard. The calendar is events.
- The EPS bell schedule, and "we should hang out" with no day.
- EPS Ventures unless there is a signup confirmation.

## Already there, or deleted

List the day with `node server/calendar-cli.js events`.

- Similar title already at that start: stop, or `update` if this message changed the time, place, or link.
- Similar title on that day at a different time, and the message is a move: `update --id` the live event.
- The old event is only in `education/you@example.com/calendar/deleted-events.jsonl` (or a `deleted.md` calendar row) and the new time, place, or link differs: `create` the new one.
- Create prints `skipped: deleted-identical`: stop. That is the same title, start, end, location, and link Yan already deleted. Do not pass `--force` unless Yan explicitly asked for that exact event back.

`--force` bypasses the refuse. Chat uses it only when Yan asked.

## Action log

On `create`, `update`, and `delete`, add `--via calendar-on-demand`. List and get stay without it. The dashboard Actions rail uses that flag to tell a Jev job from a chat.

## Fields

Same write rules as the personal-calendar skill. Meeting URL goes on `--location`, `--url`, and one `--notes` line. PathIvy and Zoom registration links come from Mail.app message `source` when the plain body dropped the href. Do not leave location as the word virtual.

Personal, School/Work, or Family from the personal-calendar skill. iCloud unless this message is inviting someone else, then Exchange, with `--attendees`. Unclear is iCloud Personal. Do not ask. Never create on Google. Do not move an existing event to another calendar. That resends invites, including a move on the same account. Pick the calendar only when you create.
