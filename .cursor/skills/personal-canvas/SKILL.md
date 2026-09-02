---
name: personal-canvas
description: >-
  Sync Yan's EPS Canvas into the education dashboard (assignments, syllabus
  dates, canvasLink). Nightly Grok job and manual "sync Canvas" turns.
  Yan only — never for Alex.
disable-model-invocation: true
---

# Canvas sync — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

EPS Canvas is `https://canvas.instructure.com`. A student API token lives in `server/.env` (`CANVAS_ACCESS_TOKEN`). Never print or commit the token.

This is an **agent sync**, not a hardcoded mapper. Read the snapshot, decide how dashboard classes line up with Canvas courses, then write education todos/dates. Model for the nightly job: **grok-4.6 high** (effort=high, fast=false).

## When to run

- **Nightly:** Express runs fetch + this skill at **01:00** (`nightlyAgentsLocalTime` in `education/you@example.com/daily-briefing/meta.json`). Same slot as location compose/enrichment. Context synthesis is later (02:30). Daily briefing is 06:00.
- **Manual (Personal Agent):** Yan says sync / pull / update Canvas. First fetch, then apply this skill **in this turn**. Do not spawn a nested Cursor agent.

```bash
node --env-file=server/.env server/canvas-sync.js --fetch-only
```

To run the background Grok job instead: `node --env-file=server/.env server/canvas-sync.js --force` from the repo root.

If `.canvas/snapshot.json` is missing and the fetch CLI fails, say Canvas is not configured (token / network). Do not invent assignments.

## Files

```
education/you@example.com/.canvas/
  snapshot.json         # only dashboard / junior-year classes (assignments, events, syllabi)
  assignments.md        # readable index of that same subset
  course-map.json       # Canvas course id → education class folder id (you maintain this)
  last-agent-sync.json  # written by the nightly runner, not by you
education/you@example.com/classes/<classId>/
  class.json
  todos/<todoId>/todo.json
  dates/<dateId>/date.json
```

Dashboard schema: `.cursor/skills/personal-agent/education-dashboard.md`.

## Map courses first

1. Read `classes/*/class.json` (skip `_example-dummy`, skip `"freePeriod": true`).
2. Read `course-map.json` if present.
3. Match Canvas `courses[]` to those folders by name / course code (American Literature, Physics, Spanish 4, Data Science, US History, Calc, programming titles, PE Yoga, Independent Study, and similar). Fetch still asks Canvas for current and future enrollments, then **drops** anything that is not a dashboard class before writing the snapshot (9th/10th-year shells, Class of 2028, EPS Library, Iceland EBC, Graphic Design, clubs, advisory). Update `course-map.json` when you are confident.
4. **Skip** any leftover Canvas course with no dashboard class. Do not create new class folders from Canvas. Do not store or import extras.
5. If two dashboard classes could match one Canvas course, pick the obvious one or skip that course rather than guessing into the wrong folder.
6. For each mapped class, set `canvasLink` on `class.json` to `{htmlUrl}/grades` (example `https://canvas.instructure.com/courses/3639020/grades`). The **web** class page shows the Canvas orb from this. Do not add an iOS class-view button.

## Stop early (junior year not on Canvas yet)

Yan is a **2026-27 junior**. Those academic dashboard classes (American Literature, Physics, Spanish 4, Data Science, US History, Advanced Calculus, programming, PE Yoga, Independent Study, and similar) are often **not published on Canvas yet**. That is expected. Nightly fetch will keep checking.

Class of 2028, EPS Library, Iceland EBC, Graphic Design, and 9th/10th-year shells are **not** substitutes.

After the map step: if **zero** real dashboard classes match a Canvas course, **stop immediately**. Do not read syllabi, do not create todos or dates, do not import extras to look busy. The runner also skips spawning this agent when nothing maps, so a quiet night is only the HTTP fetch. One short reply is enough (`Junior year courses still not in Canvas`).

When at least one class maps, sync **only** those mapped classes and continue below.

## Assignments → todos

For every snapshot assignment whose `courseId` is mapped:

- Match an existing todo in that class by `canvasId`, then `canvasLink`, then same **name + parent + dueDate**.
- **Create** if none, unless it looks like a row in `education/you@example.com/deleted.md`. Judgement, not exact due clocks. `canvasId` is a strong hint; similar name + class in the same year is enough. Skip those. Folder id: kebab of the title, unique in that class `todos/`. Set `createdAt` now. `done: false` on create only.
- **Update** name, `dueDate`, `dueTime`, `tag`, `description`, `canvasLink`, `canvasId` when Canvas changed.
- Prefer snapshot `dueDate` / `dueTime` (already in the briefing timezone). Undated Canvas rows may omit due fields.
- **Always** set `canvasLink` to the assignment `htmlUrl`.
- **Always** set `canvasId` to the Canvas assignment id (number or string).
- **Always** tag schoolwork: `CW` | `HW` | `QA` | `MA` (do not leave mapped assignments untagged).
  - Quiz / check / reading quiz / `online_quiz` → `QA`
  - Test, exam, essay, paper, project, presentation, lab, performance → `MA`
  - In-class / classwork → `CW`
  - Default take-home work → `HW`
  - High point values that look summative → `MA`
- MA still defaults `showInDates` on; do not turn that off unless Yan asked.
- Copy a short markdown `description` from the snapshot when it helps (education-dashboard Description formatting: bold lead-ins, bullets, links). Do not dump the whole syllabus into every todo.

## Syllabus and other dates → date.json

Read each mapped course `syllabus` plus snapshot `events[]`. Create/update **important dates** (exams, concerts, trips, conferences, no-school mentioned in the syllabus, unit tests called out as calendar events). Skip routine class meetings.

- Match by `canvasId` / `canvasLink` / same name+date in that class `dates/`. Also treat **similar names** on that date as the same event (advisor/advisory, stripped years). Update in place; never a second slug.
- Skip create if the date looks like a `deleted.md` row (same judgement as todos).
- Set `date`, optional `time`, markdown `description` when there are real facts, `canvasLink` (event url or course `syllabusUrl`), optional `canvasId`.
- Do not turn syllabus fluff into dates.

## Never

- **Never** set or clear `done` or `completedAt` from Canvas. Yan checks work off in yanylevin. An update must leave those keys exactly as they are.
- **Never** POST/PUT/DELETE to Canvas. Read-only.
- **Never** delete an education todo/date because it disappeared from Canvas.
- **Never** recreate a todo/date Yan already deleted (`deleted.md`). Judgement, not exact clocks.
- **Never** touch fixtures (`"fixture": true` or ids starting `_example-`).
- **Never** put Canvas rows on projects or user-level todos. Class folders only.
- **Never** mix this with Fitness OS gym logs.

## After writes

Education file watcher refreshes `/education`. Prefer committing `education/you@example.com/` when the nightly runner did not already. Manual chat: 1–3 short lines (`Synced Canvas into Lit, Physics, and Spanish`).
