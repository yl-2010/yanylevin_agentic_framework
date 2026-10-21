---
name: personal-canvas
description: >-
  Sync Yan's EPS Canvas into the education dashboard (assignments, syllabus
  dates, canvasLink), submit file/text/URL when Yan asks, pull teacher
  attachments into OneDrive todos. Nightly also dumps comments, pages,
  modules, and course files for agent context. Teacher comments also show
  on the todo page. Pages, modules, and course files stay off the UI. Yan only.
disable-model-invocation: true
---

# Canvas sync — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

EPS Canvas is `https://canvas.instructure.com`. A student API token lives in `server/.env` (`CANVAS_ACCESS_TOKEN`). Never print or commit the token.

This is an **agent sync**, not a hardcoded mapper. Read the snapshot, decide how dashboard classes line up with Canvas courses, then write education todos/dates. Nightly model: **grok-4.7 xhigh** (reasoning_effort=xhigh, fast=false, context=256k). Hourly model: **composer-2.5** (fast=false).

## When to run

- **Page open (Express, not you):** `/api/education/data?live=1` fetches submissions, planner complete, and grades for mapped courses and overlays `done` + `canvasWork` in the API. That does **not** write `todo.json`. You still never persist completion.
- **Checkoff (Express, not you):** Yan checking off a Canvas-linked todo writes a planner override (`marked_complete`) so Canvas To-Do matches. Local-only todos stay local. You still never POST planner overrides.
- **Submit (you, only when Yan says submit / turn in / upload this to Canvas):** identify the assignment, rename+store the chat file on OneDrive if he attached one, then `canvas-files.js submit` (file, `--text` / `--text-file`, or `--url`). Save / put this in / handle the file never submits. Ask only if the assignment is actually unclear.
- **Hourly:** Express runs a light fetch + this skill (mapped classes only, no new-class hunt) at **:00** in the briefing timezone, except the 01:00 nightly window. Restarts wait for the next :00. Writes `last-hourly-sync.json`. After the agent, Express pulls teacher files into OneDrive todos.
- **Nightly:** Express runs the full fetch + this skill at **01:00** (`nightlyAgentsLocalTime` in `education/you@example.com/daily-briefing/meta.json`). Same slot as location compose/enrichment. Context synthesis is later (02:30). Daily briefing is 06:00. **Re-read what hourly Composer wrote during the day and fix mistakes.** Fold new teacher comments into class/todo `CONTEXT.md`. Then Express pulls teacher files.
- **Manual (Personal Agent):** Yan says sync / pull / update Canvas. First fetch, then apply this skill **in this turn** (full nightly rules, including class map). Do not spawn a nested Cursor agent. After writes, Express pull still runs on the next hourly/fetch; you may also `canvas-files.js pull`.

```bash
node --env-file=server/.env server/canvas-sync.js --fetch-only
node --env-file=server/.env server/canvas-files.js submit --canvas-id 40335975
node --env-file=server/.env server/canvas-files.js submit --canvas-id 40335975 --file education/you@example.com/.chat-uploads/<session>/scan.pdf
node --env-file=server/.env server/canvas-files.js submit --canvas-id 40073386 --text "here is the paragraph"
node --env-file=server/.env server/canvas-files.js submit --canvas-id 40073386 --text-file /tmp/body.txt
node --env-file=server/.env server/canvas-files.js submit --canvas-id 40073386 --url https://example.com/doc
node --env-file=server/.env server/canvas-files.js comments --canvas-id 40335975
node --env-file=server/.env server/canvas-files.js store --src <path> --class physics --todo "HW Sep 17 Motion Diagram Warm-Up"
node --env-file=server/.env server/canvas-files.js pull
```

To run the background Grok job instead: `node --env-file=server/.env server/canvas-sync.js --force` from the repo root. Hourly Composer: `node --env-file=server/.env server/canvas-sync.js --hourly`.

If `.canvas/snapshot.json` is missing and the fetch CLI fails, say Canvas is not configured (token / network). Do not invent assignments.

## Files

```
education/you@example.com/.canvas/
  snapshot.json         # only dashboard / junior-year classes (assignments, events, syllabi)
  assignments.md        # readable index of that same subset
  comments.json / comments.md / comments-new.md
  pages.json / pages.md
  modules.json / modules.md
  files.json / files.md
  seen-comment-ids.json # Express marks after a successful nightly agent
  course-map.json       # Canvas course id → education class folder id (you maintain this on nightly; hourly must not edit it)
  last-agent-sync.json  # written by the nightly runner, not by you
  last-hourly-sync.json # written by the hourly Composer runner
  planner-overrides.json # Express: Canvas planner override ids after a checkoff

OneDrive <gradeFolder>/<onedriveFolder>/.education/
  class.json
  CONTEXT.md
<Finder todo folder>/.todo.json + student files + teacher attachments
  canvasFiles[] on .todo.json lists teacher attachment names (Express writes this)
<Finder date folder>/date.json + that date's files
```

Yan class trees live on OneDrive (see education-dashboard.md). Do not write `education/you@example.com/classes/<id>/` except `_example-dummy`.

Dashboard schema: `.cursor/skills/personal-agent/education-dashboard.md`.

## Hourly pass (Composer)

When the runner says hourly: **do not** map new classes, **do not** create class folders, **do not** edit `course-map.json`, **do not** mine syllabi, **do not** fold comments/pages/modules/files. Only create/update todos for snapshot assignments whose `courseId` is already in `course-map.json`. Same Adv Calc HW due shift, Data Science number/stat visual due (2026-10-06 13:50, canvasId 40073385), American Lit Venn due (2026-10-26 08:30, canvasId 40432088), yoga `hiddenFromHome`, tagging, and deleted.md rules. If nothing changed, stop.

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
- Create if none, unless it looks like a row in `education/you@example.com/deleted.md`. Judgement, not exact due clocks. `canvasId` is a strong hint; similar name + class in the same year is enough. Skip those. OneDrive folder name: `HW Sep 15 Title` (tag, due as `Mon D`, JSON name, spaces not kebab), unique in that class folder. Set `createdAt` now. `done: false` on create only. Express visibility sync will rename if the due date or title later changes.
- **Update** name, `dueDate`, `dueTime`, `tag`, `description`, `canvasLink`, `canvasId` when Canvas changed.
- Prefer snapshot `dueDate` / `dueTime` (already in the briefing timezone). Undated Canvas rows may omit due fields.
- **Advanced Calculus HW (Yan, 2026-09-10):** For `advanced-calculus` todos with `tag: "HW"`, do **not** use the Canvas due as the dashboard due. Canvas is typically two period-C meetings after the start day. Set `dueDate` / `dueTime` to the **previous** period-C meeting before Canvas due, at that day's C start from `schedule.json` (`bells` / `dayOverrides`). Match by `canvasId` first so a shifted due still updates the same todo. Do not pull those dues back to Canvas on later syncs. Leave MA / QA / CW on Canvas times. If Canvas due is not on a C meeting, leave Canvas times.
- **Data Science number/stat visual (Yan, 2026-10-02):** Canvas due for `Bring a number/stat/visual to class at least once` (`canvasId` 40073385) is end of term, 2026-11-18 23:59. Yan signed up to present the next Data Science class. Keep dashboard `dueDate` **2026-10-06** and `dueTime` **13:50** (period A start that day). Match by `canvasId`. Do not pull this due back to Canvas on later syncs.
- **American Literature Venn (Yan, 2026-10-19):** `canvasId` 40432088. Lunstrum extended it by email. Yan asked to turn the Venn in Monday. Keep dashboard `dueDate` **2026-10-26** and `dueTime` **08:30** (period E start that day). Match by `canvasId`. Do not pull this due back to Canvas 2026-10-20 13:50. If you rewrite the description, keep the extension line.
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

## Comments, pages, modules, course files

Full fetch (nightly, `--fetch-only`, manual sync) writes those dumps. Hourly does not. Pages, modules, and course files stay off `/education` and iOS. Teacher comments are the exception. The live overlay paints them on the todo page, on the same 10 second Canvas pull as grades. Do not copy comments into `todo.json` `description`. Do not download course-file dumps into OneDrive class folders (assignment attachments still use `canvas-files.js pull`).

**Comments.** The todo page shows teacher comments (not Yan's own). Read `comments.md` anytime Yan asks what a teacher said, or `canvas-files.js comments --canvas-id <id>` for a live pull. Nightly / manual: read `comments-new.md`. Fold new teacher comments into that class or todo OneDrive `CONTEXT.md` (hidden from tiles). Skip if that comment is already there. Skip Yan's own comments unless they matter. One short dated line per comment is enough (`2026-09-18 Seeley on Average Speed Write-up: …`).

**Pages and modules.** Read `pages.md` / `modules.md` when a todo is thin, locked, or clearly a module item. Copy a useful fact into class `CONTEXT.md` if it will help later (unit name, locked until score). Do not invent dates from every module item.

**Course files.** `files.md` is the Files tab index (`folder/name` plus `[file id]`). Use it to know a PDF exists. Do not create UI tiles from it.

## Submit (Personal Agent, Yan asked)

Turn in and save are different jobs.

**Turn in / submit / upload this to Canvas** (a file, a pasted paragraph, or a URL in this chat is enough; he does not have to name the assignment):

1. Identify the assignment. Prefer Live context (open todo/class). Then filename vs todo names, due-soon Canvas rows, the class he is in. Ask only if two assignments are equally plausible.
2. Look at snapshot `types` (or live assignment). File, text, and URL are different submits.
3. **File:** rename junk upload names (`Scanned Document 17.pdf`) to the Canvas assignment title, or the todo name if there is no Canvas title. Do not use the header printed on the sheet. Illegal filename characters (`/ : " ? *`) become spaces. Keep `#`, hyphens, and the extension. Store in that todo's OneDrive folder (`canvas-files.js store` or `submit --file`, which stores first). Then submit.
4. **Text:** `submit --text '…'` or `--text-file` when the assignment allows `online_text_entry` (History paragraphs, some Data Sci). Do not wrap it in a fake PDF if text is allowed.
5. **URL:** `submit --url https://…` when the assignment allows `online_url`.

```bash
node --env-file=server/.env server/canvas-files.js submit --canvas-id <id> --file <abs or repo-rel path>
node --env-file=server/.env server/canvas-files.js submit --canvas-id <id> --text 'the paragraph'
node --env-file=server/.env server/canvas-files.js submit --canvas-id <id> --text-file /tmp/body.txt
node --env-file=server/.env server/canvas-files.js submit --canvas-id <id> --url https://example.com/doc
```

No chat file and no text/URL: submit the student file already in that OneDrive folder. Skip `todo.json`, `CONTEXT.md`, and `canvasFiles` (teacher attachments). One leftover student file: submit it. None or two+: ask.

**Save / put this in / handle / store** (and any file request that does not say submit / turn in / upload to Canvas): identify the todo the same way, rename if needed, store on OneDrive. Stop. Do not call `submit`. If the destination is an existing Word, Excel, or PowerPoint file, do not store over it. Edit that file in the Office app with computer use and save from the app. A new Office file can be stored.

Homework goes on the todo that already exists. A new todo is rare. A scan of an MA or QA he already took goes on that earlier assessment todo, named like the Canvas title with MA or QA kept, and a copy goes in `education/tests/<class>/`. Do not make a new todo due today to hold the scan. Full rules are in the education-dashboard skill, Chat attachments.

```bash
node --env-file=server/.env server/canvas-files.js store --src <path> --canvas-id <id>
# or
node --env-file=server/.env server/canvas-files.js store --src <path> --class physics --todo "HW Sep 17 Motion Diagram Warm-Up"
```

If Canvas only accepts a quiz or on-paper (`unsupported` / `not-online-upload` with no text or URL type), tell Yan. Do not fake a file submit. A `need-text` or `need-url` result means ask him for the paragraph or link. Do not write `done` / `completedAt` into `todo.json`. The live overlay picks up `submitted`. Do not curl Canvas yourself.

## Teacher files (Express)

Hourly/nightly/fetch-only download assignment attachments into the matching OneDrive todo folder and record them on `.todo.json` `canvasFiles`. Leave that key alone. Those files show on the todo page because they sit in the OneDrive folder. They do not unhide the Finder folder. A Canvas download is not Yan starting the work. Do not submit them as Yan's work.

Spanish 4 skips pasted decoration images. Canvas names those `image-<uuid>` or `image.png` (emoji, clipart, logos). Do not download them, and delete one that is already in the folder. A real filename such as `lectura pagina 1.png`, and every PDF or doc, still downloads.

Junk Canvas names get renamed when they land. `image-` plus a uuid, `image-` plus a long random token, and scanner names like `Scanned Document 17.pdf` become the assignment title, with the original extension. A second junk file in that folder is `Title 2.png`. A real filename such as Ping Pong WS.pdf stays. Express does this on pull. Do not leave `image-<random>` in the todo folder. Spanish decoration images are the exception: drop them, do not retitle them into the folder.

## Never

- **Never** set or clear `done` or `completedAt` in todo.json from Canvas. Yan checks work off in yanylevin. Express overlays Canvas submitted/graded/planner-complete as `done` on `/api/education/data` without writing those keys. Express may POST/PUT Canvas planner overrides when Yan checks a Canvas-linked todo. An agent update must leave `done` / `completedAt` exactly as they are.
- **Never** POST/PUT/DELETE to Canvas from hourly/nightly sync. Checkoff write-back is Express only. Submit is Personal Agent only, when Yan asked, via `canvas-files.js submit`.
- **Never** delete an education todo/date because it disappeared from Canvas.
- **Never** recreate a todo/date Yan already deleted (`deleted.md`). Judgement, not exact clocks.
- **Never** touch fixtures (`"fixture": true` or ids starting `_example-`).
- **Never** put Canvas rows on projects or user-level todos. Class folders only.
- **Never** mix this with Fitness OS gym logs.
- **Never** put Canvas comments, pages, modules, or course-file dumps on the education UI.

## OneNote links

Tag does not matter. CW, HW, QA, MA, or no tag. If Yan would open that Class Notebook page to do the todo, link it on that todo.

How to open notebooks, sign in, and read pages is [personal-onenote](../personal-onenote/SKILL.md). Follow that. A signed-out `status` means run `login`, then list sections and pages. Leave existing OneNote sites alone only if login itself fails. Do not run `link-todos`. That command scores titles in code and misses real pages.

Seen page ids live in `education/you@example.com/.canvas/onenote-seen.json`:

```json
{ "pages": { "<pageId>": { "title": "Day 1 problem set", "notebook": "Advanced Calculus 26-27" } } }
```

That file is a memory of pages already considered. If it is missing, nothing has been considered. Pass 1 is not empty. Also look at todos created or due on or after 2026-10-08 that still have no OneNote site. After you write the file, later nights use the normal two passes. Leave a todo alone when no page applies.

Pass 1, new pages. A page id that is not in `onenote-seen.json` is new. For each new page, look at every todo in that class. Any tag, any due date. Link the page on each todo it applies to.

Pass 2, todos. Take every todo created tonight, and every todo whose `dueDate` is today through 14 days out in the sync timezone. Done or not. Any tag. For each of those, look through that class notebook for pages that apply, including pages already in `onenote-seen.json`. Link every page that applies.

- Yan's page. `name` is the assignment name. `oneNote` is `personal`.
- Teacher page. `name` is `Content Library: ` plus the page title. `oneNote` is `content-library`.

Copy `url` from the page `webUrl` (https) and `clientUrl` from the page (`onenote:`). Store `pageId` from the page `id`. The same page can sit on every todo it applies to. Do not cap how many OneNote sites a todo has. Skip a `pageId` already on that todo. Do not remove an existing OneNote site because this pass did not mention it. Keep every site whose `oneNote` is not `personal` or `content-library`. Do not put these URLs in `description`. A path in the description is not the link. When the Canvas description names a Content Library page, that page applies. Spanish writes that as Biblioteca de contenido, then the section, then the page title (`Pruebas / MA #1: ESCRITO - GUÍA DE ESTUDIO`). After both passes, rewrite `onenote-seen.json` from the pages you listed. Hourly Composer does not do this.

## Files from another todo

After that todo's own OneNote sites, look at the other todos in the same class. Read the files in each sibling folder and the OneNote pages on that sibling's `sites`. If Yan would open that same doc while doing this todo, add a pointer on this todo's `linkedFiles`. The file stays in the folder it already lives in.

Tag does not matter here either. Prep for another assignment in the class counts, whatever the tags are. The todo that needs the doc stores the pointer, so the website and the iPhone show the same Word or OneNote button.

```json
"linkedFiles": [
  { "todo": "MA Oct 7 American Dream Epigraphic In-class Essay", "canvasId": "40000000", "name": "American Dream Essay.docx" },
  { "todo": "MA Oct 7 American Dream Epigraphic In-class Essay", "canvasId": "40000000", "pageId": "1-abc" }
]
```

`name` is one file in the other todo's folder. `pageId` is a OneNote site already on that other todo. `canvasId` is how a later night finds the folder after a rename. `todo` is the Finder folder id without a leading dot, used when there is no Canvas id.

Write the pointer on the todo that needs the doc. A shared draft, outline, or problem set counts. An unrelated worksheet does not. Drop a pointer when the file is gone or this todo no longer uses that doc. Do not move or copy the file. Do not edit `canvasFiles`. A linked OneNote page does not replace sites you already wrote on this todo. If the page applies here, pass 1 or pass 2 already wrote the site. `pageId` on `linkedFiles` is only the extra button when the site stays on the other todo.

Teacher files Express downloads after you finish are not on disk yet. Link those on the next night. Hourly Composer does not write `linkedFiles`.

## Nightly review of hourly Composer

Read `last-hourly-sync.json`. Walk mapped class todos against the **full** snapshot. Fix wrong tags, `HW:` prefixes left on names, Adv Calc HW dues pulled back to Canvas time, the American Lit Venn due pulled back to 2026-10-20, yoga CW `hiddenFromHome`, missing `canvasId`/`canvasLink`, duplicates, and course-map drift. Then do the usual full map (new junior-year courses may have appeared). Then fold `comments-new.md` into class/todo `CONTEXT.md` as above.

## After writes

Education file watcher refreshes `/education`. Prefer committing `education/you@example.com/` when the nightly runner did not already. Manual chat: 1–3 short lines (`Synced Canvas into Lit, Physics, and Spanish`).
