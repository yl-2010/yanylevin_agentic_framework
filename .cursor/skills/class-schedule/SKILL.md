---
name: class-schedule
description: >-
  Weekly class schedule PDF and per-user schedule.json (bells, weekday
  periods, closed dates, day overrides). Use when asking what class is now,
  bells, A-H days, free periods, or when editing the school schedule.
disable-model-invocation: true
---

# Class schedule

Canonical weekly PDF (shared):

```
education/2026-27 Weekly Class Schedule.pdf
```

Per-user JSON (keep aligned with that PDF):

```
education/<email>/schedule.json
```

Example: `education/you@example.com/schedule.json`

That JSON is Yan's (or Alex's) live bell schedule. A classmate's recurring classes live on their brain card as `people/<slug>/schedule.md`, not here. Do not dump Four11 PDFs or schedule screenshots into `education/<email>/`.

Express may inject a **Live context** clock plus in-class-now / next / previous / today's classes. Trust that for “what class am I in?” Do not guess from the clock alone. Classes are in person: say “in a class”, never “class meeting”. Open the PDF / `schedule.json` when editing, verifying, or when Live context does not answer.

## `schedule.json`

- `schoolStart` / `schoolEnd` gate the year
- `trimesters.{fall,winter,spring}.{start,end}` gate class visibility on the server
- `weekdayPeriods` map weekday `1`–`5` → period letters
- `bells` hold default start/end
- `closedDates` skip holidays/PDDs/US reading days
- `dayOverrides` override a date’s class periods via `slots` (A–H special days **and** final-exam days with only 2–3 periods)

## Classes UI (home panels)

Home **Classes** is two day panels, each sorted by **clock start time** (never period letter):

- School day: today + following school day
- Weekend / closed day: next school day + the one after
- **A–H days** (`dayOverrides.*.allPeriods`): only the first panel — all eight periods in time order; no second day box
- Current class highlighted in place (no pin-to-top)
- Empty A–H slots (no real class that day) show the matching free-period shell when one exists
- Final-exam days (no `allPeriods`): Fall Nov 18–20, Winter Mar 3–5, Spring Jun 4/7/8 — labels `ABC` / `DEF` / `GH` with exam bells. Only enrolled periods appear in the UI.
- Day panels match classes by period using server-provided `activeClassIdsByDate` (so Fall G vs Winter G never collide). The UI does not show or mention trimester type.

When creating or editing class folders / free-period shells, also Read `.cursor/skills/personal-agent/education-dashboard.md`.
