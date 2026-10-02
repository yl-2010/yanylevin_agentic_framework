---
name: personal-calendar
description: >-
  Read and write Yan's Apple Calendar on the Mac Studio via yl-calendar
  (EventKit). Use for appointments, family events, travel, timed holds.
  Yan only — never for Alex.
disable-model-invocation: true
---

# Apple Calendar — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

Apple Calendar is on the **Mac Studio**, not the phone. Web / iOS / Cursor chat all write through this helper so changes are live.

## Binary

From the repo root:

```bash
node server/calendar-cli.js list
node server/calendar-cli.js events --from 2026-08-16T07:00:00Z --to 2026-08-18T06:59:59Z
node server/calendar-cli.js create --title "Dentist" --start 2026-08-20T16:00:00Z --end 2026-08-20T16:45:00Z --calendar "iCloud Personal" --source iCloud
node server/calendar-cli.js create --title "PathIvy: PSAT 101" --start 2026-09-06T23:00:00Z --end 2026-09-07T00:00:00Z --calendar "iCloud School/Work" --source iCloud --location "https://us06web.zoom.us/webinar/register/<id-from-mail>" --url "https://us06web.zoom.us/webinar/register/<id-from-mail>" --notes "Zoom registration: https://us06web.zoom.us/webinar/register/<id-from-mail>"
node server/calendar-cli.js create --title "Dinner with Alex" --start 2026-08-20T02:00:00Z --end 2026-08-20T04:00:00Z --calendar "Calendar" --source Exchange --attendees "you@example.com"
node server/calendar-cli.js create --title "No school" --start 2026-09-07T07:00:00Z --end 2026-09-08T07:00:00Z --all-day --calendar "iCloud School/Work" --source iCloud
node server/calendar-cli.js update --id "<eventIdentifier>" --title "Dentist (moved)"
node server/calendar-cli.js delete --id "<eventIdentifier>"
```

`delete` records the event itself. It appends `education/you@example.com/calendar/deleted-events.jsonl` and a row in `education/you@example.com/deleted.md`:

`- deleted YYYY-MM-DD HH:MM | calendar | Title | on YYYY-MM-DD HH:MM | Calendar Name | was <eventIdentifier>`

Use the event's local start as `on`. Do not append that row again yourself. A later create of the same title, start, end, location, and link is refused. A new time, place, or link is allowed. If Yan explicitly asks for that exact event back, create it with `--force` and remove the matching `deleted.md` row plus the jsonl line.

First Studio run should prompt for Calendar access (`yl-calendar.app`). If JSON `ok` is false and the error mentions denied access, use Calendar.app osascript for that write (location, url, description), then tell Yan to grant Calendar to **yl-calendar** (System Settings > Privacy & Security > Calendars) so the CLI works next time. Cursor Full Disk Access does not cover Calendar.

Output is JSON. Use `id` from create/list when updating or deleting. `--calendar` matches calendar title (or `--calendar-id`).

## Start and end

Pass a real `--start` and a real `--end`. A game, practice, dinner, gym session, appointment, flight, show, or meeting happens at a clock. If the message names the time, use it. If it does not, look it up before you create. Check the thread, the mail, the invite, the official page (team schedule, venue, school, airline), and any earlier copy of the same event. The end is when it finishes. Use the published length, or the length of the last copy of that event. A one-hour default is only for a short appointment whose length was never published.

`--all-day` is for a date that has no clock. No school, a birthday, a holiday, a delivery window that is a range of dates. Pass `--all-day`, with `--start` at local midnight and `--end` at the next local midnight, or the morning after the last day. That flag is what Calendar shows as an all-day event.

A start at midnight and an end a day later, without `--all-day`, is a timed block that fills the day. The CLI refuses a timed event that lasts 20 hours or more. When you correct a wrong all-day event to a real window, pass `--all-day 0` with the new start and end.

If you still cannot find a start and end after looking, do not create the event. Say what you could not find.

## Which calendar

Each of iCloud, Exchange, and Google has Personal, School/Work, and Family. New events go on iCloud unless Yan is inviting someone else, in which case they go on Exchange. Never create on Google.

Category, in this order:

- Family if Rajasi, Michael, Adi, or Sunny is part of it. Nicknames count: mama, mommy, mom, papa, dad, sb, Sunny Boy. Family wins even when the topic is also school, so a PathIvy parent consult with Rajasi is Family.
- School/Work for school, EPS, work, college prep, PathIvy, ExampleCo, debate, and college visits. A hangout with friends is not school.
- Personal otherwise. Friends such as JYPE, Alex, Example Friend, and Example Neighbor are Personal. Unclear is Personal.

Pass both flags. The calendars are named with the account so three Family calendars are not the same title. Exchange Personal is still titled Calendar, because that is the Outlook default invites land on.

- Solo personal: `--calendar "iCloud Personal" --source iCloud`
- Solo school or work: `--calendar "iCloud School/Work" --source iCloud`
- Solo family: `--calendar "iCloud Family" --source iCloud`
- Inviting someone, personal: `--calendar Calendar --source Exchange --attendees email`
- Inviting someone, school or work: `--calendar "Outlook School/Work" --source Exchange --attendees email`
- Inviting someone, family: `--calendar "Outlook Family" --source Exchange --attendees email`

Use the address on their people card. `--attendees` is a comma-separated list. Do not ask which calendar. Nightly actions uses the same rules and does not ask. College spam, the weekly EPS college-visit list, and dashboard todos stay off. Do not invent a day that nobody named.

Do not move an existing event to another calendar. That resends invites, including a move on the same account. Pick Personal, School/Work, or Family when you create the event. New events go on iCloud unless you are inviting someone else, then Exchange.

When adding a named person as a guest, use the address on their people card (or Contacts). Do not keep a second address table here.

## Meeting links (required)

Whenever the source has a join, register, or booking URL, put that URL on the event. Mail, chat, an invite, Zoom, Google Meet, Teams, FaceTime, pathivy.ai booking. Do not leave location as `virtual` or `Zoom` with no URL.

Write the same URL to `--location` (tappable on iPhone), `--url` (EventKit URL field), and `--notes` as one backup line (`Zoom registration: <url>`).

PathIvy webinars always get the Zoom **registration** link from Calla's mail for that date's row, not the word "virtual". Mail.app `content` drops hrefs. Read `source` of the message (personal-mail skill) and pick the `zoom.us/webinar/register/...` URL that sits on that row.

If you cannot get the URL this turn, say so. A linkless virtual event is not done.

If `yl-calendar` returns Calendar access denied, Calendar.app osascript still works: set `location`, `url`, and `description` on that event.

## Schoolwork vs Calendar

- Homework, CW/HW/QA/MA, class due dates → education todos/dates (education-dashboard skill)
- Appointments, family, travel, timed events → Apple Calendar
- If Yan says to put a specific homework item or todo on the calendar, write the Calendar event **and** keep the education todo

Do not duplicate the EPS bell schedule (`schedule.json`) as Calendar events unless asked.

## What stays off

The calendar is events he is showing up for. Appointments, meetings, hangouts, meals, travel, reservations.

Leave these off unless Yan explicitly asked for that item on the calendar:

- College spam. Recruitment and marketing from colleges, Scoir blasts, apply-now mail, and info sessions he did not register for. A date in the email is not an event.
- The weekly EPS college-visit list. School sends one about once a week. Do not add each visit. Only a visit Yan said he signed up for, or a form receipt for that visit. The announcement is not a signup.
- Education todos, homework, Canvas assignments, and other dashboard items. Those stay on the education dashboard.

EPS Ventures stays off unless there is a signup confirmation, a form receipt or Yan said he signed up. A Student News or Weekly News announcement is not enough.

Before creating, list overlapping events that day. The CLI also refuses the create when a similar title is already at that start, or when `calendar/deleted-events.jsonl` (and older `deleted.md` calendar rows) describe the same title, start, end, location, and link. Similar means the same event: lowercase, strip year tokens (`2026`, `2026-27`), treat advisor/advisory as one word, singular/plural on the last word. If the JSON says `skipped: deleted-identical` or `skipped: already-on-calendar`, stop. Do not retry with `--force` unless Yan explicitly asked for that exact event back. A different time, place, or link is a new event: update the live one if it is still there, or create it if the old one was only a tombstone. Nightly actions uses this same rule, and leaves an event the realtime agent already filed. College spam, the weekly EPS college-visit list, and dashboard todos stay off, per What stays off above. EPS Ventures stays off unless there is a signup confirmation.

Express live context already lists today + tomorrow. Open this skill when you need other days, or to create/change events.
