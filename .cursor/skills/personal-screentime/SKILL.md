---
name: personal-screentime
description: >-
  Read Yan's Apple Screen Time / app usage from knowledgeC.db on the Mac
  Studio (iPhone, MacBook, Mac Studio). Use when Yan asks how he spent his
  time, screen time, pickups, TikTok/Instagram hours, or which apps he used.
  Nightly context synthesis also reads this. Yan only — never for Alex.
disable-model-invocation: true
---

# Screen Time — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

Read-only. This is Apple's own usage log (`knowledgeC.db`), not the public Screen Time API. iPhone / iPad / MacBook sessions sync to the Studio when Screen Time sharing is on. Mac Studio usage is local (often a null device id).

Cursor agent shells usually cannot open `~/Library/Application Support/Knowledge/knowledgeC.db` (TCC). The Express LaunchAgent (`node`, Full Disk Access) can. Prefer the local Unix socket (not on the public API):

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/screentime/summary"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/screentime/summary?days=7"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/screentime/recent"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/screentime/recent?since=2026-08-16T07:00:00Z"
```

CLI from Terminal.app or the LaunchAgent (often fails inside Cursor):

```bash
node server/screentime-read.js summary
node server/screentime-read.js summary 7
node server/screentime-read.js recent
node server/screentime-read.js recent 2026-08-16T07:00:00Z
```

Needs **Full Disk Access** for `node` (same grant as Messages). Do not copy `knowledgeC.db` into this repo.

Nightly context synthesis already dumps `/tmp/yanylevin-context-screentime.json`. Prefer that file during a synthesis run.

## How to read it

`summary` is the default: last N days (1–14, default 7) rolled up by local date, device, top apps, categories, and a coarse hourly histogram. `recent` is individual sessions (newest first).

- A midday query only has usage so far that day. The 02:30 synthesizer runs after the local day is over, so treat that day's totals as complete.
- Totals are summed app-foreground minutes. They can exceed clock time if sessions overlap.
- Web domains are a weak extra (Safari/Arc); ignore ad/tracker hosts.
- Quote only what answers the question. Do not paste a 7-day minute table unprompted. Do not lecture.

## Context synthesis

Every 02:30 run must open the prefetch dump and say what the hours added up to (where they went, evening vs daytime, streaks). Cross with places and calendar. Do not treat Screen Time as a separate pile.
