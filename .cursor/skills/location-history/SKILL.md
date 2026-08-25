---
name: location-history
description: >-
  Scheduled Composer job: turn Yan's GPS JSONL into stays and trips
  (walk / car / plane / uber / robotaxi). Yan only. Not for live "where
  am I" chat — that is phone-location.
disable-model-invocation: true
---

# Location history compose — Yan only

**Gate:** this job is Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read new GPS points, compose coherent stays and trips, write markdown, update the cursor, stop.

## Files

All under `education/you@example.com/location/`:

| File | Role |
|------|------|
| `log-YYYY-MM.jsonl` | Raw ingest lines (UTC month). Do not rewrite. |
| `state.json` | Cursor. Update when you finish. |
| `places.md` | Date-grouped stays. Newest day on top. |
| `trips.md` | Date-grouped paths. Newest day on top. |

Live last-known fix (do not use as history): `education/you@example.com/.location.json`.

## Steps

1. Read `state.json` if it exists (`lastProcessedReceivedAt`). If missing, treat all JSONL as new, but still merge into existing markdown instead of wiping it.
2. Read JSONL months that could contain new lines. Each line is one GPS object: `latitude`, `longitude`, `receivedAt`, optional `timestamp`, place labels, `speedMps`, `courseDegrees`, `altitudeMeters`, `visitKind` (`arrival` / `departure`).
3. Keep only lines with `receivedAt` (or `timestamp`) **after** `lastProcessedReceivedAt`. If none, stop without rewriting markdown.
4. Cluster nearby points into **stays**: same named place or roughly the same block (hundreds of meters). `visitKind` arrival/departure is a strong stay boundary. Use reverse-geocoded `placeName` / `areasOfInterest` / `locality` when present; otherwise a short real-world name from coords (campus, airport, neighborhood). Arrive = first point, leave = last point, dwell = leave − arrive. A single ping is a brief stay, not a trip.
5. Infer **trips** between consecutive stays:
   - **walk:** short distance, slow or missing speed
   - **car:** tens of km, minutes to a couple of hours, personal/unknown driver unless a receipt matches
   - **plane:** city/region jump, hundreds of km, or a multi-hour gap with a new metro (phone often off in flight)
   - **uber / robotaxi / lyft / rideshare:** receipt wins (below)
6. **Mail.app ride receipts, traveling only.** After GPS clustering, if **every** new stay/trip is inside the Seattle metro (Seattle, Kirkland, Bellevue, Redmond, Eastside, and nearby Eastside cities), **skip Mail.app**. Do not search for Uber/robotaxi/Lyft at home. That is a waste of tokens.

   Search mail **only** when at least one new stay or trip is **outside** that metro. Yan-only. Same Mail.app `osascript` pattern as `.cursor/skills/personal-mail/SKILL.md`. Search Exchange first (`mailbox "Inbox" of account "Exchange"`), then Google / iCloud if needed (`mailbox "INBOX"` all caps on both; `"Inbox"` fails). Use `whose` filters + date. Do **not** iterate the whole inbox.

   Subjects / senders to try: Uber (`uber.com`, "Your trip", "Thanks for riding"), Lyft, Waymo, Zoox, Cruise, Tesla robotaxi, and other ride receipts that show pickup, dropoff, and time.

   From each match, extract **only** trip facts: service, pickup, dropoff, start/end time, duration, distance if present. Do **not** copy fare, payment, card digits, or full email bodies into `trips.md`.

   Match a receipt to a GPS leg by overlapping time (and pickup/dropoff vs nearby stays). Receipt wins for mode, endpoints, and duration. GPS fills the path if it exists. Label `uber` / `robotaxi` / `lyft` / `rideshare`, not generic `car`.
7. Merge into `places.md` and `trips.md`. Newest calendar day on top. Update that day's section; do not rewrite older days unless a receipt clearly corrects one. Local dates use the job timezone from the prompt. If a stay already has a specific name (person's house, business, gym) for the same address, **keep it**. Do not revert "Milos's house" back to the street number. The 02:30 context-synthesis job may correct names after you run.
8. Write `state.json`:

```json
{
  "lastProcessedReceivedAt": "<ISO of last JSONL line you consumed>",
  "lastComposeAt": "<now ISO>",
  "timezone": "<job timezone>"
}
```

## Markdown shape

`places.md` (example):

```markdown
# Places

## 2026-08-16

- **The University of Texas at Austin** (Austin, TX) — 11:20–14:05 (2h 45m)
- **Austin-Bergstrom International Airport** (Austin, TX) — 14:40–16:10 (1h 30m)
```

`trips.md` (example):

```markdown
# Trips

## 2026-08-16

- **uber** 14:12–14:38 — UT Austin → AUS (~8 mi)
- **walk** 11:05–11:20 — hotel → UT Austin
- **plane** 16:10–19:05 — AUS → SEA (phone off in flight)
```

Keep lines short. Real place names. No coordinates in the markdown unless the place is unknown. No fares.

## Heuristics

- Airport names and sudden metro jumps → plane, even with a GPS gap.
- `visitKind` arrival/departure beats clustering when they disagree.
- Speed ~1–2 m/s → walk; ~10–30 m/s → car/rideshare; hundreds of km/h equivalent or a city jump → plane.
- Receipt vs GPS mismatch: keep both facts if needed ("uber per receipt; GPS sparse").
- Do not invent stays for missing hours at home overnight unless a visit says so; a quiet night is one stay.
