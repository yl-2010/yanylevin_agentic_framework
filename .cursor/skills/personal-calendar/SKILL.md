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
node server/calendar-cli.js create --title "Dentist" --start 2026-08-20T16:00:00Z --end 2026-08-20T16:45:00Z --calendar "Home"
node server/calendar-cli.js create --title "PathIvy: PSAT 101" --start 2026-09-06T23:00:00Z --end 2026-09-07T00:00:00Z --calendar "Home" --location "https://us06web.zoom.us/webinar/register/<id-from-mail>" --url "https://us06web.zoom.us/webinar/register/<id-from-mail>" --notes "Zoom registration: https://us06web.zoom.us/webinar/register/<id-from-mail>"
node server/calendar-cli.js update --id "<eventIdentifier>" --title "Dentist (moved)"
node server/calendar-cli.js delete --id "<eventIdentifier>"
```

`delete` records the event itself. It appends `education/you@example.com/calendar/deleted-events.jsonl` and a row in `education/you@example.com/deleted.md`:

`- deleted YYYY-MM-DD HH:MM | calendar | Title | on YYYY-MM-DD HH:MM | Calendar Name | was <eventIdentifier>`

Use the event's local start as `on`. Do not append that row again yourself. A later create of the same title, start, end, location, and link is refused. A new time, place, or link is allowed. If Yan explicitly asks for that exact event back, create it with `--force` and remove the matching `deleted.md` row plus the jsonl line.

First Studio run should prompt for Calendar access (`yl-calendar.app`). If JSON `ok` is false and the error mentions denied access, use Calendar.app osascript for that write (location, url, description), then tell Yan to grant Calendar to **yl-calendar** (System Settings > Privacy & Security > Calendars) so the CLI works next time. Cursor Full Disk Access does not cover Calendar.

Output is JSON. Use `id` from create/list when updating or deleting. `--calendar` matches calendar title (or `--calendar-id`).

## Which calendar

Infer from the title, people, and time:

- School / EPS / class / advisory / orientation → a school calendar if one exists
- Family names / household → a family/shared calendar if one exists
- Otherwise the personal / default iCloud calendar

If it is not obvious, **ask** before creating. Nightly actions is the
exception: it creates any plan with a date without asking (tentative and TBD
venue included), and uses the personal / default iCloud calendar when the
target is unclear. Do not invent a day that nobody named.

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
- If Yan says to put homework on the calendar, write the Calendar event **and** keep the education todo

Do not duplicate the EPS bell schedule (`schedule.json`) as Calendar events unless asked.

Before creating, list overlapping events that day. The CLI also refuses the create when a similar title is already at that start, or when `calendar/deleted-events.jsonl` (and older `deleted.md` calendar rows) describe the same title, start, end, location, and link. Similar means the same event: lowercase, strip year tokens (`2026`, `2026-27`), treat advisor/advisory as one word, singular/plural on the last word. If the JSON says `skipped: deleted-identical` or `skipped: already-on-calendar`, stop. Do not retry with `--force` unless Yan explicitly asked for that exact event back. A different time, place, or link is a new event: update the live one if it is still there, or create it if the old one was only a tombstone. Nightly actions uses this same rule, and leaves an event the realtime agent already filed. Skip EPS Ventures unless there is a signup confirmation (form receipt or Yan said he signed up). A Student News or Weekly News announcement is not enough.

Express live context already lists today + tomorrow. Open this skill when you need other days, or to create/change events.
