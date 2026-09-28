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
  signals-YYYY-MM.jsonl
  cleanup-state.json
```

Read `schema.md` and `heuristics.md` before writing a sample. Contract is the schema.

Home latches (not lights): `home.bedroomBoolean` / `lastMotionRoom` (on = last bedroom occupancy, off = last office occupancy or he left the house), `home.bathroomBoolean` (in-bathroom latch so lights survive a long shower), `home.leavingBathBool` (back at the bathroom doorway). Occupancy sensors do not cross-contaminate except bathroom occupancy, which can also see the closet. Sitting in bed or in the shower usually will not retrigger those sensors. Office Boolean and office middle sensor are unused.

Showering: Bathroom Boolean on plus a shower tell, or a fresh `phoneSignals.going_to_shower` if one arrived. Fan-only is leftover, unless the fan just came on from that dock. Sleeping: a fresh `going_to_sleep` is a strong tell when it arrived. Phone automations are extra, not required. iOS often skips them when the phone is locked, so a real shower, sleep, unplug, or drive with nothing in `phoneSignals` is normal. Do not wait for a POST. Do not treat a quiet `recent` log as proof he skipped it. `plugged_in` is charging without the stand ritual. `unplugged` is the phone leaving power. Driving Focus means any car, maybe passenger. Tesla Bluetooth means the Tesla. Focus or Bluetooth blips resume the same trip. Ignore shower/sleep dock intents if Bedroom Boolean is off.

## On demand (chat)

1. If `current.json` exists and `at` is younger than about 10 minutes, that is the answer (`node server/life-state.js now`). One or two sentences. Do not dump evidence tokens unless asked.
2. Older than 10 minutes, missing, or Yan asked for a fresh guess: run `node server/life-state-snapshot.js`, read `/tmp/yanylevin-life-state-snapshot.json` plus the last few samples (`node server/life-state.js recent 3`), infer, then `node server/life-state.js append /tmp/yanylevin-life-state-guess.json` after writing that guess file. Set `"model": "on-demand"`.
3. Historical ("what was I doing Tuesday at 3"): `node server/life-state.js at 2026-09-08T22:00:00Z` (or a local time he named). Do not start a new Composer job.

Do not open Mail, OneNote, Teams, Canvas, journal, or people cards for this. Do not use Apple Health sleep on this live 5-minute tick. Dumps are not live. Nightly cleanup uses dump sleep only through the 2026-09-26 10:49 AM PT ingest. Later Health-app sleep is inflated until Yan says otherwise.

## Nightly jobs

Overnight agents (01:00 compose/enrichment/takeaways, 01:30 chat titles +
life-state cleanup, 02:30 pipeline, 03:00 brain + fact-check) treat this log
as a context source. Prefetch is `/tmp/yanylevin-context-life-state.json`
(yesterday collapsed). Or `node server/life-state.js day <YYYY-MM-DD>`. Read
kinds, do not dump JSONL into identity or places.md. Indoor activity (rooms,
apps, class periods, gym sets, shower, sleep) lives only in this log.
Location `places.md` is the address. Do not write samples from the 01:00 /
02:30 / 03:00 jobs. The 5-minute Composer tick is the live writer. That tick
starts on the clock (:00, :05, :10, …). A slow run does not slide the next
start.

The **01:30 life-state cleanup** job is the other writer. It rewrites
yesterday's samples in place when Screen Time, iMessage, Teams, Calendar,
location, or neighbors prove a tick was wrong. Follow
`.cursor/skills/life-state-cleanup/SKILL.md` when that job runs.

## Scheduled tick

You are a one-shot local Composer job. This tick started on a 5-minute
clock mark. Snapshot is already on disk. Infer. Write one sample. Stop.

1. Read this skill, `schema.md`, and `heuristics.md`.
2. Read `/tmp/yanylevin-life-state-snapshot.json`. Shortcut POSTs live under `phoneSignals.recent` and the by-kind keys. They are extra. Missing them is normal (locked phone). A POST does not write a sample. This tick does.
3. Read last samples from the snapshot `previous` array (or `node server/life-state.js recent 3`).
4. Pick `kind`, `activity`, `place`, `placeLabel`, `confidence`, `evidence`, optional `notes`. Set `since` / `continued` from the last sample.
5. Write `/tmp/yanylevin-life-state-guess.json` with those fields only (no `at` / `local` / `dateKey` unless you have them; the CLI fills clock fields).
6. Run `node server/life-state.js append /tmp/yanylevin-life-state-guess.json`. If it rejects, fix once and retry. Then stop.

Do not git commit. Do not edit any other file. Do not wander the repo.

## Evidence tokens

Short, greppable, no secrets. Examples: `gps:home`, `gps:eps`, `gps:pro-club`, `gps:stale`, `speed:car`, `phone:car-audio`, `phone:charging`, `intent:going-to-shower`, `intent:going-to-sleep`, `intent:plugged-in`, `intent:unplugged`, `intent:driving-focus`, `intent:tesla-bluetooth`, `home:bath-lights`, `home:bath-fan`, `home:bath-boolean`, `home:leaving-bath`, `home:bedroom-on`, `home:last-motion-bedroom`, `home:last-motion-office`, `home:away`, `schedule:in-class`, `schedule:lunch`, `schedule:free`, `calendar:debate`, `screen:cursor`, `screen:tiktok`, `imessage:from-me`, `gym:recent`.

## Phone Shortcuts

`npm run life-state-shortcut` writes four Shortcuts to iCloud Drive `YanLifeState/`. Yan adds the automations. POSTs are filled.

- **Yan Life State Dock** (plug in): two identical `plugged_in` leftover copies first, then shower and sleep. Put each leftover copy in its If branch.
- **Yan Life State Unplug**: one POST, `unplugged`.
- **Yan Life State Driving Focus**: one POST, `driving_focus`. Any car. 15 min resume.
- **Yan Life State Tesla**: one POST, `tesla_bluetooth`. Tesla only. 10 min resume.

Snapshot `phoneSignals` is extra, not required. Each Shortcut POST updates `intent.json` and appends one line to `signals-YYYY-MM.jsonl`. That save does not start a 5-minute tick. The scheduled job still starts on the clock (:00, :05, :10, …) and reads `phoneSignals.recent` (sends from the last 6 hours) plus the by-kind keys (`phoneSignals.going_to_sleep`, and so on). Automations commonly fail while the iPhone is locked. Guess from Home, GPS, schedule, and screens even when `recent` is empty.
