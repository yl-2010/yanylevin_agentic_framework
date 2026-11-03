---
name: calendar-on-demand
description: >-
  Realtime Apple Calendar and education-todo writer. One Composer run when
  Jev flags a new iMessage, Mail, school Outlook, or Teams message as a
  calendar event or a specific task the message assigns to Yan. Composer
  picks one. A text from either parent is calendar or nothing, and that run
  does not write a todo. Not the nightly scan.
disable-model-invocation: true
---

# Realtime calendar and todo

Yan only. Local only. Never a cloud agent.

This job is one item. The message that woke you up is the subject. Do not sweep the inbox, other chats, or the rest of the day for unrelated events. The nightly job still does that scan.

## Jev

Jev only asked whether this message might be a calendar event or a specific task the message assigns to Yan. Jev is that classifier, not a person in the chat and not a guest. Never put Jev in the title, notes, guest list, or todo name. Name a calendar event after the people in the thread.

A text from Rajasi Saha or Michael Levin is different. Jev only chooses calendar or nothing. It is not offered a todo.

You still decide. Create nothing when it is not a calendar event and not a specific task the message assigns to him.

Pick one. A calendar event if he is showing up. A todo only when the message assigns him a specific task and he is not attending an event. Do not create both unless the message has two separate things. RSVP, see you there, or confirming the plan is the calendar event, not a second todo. A vague follow-up is not that second thing.

## Calendar

Look up the weekday on the list in the prompt. This Saturday is the first Saturday. Next Saturday is the second. Do not count days yourself.

Add an event he is actually showing up for. A hangout, meal, appointment, reservation, flight, or meeting with a day. TBD venue is fine when the plan is real. Look up the real start and end before you create. The personal-calendar skill has the rule. Pass `--all-day` only when the event has no clock. If you cannot find the time, create nothing.

Skip these even when they name a day:

- College spam. Recruitment and marketing from colleges, Scoir blasts, apply-now mail, and info sessions he did not register for. A date in the email is not an event.
- The weekly EPS college-visit list. School sends one about once a week. Do not add each visit. Only a visit Yan said he signed up for, or a form receipt for that visit. The announcement is not a signup.
- Education todos, homework, Canvas, due dates, and other dashboard items. Those stay on the education dashboard. The calendar is events.
- The EPS bell schedule, and "we should hang out" with no day.
- EPS Ventures unless there is a signup confirmation.
- A task he has to do, with no event he is attending. That is a todo, below, unless the text is from a parent.

## Parent texts

A text from Rajasi Saha or Michael Levin is a calendar event or nothing. If the prompt says the text is from a parent, do not create a todo, do not update a todo, and do not write `todo.json`. A chore, a reply, or a form in that text is nothing. Calendar still applies when Yan is showing up.

## Todo

A todo only when the message assigns Yan a specific task, and the text is not from a parent. The calendar rules above stay as they are.

He has to be the one who does it. The task has to be in the message, named, and his. If you cannot point at the sentence that tells him what to do, create nothing.

Messages. Someone gives him the task. "Send me the photo tonight", "fill this out", "email the office the form". A chat that only mentions an idea, a maybe, or something he could do is not a task.

Email. The mail gives him a direct task. Fill out a form. Reply to a direct question asked of him. Send an email about something the mail says he has to email about. Send a named file someone told him to send.

Skip these, even when they sound useful:

- FYI, thanks, a newsletter, a passcode, or mail that only informs him.
- A suggestion, a nudge, "let me know if you want", "you should look at", or "we should".
- A question that is not asked of him.
- A task for someone else.
- Homework, Canvas, and due dates that already live on the education dashboard. Canvas sync already makes those todos.
- College spam, and the weekly EPS college-visit list, unless he signed up.

Do not invent a follow-up. Someone writing to him is not "reply" unless they asked him a question or told him to reply. "This might matter" is not a todo.

Set `dueDate` as `YYYY-MM-DD` and `dueTime` as `HH:MM` from the message. Use the weekday list. Do not leave either field blank. Do not use midnight.

- A deadline clock in the message wins.
- No clock, but a part of the day. Morning is `08:30`. After school, or "by Friday" with no clock, is `15:30` that day. Tonight is `20:00`.
- ASAP or today, with no clock. Today at `15:30` when the message is still in the school day. Otherwise tomorrow at `08:30`.
- Before a named event. Due before that start.

Write a user-level todo at `/Users/you/Library/CloudStorage/OneDrive-Personal/Projects/.education/todos/<slug>/todo.json`.

College application tasks go in `/Users/you/Library/CloudStorage/OneDrive-Personal/Projects/College Prep/todos/<slug>/todo.json`. That is PSAT, counselor, teacher recommendations, and a form that is for the application. A permission slip or a reply is user-level.

Fields:

- `name`. Plain text. The task, not the subject line pasted whole.
- `description`. Short markdown. Who asked, what he has to do, and the link if the message has one.
- `dueDate`, `dueTime`, `done` false, `createdAt` now as ISO, `showInDates` false.
- No CW, HW, QA, or MA tag. No `date.json`. Do not also add that task to Apple Calendar.

`<slug>` is a lowercase kebab of the name, unique in that folder. If an open todo in the prompt has a similar name, update that folder, including a new deadline. Similar means lowercase, years stripped, singular and plural treated as the same. Do not mint ` (2)`.

If the task looks like a deleted todo row, skip it. Judgement, not the exact clock. Do not write `update` on a path that is already gone.

## Already there, or deleted

List the day with `node server/calendar-cli.js events`.

- Similar title already at that start: stop, or `update` if this message changed the time, place, or link.
- Similar title on that day at a different time, and the message is a move: `update --id` the live event.
- The old event is only in `education/you@example.com/calendar/deleted-events.jsonl` (or a `deleted.md` calendar row) and the new time, place, or link differs: `create` the new one.
- Create prints `skipped: deleted-identical`: stop. That is the same title, start, end, location, and link Yan already deleted. Do not pass `--force` unless Yan explicitly asked for that exact event back.

`--force` bypasses the refuse. Chat uses it only when Yan asked.

## Action log

On calendar `create`, `update`, and `delete`, add `--via calendar-on-demand`. List and get stay without it. The flag tells the CLI this is a Jev job, so a title that names Jev is refused. These writes do not get a card on the dashboard Actions rail. Yan already sees the change on the calendar or on the education todo list.

## Calendar fields

Same write rules as the personal-calendar skill. Meeting URL goes on `--location`, `--url`, and one `--notes` line. PathIvy and Zoom registration links come from Mail.app message `source` when the plain body dropped the href. Do not leave location as the word virtual.

Personal, School/Work, or Family from the personal-calendar skill. iCloud unless this message is inviting someone else, then Exchange, with `--attendees`. Unclear is iCloud Personal. Do not ask. Never create on Google. Do not move an existing event to another calendar. That resends invites, including a move on the same account. Pick the calendar only when you create.
