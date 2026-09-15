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

This is an **agent sync**, not a hardcoded mapper. Read the snapshot, decide how dashboard classes line up with Canvas courses, then write education todos/dates. Nightly model: **grok-4.6 xhigh** (effort=xhigh, fast=false). Hourly model: **composer-2.5** (fast=false).

## When to run

- **Page open (Express, not you):** `/api/education/data?live=1` fetches submissions, planner complete, and grades for mapped courses and overlays `done` + `canvasWork` in the API. That does **not** write `todo.json`. You still never persist completion.
- **Checkoff (Express, not you):** Yan checking off a Canvas-linked todo writes a planner override (`marked_complete`) so Canvas To-Do matches. Local-only todos stay local. You still never POST to Canvas.
- **Hourly:** Express runs a light fetch + this skill (mapped classes only, no new-class hunt) at **:00** in the briefing timezone, except the 01:00 nightly window. Restarts wait for the next :00. Writes `last-hourly-sync.json`.
- **Nightly:** Express runs the full fetch + this skill at **01:00** (`nightlyAgentsLocalTime` in `education/you@example.com/daily-briefing/meta.json`). Same slot as location compose/enrichment. Context synthesis is later (02:30). Daily briefing is 06:00. **Re-read what hourly Composer wrote during the day and fix mistakes.**
- **Manual (Personal Agent):** Yan says sync / pull / update Canvas. First fetch, then apply this skill **in this turn** (full nightly rules, including class map). Do not spawn a nested Cursor agent.

```bash
node --env-file=server/.env server/canvas-sync.js --fetch-only
```

To run the background Grok job instead: `node --env-file=server/.env server/canvas-sync.js --force` from the repo root. Hourly Composer: `node --env-file=server/.env server/canvas-sync.js --hourly`.

If `.canvas/snapshot.json` is missing and the fetch CLI fails, say Canvas is not configured (token / network). Do not invent assignments.

## Files

```
education/you@example.com/.canvas/
  snapshot.json         # only dashboard / junior-year classes (assignments, events, syllabi)
  assignments.md        # readable index of that same subset
  course-map.json       # Canvas course id → education class folder id (you maintain this on nightly; hourly must not edit it)
  last-agent-sync.json  # written by the nightly runner, not by you
  last-hourly-sync.json # written by the hourly Composer runner
  planner-overrides.json # Express: Canvas planner override ids after a checkoff

OneDrive <gradeFolder>/<onedriveFolder>/.education/
  class.json
  todos/<todoId>/todo.json
  dates/<dateId>/date.json
```

Yan class trees live on OneDrive (see education-dashboard.md). Do not write `education/you@example.com/classes/<id>/` except `_example-dummy`.

Dashboard schema: `.cursor/skills/personal-agent/education-dashboard.md`.

## Hourly pass (Composer)

When the runner says hourly: **do not** map new classes, **do not** create class folders, **do not** edit `course-map.json`, **do not** mine syllabi. Only create/update todos for snapshot assignments whose `courseId` is already in `course-map.json`. Same Adv Calc HW due shift, yoga `hiddenFromHome`, tagging, and deleted.md rules. If nothing changed, stop.

## Map courses first (nightly / manual only)

1. Read each class `.education/class.json` on OneDrive (skip `_example-dummy`, skip `"freePeriod": true`).
2. Read `course-map.json` if present.
3. Match Canvas `courses[]` to those folders by name / course code (American Literature, Physics, Spanish 4, Data Science, US History, Calc, programming titles, PE Yoga, Independent Study, and similar). Fetch still asks Canvas for current and future enrollments, then **drops** anything that is not a dashboard class before writing the snapshot (9th/10th-year shells, Class of 2028, EPS Library, Iceland EBC, Graphic Design, clubs, advisory). Update `course-map.json` when you are confident.
4. **Skip** any leftover Canvas course with no dashboard class. Do not create new class folders from Canvas. Do not store or import extras.
5. If two dashboard classes could match one Canvas course, pick the obvious one or skip that course rather than guessing into the wrong folder.
6. For each mapped class, set `canvasLink` on `class.json` to `{htmlUrl}/grades` (example `https://canvas.instructure.com/courses/3639020/grades`). Web and iOS class pages show the Canvas orb from this.

## Stop early (junior year not on Canvas yet)

Yan is a **2026-27 junior**. Those academic dashboard classes (American Literature, Physics, Spanish 4, Data Science, US History, Advanced Calculus, programming, PE Yoga, Independent Study, and similar) are often **not published on Canvas yet**. That is expected. Nightly fetch will keep checking.

Class of 2028, EPS Library, Iceland EBC, Graphic Design, and 9th/10th-year shells are **not** substitutes.

After the map step: if **zero** real dashboard classes match a Canvas course, **stop immediately**. Do not read syllabi, do not create todos or dates, do not import extras to look busy. The runner also skips spawning this agent when nothing maps, so a quiet night is only the HTTP fetch. One short reply is enough (`Junior year courses still not in Canvas`).

When at least one class maps, sync **only** those mapped classes and continue below.

## Assignments → todos

For every snapshot assignment whose `courseId` is mapped:

- Match an existing todo in that class by `canvasId`, then `canvasLink`, then same **name + parent + dueDate**.
- Create if none, unless it looks like a row in `education/you@example.com/deleted.md`. Judgement, not exact due clocks. `canvasId` is a strong hint; similar name + class in the same year is enough. Skip those. Folder id: kebab of the title, unique in that class folder. Set `createdAt` now. `done: false` on create only.
- **Update** name, `dueDate`, `dueTime`, `tag`, `description`, `canvasLink`, `canvasId` when Canvas changed.
- Prefer snapshot `dueDate` / `dueTime` (already in the briefing timezone). Undated Canvas rows may omit due fields.
- **Advanced Calculus HW (Yan, 2026-09-10):** For `advanced-calculus` todos with `tag: "HW"`, do **not** use the Canvas due as the dashboard due. Canvas is typically two period-C meetings after the start day. Set `dueDate` / `dueTime` to the **previous** period-C meeting before Canvas due, at that day's C start from `schedule.json` (`bells` / `dayOverrides`). Match by `canvasId` first so a shifted due still updates the same todo. Do not pull those dues back to Canvas on later syncs. Leave MA / QA / CW on Canvas times. If Canvas due is not on a C meeting, leave Canvas times.
- **P.E. Yoga CW (Yan, 2026-09-10):** Routine yoga classworks (prep/participation, titles like `Yoga Class #N`) get `hiddenFromHome: true`. They stay on the yoga class page. Do not hide if the assignment is actually something to submit (survey, write-up, student-led session, anything that is not the usual show-up-and-participate CW). On later syncs, set `hiddenFromHome: true` on those routine CWs when the key is missing. If it is already `false`, leave it (Yan unhid that one). Leave MA / HW / QA on home.
- **Always** set `canvasLink` to the assignment `htmlUrl`.
- **Always** set `canvasId` to the Canvas assignment id (number or string).
- **Always** tag schoolwork: `CW` | `HW` | `QA` | `MA` (do not leave mapped assignments untagged).
  - Quiz / check / reading quiz / `online_quiz` → `QA`
  - Test, exam, essay, paper, project, presentation, lab, performance → `MA`
  - In-class / classwork → `CW`
  - Default take-home work → `HW`
  - High point values that look summative → `MA`
- Store `name` **without** a CW/HW/QA/MA prefix. Canvas `HW: Signed Syllabus` becomes `Signed Syllabus`. Keep `#F2` / `Final` after the tag (`MA #F2: Forces` → `#F2: Forces`). The dashboard paints the tag in blue next to the title.
- MA still defaults `showInDates` on; do not turn that off unless Yan asked.
- Copy a short markdown `description` from the snapshot when it helps (education-dashboard Description formatting: bold lead-ins, bullets, links). Do not dump the whole syllabus into every todo.

## Syllabus and other dates → date.json

Read each mapped course `syllabus` plus snapshot `events[]`. Create/update **important dates** (exams, concerts, trips, conferences, no-school mentioned in the syllabus, unit tests called out as calendar events). Skip routine class meetings.

- Match by `canvasId` / `canvasLink` / same name+date in that class folder. Also treat **similar names** on that date as the same event (advisor/advisory, stripped years). Update in place; never a second slug.
- Skip create if the date looks like a `deleted.md` row (same judgement as todos).
- Set `date`, optional `time`, markdown `description` when there are real facts, `canvasLink` (event url or course `syllabusUrl`), optional `canvasId`.
- Do not turn syllabus fluff into dates.

## Never

- **Never** set or clear `done` or `completedAt` in todo.json from Canvas. Yan checks work off in yanylevin. Express overlays Canvas submitted/graded/planner-complete as `done` on `/api/education/data` without writing those keys. Express may POST/PUT Canvas planner overrides when Yan checks a Canvas-linked todo. An agent update must leave `done` / `completedAt` exactly as they are.
- **Never** POST/PUT/DELETE to Canvas. Read-only. Checkoff write-back is Express only.
- **Never** delete an education todo/date because it disappeared from Canvas.
- **Never** recreate a todo/date Yan already deleted (`deleted.md`). Judgement, not exact clocks.
- **Never** touch fixtures (`"fixture": true` or ids starting `_example-`).
- **Never** put Canvas rows on projects or user-level todos. Class folders only.
- **Never** mix this with Fitness OS gym logs.

## Nightly review of hourly Composer

Read `last-hourly-sync.json`. Walk mapped class todos against the **full** snapshot. Fix wrong tags, `HW:` prefixes left on names, Adv Calc HW dues pulled back to Canvas time, yoga CW `hiddenFromHome`, missing `canvasId`/`canvasLink`, duplicates, and course-map drift. Then do the usual full map (new junior-year courses may have appeared).

## After writes

Education file watcher refreshes `/education`. Prefer committing `education/you@example.com/` when the nightly runner did not already. Manual chat: 1–3 short lines (`Synced Canvas into Lit, Physics, and Spanish`).
