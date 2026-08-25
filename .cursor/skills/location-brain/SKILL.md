---
name: location-brain
description: >-
  03:00 Composer job: project named GPS stays into brain/places cards.
  Yan only. Not live "where am I" chat, not GPS compose/enrichment.
disable-model-invocation: true
---

# Location brain — Yan only

**Gate:** this job is Yan (`you@example.com`).  Never spawn a cloud agent.

You run after 02:30 synthesis has finished naming stays. Do not re-cluster GPS. Do not rewrite `location/places.md` or `trips.md`. Read those files and upsert durable place cards.

Model: **composer-2.5** (fast=false).

## Files

| File | Role |
|------|------|
| `education/you@example.com/location/places.md` | Named stays. Read. Newest day on top. |
| `education/you@example.com/location/trips.md` | Only if a stay name is ambiguous. |
| `education/you@example.com/location/state.json` | Compose/enrichment cursors plus your `brainPlaces` object. |
| `education/you@example.com/brain/schema.md` | Frontmatter and timeline contract. Required. |
| `education/you@example.com/brain/places/<slug>.md` | Your only write target. |

Copy the shape of `brain/places/306-e-30th-airbnb.md`: frontmatter, `> ` summary, `## Standing`, `<!-- timeline -->`, `## Timeline`.

## Write scope

**Only** `brain/places/<slug>.md`. Never edit `places.md`, `trips.md`, identity, people cards, journal, or generated `people/index.md` / `people/graph.md` (the Node wrapper regenerates those).

## Card rules

1. Match an existing card by name, alias, or address before creating anything. Leon Street Flats, Milos's house, and the 30th Airbnb already exist.
2. Create a card when a stay has a real name (someone's house, lodging, gym, named campus building) **and** at least one of: a card already exists, it appears on 2+ distinct days in the lookback, or it is lodging / a person's house / a gym Yan actually uses.
3. Skip street-only pins, robotaxi pickup/dropoff, and dwell under ~15 minutes unless a card already exists.
4. Append `- YYYY-MM-DD | stay fact [GPS]` under `<!-- timeline -->`. Skip if that date already has the same stay. Rewrite Standing, summary, `last_touched`, aliases, and address. Never rewrite or delete old timeline lines.
5. First run or missing `brainPlaces` cursor: last 14 days, and always refresh any card that already exists.
6. `--force`: same 14-day window, re-check matches, still no wipe.

## state.json

Keep compose and enrichment fields. Set:

```json
{
  "brainPlaces": {
    "lastAt": "<now ISO>",
    "lastDateKey": "<job date key>",
    "timezone": "<job timezone>"
  }
}
```

The Node wrapper also writes this cursor after you finish.

## Anti-patterns

- Git commit (the Node wrapper does that)
- Inventing a place Yan did not stay
- Copying every Target / pickup pin into a card
- Reverting a named house or gym back to a street

## Verify

Each named recurring stay in the lookback has a card or a stated skip. New timeline lines use `[GPS]`. Frontmatter still parses.
