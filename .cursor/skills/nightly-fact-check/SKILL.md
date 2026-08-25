---
name: nightly-fact-check
description: >-
  After both 03:00 brain jobs finish: Grok 4.6 xhigh verifies overnight
  agent facts against source dumps before the 06:00 briefing. Yan only.
  Not news, not agent-recap.
disable-model-invocation: true
---

# Nightly fact-check — Yan only

**Gate:** Yan (`you@example.com`) only.  Never spawn a cloud agent. Local only.

You run as soon as both 03:00 location-brain and health-brain finish. The 06:00 briefing is not your job. Leave identity, people cards, journal, location, and health accurate so recap can trust them.

Model: **grok-4.6 xhigh** (effort=xhigh, fast=false).

## Goal

Every claim overnight agents wrote tonight should match the source. Fix what is wrong. Do not audit Example Friend's entire historical card.

## Scope

Verify:

- Git-visible writes from tonight's jobs under `education/you@example.com/brain/` (`identity.md`, `identity-school.md`, `identity-accounts.md`, `identity-logistics.md`, `patterns.md`, `health.md`, `threads/`, tonight's journal `journal/<dateKey minus 1 day>.md`, entity cards phase 2 touched), `location/places.md` + `trips.md`, `health/takeaways.md`, education `date.json` / `todo.json` if phase 4 or Canvas wrote them.
- `[iMessage]` / `[mail]` timeline lines dated today or yesterday, even if a chat-time write put them there earlier. Standing and identity lines that restate those facts.
- `brain/state.json` `notes` when they restate facts.

Skip: generated `people/index.md`, `people/graph.md`, `brain/education/**`, chat titles, raw GPS/health JSON, news capsules, the briefing todo (it does not exist yet).

Find tonight's files with `git log` / `git diff` on those trees since 01:00 local, plus `git status`.

## Speaker (the 1:1 trap)

In a 1:1, JSON `handle` and `chatId` are the other person even on Yan's texts. Speaker is `who` (`yan` / `them` / a group handle) or `fromMe`. Never treat `handle` or "this line sits on Nikita's card" as speaker.

If a card, identity, org, or journal says someone claimed a thing, re-query the thread:

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/imessage/thread?person=%2B12066976688&limit=1024"
```

Use the phone from the person card, not the Contacts display name. Prefetch `/tmp/yanylevin-context-imessage.json` is the same JSON if the cursor still covers the window.

A fact on `people/<slug>/` with no "Yan said" reads as something they said. If `who=yan` / `fromMe=true`, rewrite Standing to "Yan told them …" and append a timeline correction. Same for identity/org copies ("Yan and Nikita say" when only Yan said it).

## Timezone

- Job clock is `daily-briefing/meta.json`: `America/Chicago` until 2026-08-27, then `America/Los_Angeles`.
- iMessage JSON `at` is UTC with no `Z` (`2026-08-24 06:33:25` = 01:33 CT). Convert before calling a time or journal day wrong.
- Health standing zone is `America/Los_Angeles`. Austin workouts after 2026-08-12 through 2026-08-26 use `America/Chicago`. `workouts.md` times are already adjusted; takeaways/identity must match that, not a second conversion.
- `timezoneAfter` and Airbnb checkout are not a boarding pass. A travel date is the itinerary's fly day.

## Mail (the since-cursor trap)

Overnight triage only scans Inbox since `mailSince`. Standing logistics live in older mail. You still have to check them.

Re-open Mail.app (personal-mail skill) or `/tmp/yanylevin-apple-mail-export` when tonight's writes mention mail, a flight, a refund, a booking, an itinerary, or say something is "not in mail" / "no flight number." A quiet overnight Inbox is not proof the confirmation does not exist.

Round-trip confirmations: read every leg, not the subject-line outbound. A Tesla subject that says "processing" can still post a refund line in the same body. Search Exchange first, then Google, then iCloud. Do not stop at the since-cursor window.

## How to correct

Read `education/you@example.com/brain/schema.md` first.

| Kind | Where | How |
| --- | --- | --- |
| Standing / identity compiled truth | Frontmatter and Standing, or `identity.md` / `identity-school.md` / `identity-accounts.md` / `identity-logistics.md` | Rewrite the current line. Do not append into a mega-bullet. Bump `last_touched` on entity cards. |
| Dated event already on a timeline | Same card, below `<!-- timeline -->` | Append `- YYYY-MM-DD \| correction [source]`. Do not edit or delete old rows. |
| Tonight's journal | `journal/<dateKey minus 1>.md` | Same-night edit is allowed (the 02:30 pass just wrote it). |
| Older journals | leave them | Note the miss on identity/Standing. |
| Named stay / trip | `location/places.md` / `trips.md` | Rewrite the line. Keep arrive/leave/dwell. |
| Health standing | `brain/health.md` | Rewrite the compiled bullet. Do not dump takeaways. |

Then `node server/brain-graph.js` if frontmatter changed (the wrapper also runs it).

Do not invent facts. If the dump is gone and the live thread does not cover it, leave the line and say so in `notes.factCheck`.

## state.json

Keep `lastSynthesisAt`, `lastSynthesisDateKey`, `timezone`, and `cursors`. Set `notes.factCheck` to a short list of what you fixed, or that nothing was wrong. The wrapper sets `factCheck.lastAt` / `lastDateKey` after you finish.

## Anti-patterns

- Compiling news or writing the briefing todo
- Treating `handle` as speaker in a 1:1
- Reading JSON `at` as Chicago or Seattle local
- Treating `timezoneAfter` or checkout as the flight date
- Treating "no new mail since cursor" as "this booking is not in mail"
- Editing last week's journal
- Touching generated index/graph/education mirror
- Git commit (the Node wrapper does that)
- Pasting full texts or secrets into cards

## Verify

Wrong speakers, times, and mail-sourced logistics (flights, refunds, bookings) are corrected. `notes.factCheck` exists. Reply with what you fixed (or that the night was clean).
