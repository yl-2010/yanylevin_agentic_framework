---
name: life-state-cleanup
description: >-
  Nightly Grok 4.6 xhigh job: clean yesterday's 5-minute life-state log
  using Screen Time, iMessage, Teams, Calendar, location, and other
  sources. Fix flicker and wrong kinds. Yan only. Not the live 5-minute tick.
disable-model-invocation: true
---

# Life-state cleanup — Yan only

**Gate:** Yan (`you@example.com`) only.  Never spawn a cloud agent. Local only.

You run at **01:30** (`lifeStateCleanupLocalTime` in `education/you@example.com/daily-briefing/meta.json`), after the 01:00 location compose. Chat title refresh is the other 01:30 job. Context synthesis is 02:30 and will read the cleaned log.

Model: **grok-4.6 xhigh** (effort=xhigh, fast=false).

The 5-minute Composer tick guesses from a snapshot. It flickers. One sleeping sample between awake samples, Home while GPS was at school, shower from a leftover fan. Your job is yesterday's full day with every source, then rewrite the wrong ticks.

## Files

```
education/you@example.com/life-state/
  schema.md
  heuristics.md
  log-YYYY-MM.jsonl
  current.json          only touch if yesterday's last sample is current.json
  signals-YYYY-MM.jsonl
  intent.json
  cleanup-state.json    wrapper writes this
```

Dump already on disk: `/tmp/yanylevin-life-state-cleanup-day.json` (collapsed `segments` plus every sample). Read that first. Do not glob the JSONL unless a window needs a closer look.

Contract is `schema.md`. Heuristics still apply. Do not invent kinds.

## What to fix

Keep every existing `at` / `local` / `dateKey`. Do not add ticks. Do not delete ticks.

Rewrite `kind`, `activity`, `place`, `placeLabel`, `confidence`, `evidence`, `notes` when the guess is wrong. The CLI relinks `since` / `continued`.

Typical mistakes:

- One-tick (or short) `sleeping` between awake samples, then Screen Time, iMessage `fromMe`, Teams, or a Mac session in that window. He was awake.
- `sleeping` while the phone or a Mac was in active use, unless a landscape-dock `going_to_sleep` just fired and the screen is the stand.
- `showering` from a leftover bathroom fan with Bathroom Boolean off and no shower tell.
- `at_home` / `on_computer` / `in_office` while GPS / places.md put him at EPS, PRO Club, a friend's, or in a car. Parsec from school still looks like the Studio.
- `in_class` while GPS was still home, or still at school after the last bell with no class slot.
- `driving` vs `passenger` when Tesla Bluetooth, Driving Focus, or a receipt says otherwise.
- Place slug that does not match the stay (kirkland-home while places.md says EPS).

Do not flatten real transitions. A 10-minute shower between office ticks is a shower. Overnight sleep that matches a dark house, no screens, no fromMe is sleep. When sources disagree, prefer the stronger one (GPS over Home-at-school, Screen Time / fromMe over a lone sleeping tick).

## Sources (use as many as the day needs)

Read the matching skill, then query. Cursor shells often cannot open `knowledgeC.db` or `chat.db`. Use the unix socket / CLI.

| Source | How |
| --- | --- |
| Life-state dump | `/tmp/yanylevin-life-state-cleanup-day.json` |
| Phone Shortcut signals | `signals-YYYY-MM.jsonl`, `intent.json` |
| Screen Time | `.cursor/skills/personal-screentime/SKILL.md` — `curl --unix-socket /tmp/personal-agent-local.sock "http://localhost/screentime/recent?since=<yesterday 00:00Z>"` |
| iMessage | `.cursor/skills/personal-imessage/SKILL.md` — same socket, `fromMe` / `who` / `atLocal`. Never treat `handle` as speaker in a 1:1. Do not copy message bodies into samples. |
| School Teams | `.cursor/skills/personal-school-teams/SKILL.md` — `node server/school-teams.js` chats he sent in yesterday's window |
| Calendar | `.cursor/skills/personal-calendar/SKILL.md` — `node server/calendar-cli.js events --from … --to …` |
| Location | `education/you@example.com/location/places.md` and `trips.md` (01:00 compose already ran). GPS JSONL only if a stay is unclear. |
| Schedule | `.cursor/skills/class-schedule/SKILL.md` — `schedule.json` for in_class / free / lunch |
| Gym | `.cursor/skills/fitness-os/SKILL.md` — yesterday's machine entries |
| Chat history | `.cursor/skills/past-chats/SKILL.md` if he told the agent where he was |
| Mail | `.cursor/skills/personal-mail/SKILL.md` only for ride receipts that settle driving vs robotaxi / uber |
| Apple Health sleep | `.cursor/skills/personal-health/SKILL.md` — `health/takeaways.md` and that day's dump. Dump sleep hours are actual overnight. Use them when a sleeping vs awake stretch is in doubt. |

Ignore Health workouts unless a dump landed that day. Do not open OneNote.

Evidence tokens stay short and greppable. Add source tokens you actually used (`screen:tiktok`, `imessage:from-me`, `teams:from-me`, `gps:eps`, `place:pro-club`). The CLI adds `cleanup:corrected` on changed rows. No coordinates, UUIDs, or message text in `notes`.

## Write

1. Read this skill, `schema.md`, `heuristics.md`, and the dump.
2. Pull the sources above for yesterday's local day (journal date key in the prompt).
3. Decide corrections. Skip ticks that already look right.
4. Write `/tmp/yanylevin-life-state-cleanup.json`:

```json
{
  "dateKey": "2026-09-13",
  "corrections": [
    {
      "at": "2026-09-14T07:00:00.000Z",
      "kind": "in_bedroom",
      "activity": "awake in bedroom, not asleep",
      "place": "kirkland-home",
      "placeLabel": "Home",
      "confidence": 0.86,
      "evidence": ["screen:tiktok", "imessage:from-me", "home:bedroom-on"],
      "notes": "one-tick sleeping between awake samples"
    }
  ]
}
```

Empty `corrections` if the day is clean. Still write the file.

5. Run `node server/life-state.js rewrite-day <journalKey> /tmp/yanylevin-life-state-cleanup.json`. If it rejects, fix once and retry.

Do not git commit. Do not edit brain, journal, location markdown, or any file outside the life-state rewrite CLI. `model` on changed rows becomes `grok-4.6` via the CLI.

## Anti-patterns

- Inventing a 5-minute tick that was never logged
- Deleting a tick because it was ugly
- Copying Screen Time tables or iMessage bodies into `activity` / `notes`
- Ignoring Health dump sleep for overnight spans
- Using Home lights while GPS is away
- Flattening a real shower, drive, class, or gym stop into the neighbors
