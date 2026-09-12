---
name: life-state
description: >-
  Guess what Yan is doing right now (showering, sleeping, in class, driving)
  from Home, GPS, schedule, Calendar, Screen Time, iMessage, and gym. Also
  read the 5-minute life-state log. Yan only. Use for "what am I doing",
  "where am I in my day", or the scheduled Composer tick.
disable-model-invocation: true
---

# Life state — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Never read `education/you@example.com/life-state/` for Alex. Do not dump Home, location, or this log into a group chat.

Local only. Never spawn a cloud agent.

## Files

```
education/you@example.com/life-state/
  schema.md
  heuristics.md
  current.json
  log-YYYY-MM.jsonl
  state.json
  intent.json
```

Read `schema.md` and `heuristics.md` before writing a sample. Contract is the schema.

Home latches (not lights): `home.bedroomBoolean` / `lastMotionRoom` (on = last bedroom occupancy, off = last office occupancy or he left the house), `home.bathroomBoolean` (in-bathroom latch so lights survive a long shower), `home.leavingBathBool` (back at the bathroom doorway). Occupancy sensors do not cross-contaminate except bathroom occupancy, which can also see the closet. Sitting in bed or in the shower usually will not retrigger those sensors. Office Boolean and office middle sensor are unused.

Showering: Bathroom Boolean on plus a shower tell, or a fresh `phoneIntent.kind` `going_to_shower` (portrait dock). Fan-only is leftover, unless the fan just came on from that dock. Sleeping: fresh `going_to_sleep` (landscape dock) is a lock. Ignore a dock intent if Bedroom Boolean is off.

## On demand (chat)

1. If `current.json` exists and `at` is younger than about 10 minutes, that is the answer (`node server/life-state.js now`). One or two sentences. Do not dump evidence tokens unless asked.
2. Older than 10 minutes, missing, or Yan asked for a fresh guess: run `node server/life-state-snapshot.js`, read `/tmp/yanylevin-life-state-snapshot.json` plus the last few samples (`node server/life-state.js recent 3`), infer, then `node server/life-state.js append /tmp/yanylevin-life-state-guess.json` after writing that guess file. Set `"model": "on-demand"`.
3. Historical ("what was I doing Tuesday at 3"): `node server/life-state.js at 2026-09-08T22:00:00Z` (or a local time he named). Do not start a new Composer job.

Do not open Mail, OneNote, Teams, Canvas, journal, or people cards for this. Do not use Apple Health sleep.

## Nightly jobs

Overnight agents (01:00 compose/enrichment/takeaways, 02:30 pipeline, 03:00
brain + fact-check) treat this log as a context source. Prefetch is
`/tmp/yanylevin-context-life-state.json` (yesterday collapsed). Or
`node server/life-state.js day <YYYY-MM-DD>`. Read kinds, do not dump JSONL
into identity or places.md. Do not write samples from those jobs. The 5-minute
Composer tick is the writer.

## Scheduled tick

You are a one-shot local Composer job. Snapshot is already on disk. Infer. Write one sample. Stop.

1. Read this skill, `schema.md`, and `heuristics.md`.
2. Read `/tmp/yanylevin-life-state-snapshot.json`.
3. Read last samples from the snapshot `previous` array (or `node server/life-state.js recent 3`).
4. Pick `kind`, `activity`, `place`, `placeLabel`, `confidence`, `evidence`, optional `notes`. Set `since` / `continued` from the last sample.
5. Write `/tmp/yanylevin-life-state-guess.json` with those fields only (no `at` / `local` / `dateKey` unless you have them; the CLI fills clock fields).
6. Run `node server/life-state.js append /tmp/yanylevin-life-state-guess.json`. If it rejects, fix once and retry. Then stop.

Do not git commit. Do not edit any other file. Do not wander the repo.

## Evidence tokens

Short, greppable, no secrets. Examples: `gps:home`, `gps:eps`, `gps:pro-club`, `gps:stale`, `speed:car`, `phone:car-audio`, `phone:charging`, `intent:going-to-shower`, `intent:going-to-sleep`, `home:bath-lights`, `home:bath-fan`, `home:bath-boolean`, `home:leaving-bath`, `home:bedroom-on`, `home:last-motion-bedroom`, `home:last-motion-office`, `home:away`, `schedule:in-class`, `schedule:lunch`, `schedule:free`, `calendar:debate`, `screen:cursor`, `screen:tiktok`, `imessage:from-me`, `gym:recent`.

## Phone plug-in Shortcut

Yan's existing personal automation already branches on orientation (and Bedroom Boolean, same as Home). Add **Get Contents of URL** on each of those branches. POST `https://api.yanylevin.com/api/education/life-state-intent`. Header `Authorization: Bearer` plus the same `LOCATION_INGEST_TOKEN` as the location/Health Shortcut. Header `Content-Type: application/json`. JSON body `{"intent":"going_to_shower","orientation":"portrait"}` on the portrait/fan branch, `{"intent":"going_to_sleep","orientation":"landscape"}` on the landscape/nighttime-scene branch. Do not POST when Bedroom Boolean is off. The Mac stores `life-state/intent.json` and kicks a life-state guess so the log does not wait for the next 5-minute tick.
