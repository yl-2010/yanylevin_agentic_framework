---
name: health-history
description: >-
  How the 01:00 health takeaways job updates standing Apple Health
  files, especially history-patterns.md. Yan only. Not its own agent.
disable-model-invocation: true
---

# Health history patterns

**Gate:** Yan (`you@example.com`) only.  Never spawn a cloud agent.

The 01:00 health takeaways job reads this when a new day might change a standing pattern. This is not a separate agent and it is not on the dashboard.

Clock times are America/Los_Angeles (Seattle), except workouts after 2026-08-12 through 2026-08-26, which are America/Chicago (Austin).

## Files

All under `education/you@example.com/health/`:

| File | Role |
|------|------|
| `digest-history.md` | Monthly rollup of the XML archive. Read this. |
| `workouts.md` | Session list. Skim for mix. Node owns the file. Do not rewrite it. |
| `history-patterns.md` | Standing essay. Edit it when a pattern actually changed. |
| `takeaways.md` | Daily prose. The takeaways skill owns the day's section. |
| `raw/apple-export-*.json` | Do not open. Too large. |

`brain/health.md` belongs to the 03:00 health brain job. Leave it alone.

## When to edit

After the day's takeaway is written, read `history-patterns.md`. Update it when the new evidence changes something that repeats:

- Training mix over 2022–2026 (swim seasons, strength, running, climbing)
- Sleep timing that repeats (late nights, short nights before hard days). Dump sleep through the 2026-09-26 10:49 AM PT ingest is actual. Fold that window into the pattern. Do not fold later Health-app hours in. Those are inflated until Yan says otherwise.
- Recovery tells that show up more than once (RHR jumps, HRV crashes)
- Anything that clearly changed after a move or a season

If the day already fits the essay, do not touch the file. One ordinary workout is not a new pattern.

Edit in place. Change the paragraph that moved. Do not replace the whole essay for a single day.

Inferences. Not diagnoses. Not advice he did not ask for.

## Anti-patterns

- Opening yearly JSON
- Pasting sample arrays
- Mixing gym stack weights into Watch workouts
- Rewriting `workouts.md`, digest files, or `brain/health.md`
- Git commit (the Node wrapper does that)
