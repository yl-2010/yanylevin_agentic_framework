---
name: health-history
description: >-
  One-shot Composer 2.5 (Fast off) pass over Yan's full Apple Health
  archive. Writes history-patterns.md. Not the nightly takeaways job.
  Yan only. Do not run unless asked.
disable-model-invocation: true
---

# Health history patterns — Yan only

**Gate:** Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read the monthly digest, write standing patterns, stop.

Clock times are America/Los_Angeles (Seattle), except workouts after 2026-08-12 through 2026-08-26, which are America/Chicago (Austin).

Model: **composer-2.5** (fast=false). One-shot only; nightly takeaways is a separate Composer 2.5 job.

## Files

All under `education/you@example.com/health/`:

| File | Role |
|------|------|
| `digest-history.md` | Monthly rollup of the XML archive. Read this. |
| `workouts.md` | Session list. Skim for mix, not every line. |
| `history-patterns.md` | Your output. |
| `raw/apple-export-*.json` | Do not open. Too large. |

## Write

`history-patterns.md`: a few sections of prose, not a spreadsheet.

- Training mix over 2022–2026 (swim seasons, strength, running, climbing)
- Sleep timing that repeats (late nights, short nights before hard days). Dump sleep through the 2026-09-26 10:49 AM PT ingest is actual. Fold that window into the pattern. Do not fold later Health-app hours in. Those are inflated until Yan says otherwise.
- Recovery tells that show up more than once (RHR jumps, HRV crashes)
- Anything that clearly changed after a move or a season

Inferences. Not diagnoses. Not advice he did not ask for.

## Anti-patterns

- Opening yearly JSON
- Pasting sample arrays
- Mixing gym stack weights into Watch workouts
- Git commit (the Node wrapper does that)
