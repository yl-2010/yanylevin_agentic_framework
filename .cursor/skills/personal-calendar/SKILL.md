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
node server/calendar-cli.js update --id "<eventIdentifier>" --title "Dentist (moved)"
node server/calendar-cli.js delete --id "<eventIdentifier>"
```

Before `delete`, append a row to `education/you@example.com/deleted.md` (create the file from the education-dashboard header if it is missing):

`- deleted YYYY-MM-DD HH:MM | calendar | Title | on YYYY-MM-DD HH:MM | Calendar Name | was <eventIdentifier>`

Use the event's local start as `on`. Nightly actions must skip recreating an event that looks like a deleted row (judgement, not exact clocks). If Yan asks to add it back, create it and remove the matching row.

First Studio run should prompt for Calendar access (`yl-calendar.app`). If JSON `ok` is false and the error mentions denied access, tell Yan to grant Calendar to **yl-calendar** (System Settings > Privacy & Security > Calendars). Cursor Full Disk Access does not cover Calendar.

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

## Schoolwork vs Calendar

- Homework, CW/HW/QA/MA, class due dates → education todos/dates (education-dashboard skill)
- Appointments, family, travel, timed events → Apple Calendar
- If Yan says to put homework on the calendar, write the Calendar event **and** keep the education todo

Do not duplicate the EPS bell schedule (`schedule.json`) as Calendar events unless asked.

Before creating, list overlapping events that day. Skip if a **similar title** already sits on that local day, not only a byte-identical string. Similar means the same event: lowercase, strip year tokens (`2026`, `2026-27`), treat advisor/advisory as one word, singular/plural on the last word. Also skip if it looks like a `deleted.md` calendar row. Nightly actions uses this same rule.

Express live context already lists today + tomorrow. Open this skill when you need other days, or to create/change events.
