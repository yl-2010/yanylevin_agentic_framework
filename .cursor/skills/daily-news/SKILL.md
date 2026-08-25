---
name: daily-news
description: >-
  Compile Yan's morning Daily Briefing as a user-level todo with news capsules.
  Use when compiling the daily briefing, daily news, daily brief, or when the
  6:00 scheduler / npm run daily-briefing runs. Also use when the Personal
  Agent answers news follow-ups or Yan gives written feedback on news
  selection (append to preferences.md).
---

# Daily News

Yan-only (`education/you@example.com/`). Local Cursor agents, never cloud.

## Pipeline (Express 6:00 job)

`server/daily-briefing-agent.js` runs three phases:

| Phase | Model | Skill | Output |
|-------|-------|-------|--------|
| 1 news | grok-4.6 xhigh | this file (news sections only) | `/tmp/yanylevin-daily-briefing-news-draft.json` |
| 2 agent-recap | grok-4.6 high | agent-recap | `/tmp/yanylevin-daily-briefing-agent-recap.json` |
| 3 unslop | composer-2.5 | unslop + assemble | `todo.json`, `taste.md` |

Phase 1 stops after the news draft. Phase 3 reads unslop, merges agent recap (first capsule) with news, writes the todo, rewrites taste.

Cursor Desktop on this repo: follow the same phase order when compiling manually.

## Files

```
education/you@example.com/
  daily-briefing/
    meta.json          # timezone, 06:00 compile, 07:00 due
    profile.md         # standing context
    preferences.md     # written feedback (append-only)
    taste.md           # compact learned taste (rewrite each run)
  todos/<YYYY-MM-DD>-daily-briefing/todo.json
```

`meta.json`: `timezone` until the calendar date before `timezoneAfter.on`, then `timezoneAfter.timezone`. Compile `06:00`, due `07:00` in that zone.

## Phase 1: news draft

1. Resolve **today** from `meta.json` (the scheduler passes the date key; otherwise use the active timezone's current date).
2. Read `profile.md`, `preferences.md`, `taste.md`, and every user-level todo with `"kind": "dailyBriefing"` whose `dueDate` is in the last **7 days** (titles, bodies, votes).
3. Pick about 10 good stories. The beats below are interest guidelines, not a must-cover list. Do not invent news. Draft capsule titles and bodies.
4. Write `/tmp/yanylevin-daily-briefing-news-draft.json` with `{ "capsules": [...], "citations": [...] }`. News only. Do not write `todo.json`, `taste.md`, or agent recap.

## Phase 3: final todo (after agent recap + unslop)

Phase 3 assembles the final todo. Schema:

```json
{
  "name": "August 12th Daily Briefing",
  "kind": "dailyBriefing",
  "dueDate": "2026-08-12",
  "dueTime": "07:00",
  "done": false,
  "showInDates": false,
  "createdAt": "<ISO now>",
  "capsules": [
    {
      "id": "agent-recap",
      "category": "other",
      "title": "Agent Recap",
      "body": "URGENT:\n- ...\n\nActions:\n- ...\n\nOvernight recap prose.",
      "noVote": true,
      "vote": null
    },
    {
      "id": "short-kebab-slug",
      "category": "tech",
      "title": "Headline, sentence case",
      "body": "2–4 short factual sentences.",
      "vote": null,
      "citations": [
        { "name": "The Verge", "url": "https://www.theverge.com/..." }
      ]
    }
  ],
  "citations": [
    { "name": "Reuters", "url": "https://www.reuters.com/..." },
    { "name": "The Verge", "url": "https://www.theverge.com/..." }
  ]
}
```

- User-level only (no class/project). No `tag`. `showInDates: false`.
- **Agent recap** is always the first capsule: `id` `agent-recap`, `noVote: true`, no citations, no thumbs. See agent-recap skill for body sections (URGENT, Actions, general recap).
- Aim for about **10 news capsules** (roughly 9–12), plus agent recap. Quality over coverage. `id` unique within the day, kebab-case.
- `category`: `global` | `us` | `politics` | `wa` | `local` | `pop` | `tech` | `markets` | `other`
- `vote` always `null` on create for news capsules. **Thumbs are a 3-way rating:** `"up"` = more of this, `"down"` = less of this, `null` (neither thumb selected) = **neutral**. Neutral is a real rating, not missing data.
- Prefer commas/periods in titles and bodies. No school CW/HW/QA/MA tags.
- **Citations (required on news capsules).** Do not invent news or sources. Every news capsule needs `citations`. Top-level `citations` is every distinct news source, sorted alphabetically by `name`. Agent recap has no citations.

### Sources

Hard rule for compiling the brief **and** for any news follow-up / web search (Personal Agent included):

- **Use:** credible left-leaning outlets (NYT, Washington Post, NPR, The Atlantic, The Guardian, and similar) and credible independents / wires (AP, Reuters, BBC, ProPublica, Seattle Times, The Verge, Ars Technica, Bloomberg, and similar).
- **Right ceiling:** The Wall Street Journal is the most right-leaning source allowed (news reporting, not a Fox substitute).
- **Do not use** anything to the right of WSJ: NY Post, Newsmax, OANN, Daily Wire, Breitbart, Washington Examiner, National Review, Daily Caller, and similar.
- **Never Fox News**, Fox Business, Fox Nation, foxnews.com, or other Fox-branded / Fox-related news. Same parent company as WSJ does not make Fox OK.

### De-dupe

Do not repeat a prior day's topic/headline unless there is a real development. Then: one-line recap of what was already known, then what is new, labeled clearly (e.g. start the new part with "New:").

### Interest areas (guidelines, not a quota)

These are categories Yan is **generally** interested in. They are **not** a checklist: do not try to hit every item, and do not invent or stretch a story just to fill a slot. Rank by “would he actually want this this morning?” using profile, taste, and thumbs. Include a story that is **not** listed when it is real news and he would likely want it (life/work overlap is enough). Use the closest `category`, or `other`.

- Global breaking
- US breaking
- US politics, light, left-leaning, factual, not a rant or a full politics dump
- WA state (anything notable)
- Seattle / Kirkland / Eastside (Redmond, Sammamish, Bellevue, etc.)
- Major pop culture only
- **Tech companies of interest** (named as tech news he follows, not as a ticker). Keep this list distinct from holdings even though they overlap — he also invests in Apple / Rivian / Meta:
  Apple, Rivian, Meta; frontier AI: OpenAI, Anthropic, SpaceXAI; plus other significant tech (not limited to those names)
- **Holdings** (companies and ETFs Yan invests in; company/product/regulatory/earnings news, not a ticker tape). Keep this list distinct from tech-interest. Overlap is only Apple / Rivian / Meta; do not treat other holdings as tech-interest names:
  - **ETFs:** QQQ (Invesco QQQ), SPY (SPDR S&P 500) — only if a major index / mega-cap tech story *is* the news, not the daily close
  - **Companies:** AAPL (Apple), RIVN (Rivian), META (Meta), MSFT (Microsoft), GOOGL (Alphabet), AMZN (Amazon), LCID (Lucid), GSAT (Globalstar), SPCX (SpaceX / Space Exploration Technologies), ALK (Alaska Air), DIS (Disney), PFE (Pfizer), PEP (PepsiCo), BABA (Alibaba)
  - Skip cash / money-market. Skip day-to-day quotes, % moves, and “markets opened mixed.” Include a holdings story only when the news is material; omit otherwise. If a name is on both lists, one capsule — do not duplicate a tech story as a holdings story.
- Anything clearly relevant from `profile.md` / `taste.md`
- **Judgment call:** science, space, aviation, EVs, health, or other non-listed types when you think he would like the piece

While timezone is `America/Chicago`, include notable Texas items. After the Seattle switch, drop Texas unless it is major national news.

### Taste rewrite (phase 3)

After writing the todo, rewrite `taste.md` as a short rolling memo from **news capsule thumbs only** (not agent recap):

- More of / less of, from last week's thumbs: `"up"` = more, `"down"` = less, `null` (neither thumb) = **neutral** (keep similar coverage; do not treat as no feedback)
- Written notes in `preferences.md`
- Standing exclusions
- Keep it compact (aim under ~40 lines). Do not paste full articles.

## Written feedback (chat / Cursor)

When Yan says the briefing should change (more local, less politics, skip a beat, etc.):

1. Append a dated bullet to `preferences.md` (newest at the bottom).
2. Optionally fold it into `taste.md` immediately if the next morning is far away.
3. Do not retag briefing todos as schoolwork. Do not attach them to a class or project.

## Rebuild

Only overwrite today's `todo.json` when the user or runner explicitly asks to rebuild. Preserve existing capsule `vote` values when the same `id` is reused.
