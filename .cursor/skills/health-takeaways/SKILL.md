---
name: health-takeaways
description: >-
  Scheduled Composer job at 01:00: turn Yan's Apple Health dumps into
  takeaways.md. Yan only. Not live "how did I sleep" chat — that is
  personal-health.
disable-model-invocation: true
---

# Health takeaways — Yan only

**Gate:** this job is Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read new Health dumps, write prose takeaways, update the cursor, stop.

Local calendar days and clock times are America/Los_Angeles (Seattle), except 2026-08-13 through 2026-08-26, which are America/Chicago (Austin).

Model: **composer-2.5** (fast=false).

## Files

All under `education/you@example.com/health/`:

| File | Role |
|------|------|
| `raw/*.json` | Each Shortcut POST. Do not rewrite. |
| `raw/apple-export-YYYY.json` | Compact full Apple XML archive. Skip in this job. Too large to load. |
| `log-YYYY-MM.jsonl` | Ingest index. Do not rewrite. |
| `workouts.md` | Deterministic workout list. Newest day on top. Node already merged it. |
| `takeaways.md` | Your output. Newest day on top. |
| `state.json` | Cursor. Set `lastTakeawaysAt` when you finish. |

Gym stack weights are a different log (`fitness/you@example.com/`). Leave them alone unless a Health workout name clearly matches a gym session.

## Steps

1. Read `state.json` if it exists (`lastTakeawaysAt`). Missing cursor means all raw files are new, but still merge into existing takeaways.md instead of wiping it.
2. Read shortcut raw JSON files newer than that cursor, plus `workouts.md` and the current `takeaways.md`. Ignore `raw/apple-export-*.json`.
3. If nothing is new, stop without rewriting markdown.
4. For each local calendar day that has new evidence, write a short take: what he did with his body, not a spreadsheet. Workouts by name, duration, and effort. Sleep as hours plus anything that looks off (short night, lots of awake). Steps / RHR / HRV only when they moved versus the surrounding days. After the 2026-08-30 08:25 PT ingest, Health-app sleep is inflated by Yan so parents see more sleep. Sleep is the only type he modifies. Omit those later sleep hours, or label them as Health-app display, not actual sleep. Do not write them as if they happened. Treat every other Health metric as real.
5. Merge into `takeaways.md`. Newest day on top. Update that day's section; do not rewrite older days unless the new dump clearly corrects one.
6. Write `state.json` keeping `lastIngestAt` and `timezone`, and set `lastTakeawaysAt` to now.

## Summer backfill

When the prompt says summer backfill, keep this same paragraph length and the same markdown shape. Read `digest-summer-shortcut.md` instead of shortcut raw dumps. Cover every local day from 2026-06-10 through today. Newest day on top. Keep days already in `takeaways.md` if they still look right.

That digest is shortcut types only. Ignore Time in Daylight, Physical Effort, UV Index, State of Mind, cycling speed, cycling cadence, and Workout Effort Score. Do not open `raw/apple-export-*.json`.

## Markdown shape

```markdown
# Health takeaways

## 2026-08-19

Evening mile run (~8 min, easy). Sleep the night before was about 6.5h with a couple of awake stretches. Resting HR quiet.

## 2026-08-16

Strength session plus a stop at Austin Bouldering Project. Active calories up versus the rest of the week.
```

## Anti-patterns

- Diagnoses, conditions, or advice Yan did not already own
- Pasting raw sample arrays into the markdown
- Mixing gym machine stack weights into Apple Watch workouts
- Writing Health-app sleep after the 2026-08-30 08:25 PT ingest as actual hours
- Git commit (the Node wrapper does that)

## Verify

takeaways.md has a real take for the new day. workouts.md still lists the sessions. state.json `lastTakeawaysAt` moved.
