---
name: ap-study
description: >-
  Yan's daily 30-minute AP study packets for Calc BC, Physics C: Mechanics,
  AP Literature, Physics 2, and US History. Use when he asks how an AP is
  going, wants a packet graded, wants to skip a day, mark a topic known, or
  shift time toward one exam.
---

# AP study

Yan only. One 30-minute PDF a day, written on with a stylus in the school OneNote notebook **AP Study 2026-27**. The 04:00 job grades the last few days, plans the day, writes the packet, and puts it on a page. The key and feedback land the next morning, under that day's page.

Do not generate a week of packets ahead. Tomorrow's packet is supposed to see today's ink.

## Where things live

Data, not in git:

`/Users/you/Library/CloudStorage/OneDrive-Personal/Projects/.backend/ap-study/`

- `learner/model.json` is mastery, learn rate, and the next review date per topic
- `learner/insights/<exam>.md` is the grader's notes on how he learns that exam
- `preferences.md` is free text the packet writer reads (more FRQs, shorter learn cards)
- `overrides.json` is `paused`, `skipDates`, `skipDiagnostics`, and `boost`
- `days/<date>/` is that day's plan, packet, PDFs, and grade
- `status.json` is what the Daily Briefing line reads

Exams: `physics-2`, `physics-c-mech`, `us-history`, `lit`, `calc-bc`. Topic keys look like `calc-bc:10.1`.

## Commands

From the repo root. Add `--env-file=server/.env` when the command talks to OneNote (`syllabi`, `publish`, `grade`, `run`, `pace`, `ink-check`).

```bash
node server/ap-study.js status
node server/ap-study.js grade --date 2026-11-24
node server/ap-study.js run --date 2026-11-25
node --env-file=server/.env server/ap-study.js know --topic calc-bc:10.1 --topic calc-bc:10.2
```

`grade` reads the ink and posts the key. Say you graded it, and the percent. A page with no ink is a missed day, not a zero.

`run` is the nightly job. Use it when a morning packet never showed up. It will not rewrite a day that is already in OneNote.

## What he asks

**How am I doing.** Read `status` and `learner/insights/<exam>.md`. Answer with the exam, topics introduced against the calendar, and the weak spots. Do not dump the model.

**I already know X.** `know --topic` for each CED topic that matches. Then one line in that exam's insights file, dated, saying he said so.

**More Physics 2 this week.** Set `overrides.json` `boost` to `{ "exam": "physics-2", "until": "<Sunday>" }`. Also add a line to `preferences.md` if the ask is about the kind of problems, not the time.

**Skip Saturday.** Append that date to `skipDates`. **Pause** sets `paused` true. **Resume** sets it false and clears `boost` if he is done with it.

**Grade my AP packet.** Run `grade` for the date he means, today if he doesn't say. Do not wait for 04:00.

Week 1 diagnostics are fixed: Nov 24 Physics 2, Nov 25 US History, Nov 26 Physics C, Nov 27 Literature, Nov 28 Calc BC. After that the calendar in `calendar.json` decides the month, and the nightly job decides the day.
