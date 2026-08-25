---
name: personal-health
description: >-
  Read Yan's Apple Health dump (workouts, sleep, HR, recovery). Use when he
  asks how he slept, what he trained, resting HR, HRV, steps, or Apple
  Watch activity. Yan only. Not the gym machine log (fitness-os).
disable-model-invocation: true
---

# Apple Health — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Never read `education/you@example.com/health/` for Alex.

An iPhone Shortcut posts a daily dump to the Mac. Composer at 01:00 writes prose takeaways. You read those files. You do not talk to HealthKit or the phone.

Clock times in the markdown are **America/Los_Angeles** (Seattle), except workouts after 2026-08-12 through 2026-08-26, which are **America/Chicago** (Austin). After Aug 26 he is back on Seattle time.

## Read

Do not dump the whole tree into every turn. Start here:

- `education/you@example.com/health/takeaways.md` — nightly prose, newest day on top
- `education/you@example.com/health/workouts.md` — every Apple Workout session Node has merged
- `education/you@example.com/health/history-patterns.md` — standing patterns from the full archive, when it exists
- `education/you@example.com/brain/health.md` — standing body facts (sleep band, training era, recovery tells), when it exists

Open `raw/*.json` only when the markdown is missing a day or the question needs a number that is not in the takeaways (exact HRV, a specific sleep stage). `log-YYYY-MM.jsonl` is an ingest index, not a chart.

`raw/apple-export-YYYY.json` is the compact full Apple Health XML archive (2022–2026). Same schema as a Shortcut dump, one year per file. Do not JSON.parse a whole year into the prompt. For history, start with `workouts.md`. If you need a series (swim yards, workout effort, daylight, physical effort), read that year's file with a script or a tight query, not by pasting it.

Sleep in that archive was overwritten on Aug 20 2026 from the cleaned export (`health export aug 20 2026 fake data removed.zip`). Earlier sleep had been faked so late homework nights would not show in the Health app. Shortcut dumps from that point on, and any later full export, are real. Treat them as accurate.

Gym stack weights live under `fitness/you@example.com/` (fitness-os skill). Different log. Use both when he asks about "the gym" in a way that could mean machines or Watch workouts.

## Staleness

Yan runs the Shortcut by hand. Several dumps a day are fine. If `state.json` `lastIngestAt` is more than about 36 hours old, say the dump may be stale and answer from what is on disk anyway.

## Tone

Lifestyle context, not a medical chart. No diagnoses. No advice he did not ask for. Workouts by name and duration. Sleep as hours plus anything that looked off.
