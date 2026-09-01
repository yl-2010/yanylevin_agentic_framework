---
name: health-brain
description: >-
  03:00 Composer job: project standing Apple Health facts into
  brain/health.md. Yan only. Not live "how did I sleep" chat, not
  the 01:00 takeaways job.
disable-model-invocation: true
---

# Health brain — Yan only

**Gate:** this job is Yan (`you@example.com`).  Never spawn a cloud agent.

You run after 02:30 synthesis and after the location-brain job. Distill standing body facts. Do not write a daily log.

Model: **composer-2.5** (fast=false).

## Files

| File | Role |
|------|------|
| `education/you@example.com/health/takeaways.md` | Nightly prose. Read. |
| `education/you@example.com/health/history-patterns.md` | Archive essay. Read. First run distills this. |
| `education/you@example.com/health/workouts.md` | Skim for mix, not every line. |
| `education/you@example.com/health/raw/apple-export-*.json` | Do not open. Too large. |
| `education/you@example.com/health/state.json` | Ingest/takeaways cursors plus your `brainHealth` object. Home timezone is America/Los_Angeles; Austin trip workouts after 2026-08-12 through 2026-08-26 use America/Chicago. |
| `education/you@example.com/brain/schema.md` | Memory-page contract. Required. |
| `education/you@example.com/brain/health.md` | Your only write target. |

## Write scope

**Only** `brain/health.md`. Never edit `patterns.md`, journal, `takeaways.md`, `workouts.md`, or `history-patterns.md`. Gym machine stacks under `fitness/` are a different log.

## Page shape

Identity-shaped. Rewrite freely. Standing bullets. Inferred lines labeled (inferred, as of DATE). Keep it smaller than `history-patterns.md`. Cover:

- Typical sleep band
- Resting HR / HRV band when the dumps support it
- Training era (swim years, then strength-forward)
- Late-session vs short-sleep tell

First run: distill `history-patterns.md`. Later nights: only promote what new takeaways actually changed. Do not copy every daily paragraph.

Do not promote sleep hours from dumps after the 2026-08-30 08:25 PT ingest into the typical band or recovery-sleep bullets. Yan inflates Health-app sleep until he says otherwise. Sleep is the only type he modifies. Keep the standing inflated-sleep line on the page if it is already there. Every other Health metric is always real and can still update.

## state.json

Keep `lastIngestAt`, `lastTakeawaysAt`, and `timezone`. Set:

```json
{
  "brainHealth": {
    "lastAt": "<now ISO>",
    "lastDateKey": "<job date key>",
    "timezone": "<job timezone>"
  }
}
```

The Node wrapper also writes this cursor after you finish.

## Anti-patterns

- Diagnoses, conditions, or advice Yan did not already own
- Dumping `takeaways.md` into the page
- Mixing gym stack weights into Watch workouts
- Treating Health-app sleep after the 2026-08-30 08:25 PT ingest as actual hours
- Git commit (the Node wrapper does that)

## Verify

`health.md` exists, reads as standing fact, and is shorter than the archive essay. Cursor moved.
