---
name: agent-recap
description: >-
  Build the Agent Recap card for Yan's morning Daily Briefing. Summarize
  overnight scheduled agents (not the briefing itself): failures, actions
  taken, and what was learned. Phase 2 of the daily-briefing pipeline.
---

# Agent recap

Yan-only (`education/you@example.com/`). Local Cursor agent, never cloud. Model: **grok-4.6 xhigh** (effort=xhigh, fast=false).

Phase 2 of the morning pipeline (`server/daily-briefing-agent.js`), after the news draft and before unslop.

## Output

Write `/tmp/yanylevin-daily-briefing-agent-recap-<today's dateKey>.json`:

```json
{
  "id": "agent-recap",
  "title": "Agent Recap",
  "category": "other",
  "noVote": true,
  "vote": null,
  "body": "..."
}
```

No citations. Plain text in `body`.

## Body structure

Use this order. **Omit a section entirely** when it does not apply that day (do not write "None" headers).

1. **`URGENT:`** (only when something needs Yan's attention)
   - Bullet list.
   - Agent that was supposed to run but did not (check `agents[]` in the nightly status prefetch).
   - Nightly pipeline phase failure (triage, entities, synthesis, actions, lint). `pipelineFinished` false after synthesis ran means actions/lint did not complete.
   - Context source with `ok=false` or missing when it is normally populated (`brain/state.json` `notes`, digest gaps).
   - Stale **nightly** cursors that mean a source is stuck (`mailSince`,
     `schoolMailSince`, `teamsSince`, `imessageSince`, `chatHistorySince`, `screenTimeAt`,
     `locationEnrichmentAt`, `healthAt`). Do not flag `appleMailFill.lastAt`
     or a missing `/tmp/yanylevin-apple-mail-export`. That fill is one-shot
     and not on the overnight schedule. The dump is deleted when it finishes.
     Overnight mail is `mailSince`.
   - **Life-state / iPhone heartbeat** from prefetch `lifeState`. Copy
     `lifeState.issues[]` as URGENT (5-minute log stopped or gapped,
     Composer error, no iPhone GPS on disk, GPS without a device
     bundle, Home or Screen Time snapshot fail). Empty `issues` means omit
     this. iPad must not be treated as the phone heartbeat.
   - Do not invent a GPS heartbeat failure, and do not put an old pin
     under URGENT. Sitting still (home overnight, a day in one building)
     does not post again until iOS wakes the iPhone app on a significant
     move (~500m), a visit, or he opens the app. The 5-minute `periodic`
     timer only runs while that process is alive. Force-quit also pauses
     it until he opens the app. Location compose skipping overnight with
     `no-new-points` is the same thing, not URGENT.
   - **Health Shortcut dump** from prefetch `healthShortcut`. Any
     `healthShortcut.issues[]` item is URGENT (no iPhone Shortcut POST in
     the last 12 hours, or `lastIngestAt` missing). Copy the detail. Empty
     `issues` means omit this. Do not invent extra dump failures. This is
     the Shortcut ingest, not `healthAt` and not a health-takeaways skip
     when there are no new dumps.
   - Anything else from logs or notes that Yan must fix before things work again.

2. **`Actions:`** (only when the nightly-actions phase did something)
   - Bullet list of sends (iMessage, Mail), calendar writes, education dates/todos/projects, or small repo work Yan directed.
   - Pull from git commits, `[nightly-actions]` log lines, and the actions
     Cursor transcript. Calendar creates do not appear in git.
   - `notes.calendar` is written by synthesis **before** actions. It is not a
     record of what phase 4 wrote. Do not restate it as "stayed off the
     calendar." Before you say an event is missing, list that local day with
     `node server/calendar-cli.js`. If it is already there, say so and put the
     create under Actions when the transcript shows a create.
   - Skips with a reason are not actions; mention important skips only under URGENT if they block something.

3. **General recap** (always, after any lists)
   - Short prose: what each overnight job did, brain/journal updates, new facts learned, canvas/location/health changes worth knowing this morning.
   - Write for Yan at breakfast, not as a log dump.

## Read first

1. `/tmp/yanylevin-nightly-status.json` (runner prefetch: per-agent `ran`, `pipelineFinished`, `pipelinePhase`, `brainNotes`, `brainCursors`, `journalExists`, `serverLogTail`, `gitCommits`).
2. `education/you@example.com/brain/state.json` (especially `notes`, `notes.factCheck`, and `lastSynthesisDateKey`).
3. Yesterday's journal: `brain/journal/<dateKey minus 1>.md` when it exists.
4. `location/state.json`, `health/state.json`, `daily-briefing/chat-title-refresh-state.json` if prefetch is thin. `lifeState` on the prefetch is the 5-minute log + iPhone heartbeat health; do not re-scan JSONL unless an issue is unclear. `healthShortcut` on the prefetch is Shortcut `lastIngestAt` vs 12 hours; do not re-read raw dumps unless the issue is unclear.
5. `/tmp/personal-agent-server.log` tail (prefetch includes filtered lines; read more if needed).
6. `git log` for today's `education:` commits (nightly pipeline, canvas, health, location).

## Overnight agents to cover

All scheduled jobs **except** the daily briefing itself:

| Slot | Jobs |
|------|------|
| 01:00 | Location compose, location enrichment, health takeaways, canvas sync |
| 01:30 | Chat title refresh |
| 02:30 | Context synthesis pipeline (triage, entities, synthesis, actions, lint) |
| 03:00 | Location brain projection, health brain projection, then fact-check (Grok 4.6 xhigh) as soon as both finish. URGENT if fact-check did not run. Mention `notes.factCheck` corrections in the recap; do not re-verify facts. |

Health takeaways may skip when there are no new dumps; that is OK unless something else looks wrong.

## Rules

- Do not invent actions or failures. If unsure, say so in the general recap or URGENT with uncertainty labeled.
- Do not paste secrets, full email bodies, or long log blocks into the body.
- Do not compile news. Do not write `todo.json` or `taste.md` (phase 3 does that).
- Apply plain, direct language. Phase 3 will unslop this card too.
