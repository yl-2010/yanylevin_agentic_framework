---
name: agent-recap
description: >-
  Build the Agent Recap card for Yan's morning Daily Briefing. Summarize
  overnight scheduled agents (not the briefing itself): failures, actions
  taken, and what was learned. Phase 2 of the daily-briefing pipeline.
---

# Agent recap

Yan-only (`education/you@example.com/`). Local Cursor agent, never cloud. Model: **grok-4.6 high** (effort=high, fast=false).

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
     `schoolMailSince`, `imessageSince`, `chatHistorySince`, `screenTimeAt`,
     `locationEnrichmentAt`, `healthAt`). Do not flag `appleMailFill.lastAt`
     or a missing `/tmp/yanylevin-apple-mail-export`. That fill is one-shot
     and not on the overnight schedule. The dump is deleted when it finishes.
     Overnight mail is `mailSince`.
   - Anything else from logs or notes that Yan must fix before things work again.

2. **`Actions:`** (only when the nightly-actions phase did something)
   - Bullet list of sends (iMessage, Mail), calendar writes, education dates/todos/projects, or small repo work Yan directed.
   - Pull from synthesis notes, git commits, and `[nightly-actions]` log lines.
   - Skips with a reason are not actions; mention important skips only under URGENT if they block something.

3. **General recap** (always, after any lists)
   - Short prose: what each overnight job did, brain/journal updates, new facts learned, canvas/location/health changes worth knowing this morning.
   - Write for Yan at breakfast, not as a log dump.

## Read first

1. `/tmp/yanylevin-nightly-status.json` (runner prefetch: per-agent `ran`, `pipelineFinished`, `pipelinePhase`, `brainNotes`, `brainCursors`, `journalExists`, `serverLogTail`, `gitCommits`).
2. `education/you@example.com/brain/state.json` (especially `notes`, `notes.factCheck`, and `lastSynthesisDateKey`).
3. Yesterday's journal: `brain/journal/<dateKey minus 1>.md` when it exists.
4. `location/state.json`, `health/state.json`, `daily-briefing/chat-title-refresh-state.json` if prefetch is thin.
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
