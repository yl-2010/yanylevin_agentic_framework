# Education dashboard context

Read this file only when the turn is about the **/education** dashboard (classes, todos, dates, projects, school attachments, OneDrive school files). This is **not** a skill and is **not** widget/mail/news-compile instructions.

Schedule files (weekly PDF / `schedule.json` / bells): Read `.cursor/skills/class-schedule/SKILL.md`. Past chats: `.cursor/skills/past-chats/SKILL.md`.

The live UI is `yanylevin.com/education` (`education/index.html`, `education/app.js`, `education/styles.css`, `education/chatbot.js`, `education/markdown.js`). Data lives under `education/<email>/`. Express `/api/education/data` (not this agent) is what the page reads. Git does not auto-deploy. If you change those UI files, run `npm run deploy:web` after push. Skip the deploy for `education/<email>/` data-only edits.

Allowed users and write scope are in `.cursor/skills/personal-agent/SKILL.md`. Never delete fixture objects (`"fixture": true` or ids starting with `_example-`). Fixtures are hidden from `/api/education/data`; keep them on disk as the layout reference.

## File schema

Canonical schedule files live in `.cursor/skills/class-schedule/SKILL.md` (weekly PDF + `education/<email>/schedule.json`).

```
education/<email>/
  meta.json                 # gradeFolder, onedriveRoot, optional hiddenFiles / visibleFiles / filesTop / filesBottom for user-level dropped files
  schedule.json             # bells + weekdayPeriods + closedDates (from PDF)
  deleted.md                # agent-only: objects this user deleted on purpose; nightly jobs skip recreating them
  .chat-history/            # Personal Agent transcripts (listed in the chat UI unless visibility: hidden)
  .chat-uploads/            # attachment staging (expires with session)
  # optional user-level dropped files sit here (not a context/ subfolder)
  todos/<todoId>/todo.json + optional dropped files
  dates/<dateId>/date.json + optional dropped files
  daily-briefing/           # Yan only: meta.json, profile.md, preferences.md, taste.md
  location/                 # Yan only: GPS stays/trips (not a dashboard object)
  classes/<classId>/
    class.json + optional dropped files
    todos/<todoId>/todo.json + optional dropped files
    dates/<dateId>/date.json + optional dropped files
  projects/<projectId>/
    project.json + optional dropped files (e.g. CONTEXT.md, hidden from UI by default)
    todos/<todoId>/todo.json + optional dropped files
    dates/<dateId>/date.json + optional dropped files
```

**Hard rule:** exactly one properties JSON per object folder. New fields = new keys in that JSON, never sidecar property files. Dropped context files sit directly in the object folder (alongside the JSON) — no `context/` subfolder.

**Context file visibility:** dashboard file tiles omit some dropped files; bytes stay in the same folder. Do not delete the file or rename to a dotfile.

- **`context.md` (any case, including `CONTEXT.md`)** is hidden by default on every class / project / todo / date / user-level folder. That file is for the model, not the app UI. Writing one does **not** need a JSON change.
- **`deleted.md`** is hidden from tiles the same way. It lives at the user root (`education/<email>/deleted.md`). Do not put it in an object folder.
- **`hiddenFiles`:** optional string array on `class.json`, `project.json`, `todo.json`, `date.json`, or `meta.json` (user-level). Each entry is a dropped-file basename (e.g. `"worksheet.pdf"`). Use when the user asks to hide a file that would otherwise show. Matching is case-insensitive.
- **`visibleFiles`:** optional string array on the same JSON. Shows a file that would otherwise be hidden, including `CONTEXT.md` if the user asks to see it. Wins over `hiddenFiles` and over the context.md default. Unhide by adding the basename here; hide context.md again by removing it from `visibleFiles`.
- **File tile order (web + iOS):** default is newest filesystem mtime first (same mtime, then A-Z). Override per folder with two optional string arrays on the same JSON. Array order is the pin order.
  - **`filesTop`:** stuck to the top of the tile list, in this order
  - **`filesBottom`:** stuck to the bottom, in this order
  - Everything not listed stays in the middle, still newest-mtime first
  - Matching is case-insensitive. Missing names are skipped. A name in both lists stays on top. Hidden files stay hidden even if pinned. Omit the key when the list is empty (do not leave `[]`).

### Properties

- **class.json:** `name`, `period` (A–H letter), `trimester`, optional `description` (always markdown when set), optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays — dashboard file-tile visibility and pin order; `context.md` is hidden by default), optional extras
  - `trimester`: `"year"` (always visible), `"fall"` | `"winter"` | `"spring"` (one tri), or an array like `["fall", "spring"]` for multi-tri but not year-long
  - Year-long folders + context stay on disk all year
  - Trimester-only classes stay on disk forever (never delete)
  - Visibility is enforced by the Express `/api/education/data` payload (out-of-season classes omitted; `trimester` / `schedule.trimesters` stripped). The web UI never labels year-long vs trimester.
  - **Free periods:** when an A–H period has no real class that trimester, use a `classes/free-period-<letter>/` folder with `"name": "Free Period"`, `"period": "<LETTER>"`, `"freePeriod": true`, and `trimester` covering only the terms that slot is empty. Schedule rows show period tag + `Free Period` (e.g. `C Free Period`). Todos/dates under that shell use context label `Free Period C` so multiple free periods stay distinct. Prefer a real class over a free-period shell when both match the same letter.
- **project.json:** `name`; optional `description` (always markdown when set); optional `order` (number — Projects panel sorts ascending, then by name); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays). No `period`, no `trimester`, not on the class schedule.
  - Same nested `todos/` + `dates/` folder layout as classes
  - Mirror `projects/_example-dummy/` when creating objects
  - Home UI: Projects box sits below class day panels + Dates (web right column; iOS wide same; iOS single-column above Completed)
- **todo.json:** `name`; optional `description` (always markdown when set); `dueDate` (YYYY-MM-DD), `dueTime` (HH:MM); `done` (boolean, default false); optional `completedAt` (ISO timestamp set when checked off, cleared when reopened — Completed list sorts by this, newest first); optional `createdAt` (ISO timestamp set when the todo is created — open TODO lists use this for same-due ties; API falls back to file birthtime when omitted); optional `tag`: `CW` | `HW` | `QA` | `MA` (omit for normal todos); optional `showInDates` (boolean — when true, the open todo also appears in Dates lists alongside important dates); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays); optional `canvasLink` (https URL to the Canvas assignment/page — UI shows a Canvas button only when set; clear/omit to hide); optional `canvasId` (Canvas assignment id, set by Canvas sync so later runs match even if the title/due date changed); optional `kind`: `"dailyBriefing"` for the morning news todo (user-level only, no tag, `showInDates: false`, `capsules` array, per-capsule and top-level `citations`). Compiling the brief is the **daily-news** skill, not this file. When a news capsule is attached in chat, read that file and answer follow-ups; do not retag briefing todos as schoolwork. Canvas sync (personal-canvas skill) may create/update class todos from Canvas; it must **never** write `done` or `completedAt`.
  - **Defaults:** `tag: "MA"` → `showInDates` defaults **on** (omit or `true`); any other todo → defaults **off**
  - Set `showInDates: false` when the user asks to hide a specific MA from Dates; set `showInDates: true` when they ask to show a non-MA todo in Dates
  - **Open TODO sort (web + iOS):** earliest `dueDate` first (overdue included); undated below all dated; same date → timed above date-only; exact same due (or both undated) → older `createdAt` above newer (most recently added at the bottom)
- **date.json:** `name`; `date`; optional `time`, `description` (always markdown when set); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays); optional `canvasLink` / `canvasId` (same Canvas button as todos, used for syllabus or calendar-event dates)
  - Dates / showInDates todos under a **class** filter as the education-hat (`class`) category
  - Dates / showInDates todos under the **PathIvy** project filter as `pa` (PA circle)
  - Dates / showInDates todos under any other **project** (or user-level) filter as the dot (`loose`) category — never the hat
  - Home Dates filter order: MA · PA · class hat · dot

Mirror the layout of `classes/_example-dummy/` (and `projects/_example-dummy/` for projects) when creating objects.

### Description formatting

`description` is markdown. Web and iOS render it on the detail screen. Names stay plain text (list rows do not parse markdown).

When the field is set, **always write markdown**. Never a single run-on paragraph when there is more than one fact. Use `**lead-ins**`, bullets, links, and blank lines.

Copy the shape of `education/you@example.com/dates/fall-orientation-day-1/date.json`.

### Todo identity (never collide)

Todos are distinct by the triple **`name` + parent + `dueDate`**:

- **parent** = the parent class folder (`classes/<classId>/todos/…`), project folder (`projects/<projectId>/todos/…`), or **user-level** (`todos/…`)
- **`dueDate`** = the `YYYY-MM-DD` string, or **none** when omitted / empty (`dueTime` alone does **not** make them distinct)
- Same name under different parents, or same name/parent with different due dates → **different todos** (create both as asked)
- Folder `todoId` is only a path slug — still keep it unique **within that parent `todos/` folder** (never overwrite). Prefer a slug of the final `name`

**Before creating a todo**, scan existing todos in that same class / project (or user-level). If another already has the **same `name` + same parent + same `dueDate` (including both none)**, or a **similar name** on that same parent + dueDate (same rules as dates: lowercase, strip years, advisor/advisory, singular/plural):

1. **Update that folder** unless Yan asked for a second copy of the same work
2. The ` (2)` / ` (3)` suffix is **only** when Yan asked for another copy with the same triple. Then: do **not** overwrite; append ` (2)` first; **if `Name (2)` already exists with that same parent + dueDate, use ` (3)`**; if that exists too, ` (4)`, and so on — always the smallest unused ` (N)` (e.g. `Essay` → `Essay (2)` → `Essay (3)`)
3. Use a matching unique folder id (e.g. `essay-2`, `essay-3`)
4. Brief reply may mention the rename (“Added Essay (3) due Fri”)

Nightly actions never invents ` (2)`. It updates or skips.

Updating / flipping `done` on an existing todo is fine — this rule is for **create** only.

### Date identity (never duplicate)

Same event if same **parent** + same **`date`** + **similar name**:

- lowercase, strip year tokens (`2026`, `2026-27`, `2026–27`)
- advisor = advisory
- singular/plural on the last word (`conference` / `conferences`)
- equal after that, or one name contains the other
- same parent + same date + same `time` also matches when names share a real word (advisor, picnic), not dentist vs conference at 14:00

If it matches: **update that folder**. Never mint a new slug. `Advisory conference` and `Advisor conferences 2026–27` on 2026-08-27 are one event. Last year's first day does not match this year's: the `date` field differs.

Folder `dateId` stays unique within that parent `dates/` folder. Prefer a slug of the final `name`.

### Manually deleted (`deleted.md`)

When the user asks to **delete** a class, project, todo, or important date (not check off, not hide a file, not a move), append a row to `education/<email>/deleted.md` **before** removing the folder. Create the file if it is missing (copy the header from `education/you@example.com/deleted.md`). Alex writes only `education/you@example.com/deleted.md`.

Do **not** record:

- Moves (write the new folder, then delete the old one with no `deleted.md` row)
- Checking `done` / setting `completedAt`
- Daily briefing todos (`kind: "dailyBriefing"`)
- Fixtures

Row format (one line):

`- deleted YYYY-MM-DD HH:MM | kind | Name | on YYYY-MM-DD HH:MM | parent | was path`

- `deleted` timestamp is local now (date and time)
- `kind` is `date` | `todo` | `class` | `project` (calendar rows use the personal-calendar skill)
- After `on`, include the object's own date and time when those fields exist. Drop `on …` if there is no date
- parent: `user-level`, `class:<id>`, `project:<id>`
- `was` is the former folder path (helpful, not a unique key)

If the user later asks to add that thing back, create it and **remove** the matching row from `deleted.md`. Nightly jobs skip by judgement, so a leftover row would keep blocking it.

Nightly / Canvas / school-mail: if a proposed create looks like a row in `deleted.md`, skip it. Do not require the clock time or even the calendar day to match byte-for-byte. Same event in the same school year is enough. Next year's first day is a new event. Do not write `update <gone-path>`.

### Time phrases

When the user says a due/start time in natural language, resolve it like this:

- **Beginning of day** / **start of day** → `dueTime` `08:30` on that date (school morning, not midnight)
- **Beginning of class** / **start of class** / **before class** → the scheduled start time of that class on that date from `schedule.json` (`bells` / `dayOverrides` for the class’s period letter). If that class’s time on that date can’t be resolved, ask — don’t guess.

## Classes UI schedule rules

Home **Classes** layout, bells, and `schedule.json` keys: Read `.cursor/skills/class-schedule/SKILL.md`.

## Live page context

Express Personal Agent turns include a **Live context** clock and in-class-now / today's classes. Trust that for “what class am I in?” Open the weekly PDF / `schedule.json` (class-schedule skill) when editing schedule data.

**Web + iOS:** the client also sends the exact education screen open (home, expanded class/project, todo detail, date detail, news capsule). Prefer that object as the default edit target unless the user names something else. On iOS this is the Education tab's navigation (still applied when the user switches to Chat). When a news capsule is open, Live context includes the full story body and citations. Answer follow-ups from that. iOS may also attach the capsule as a markdown file. News source rules: `.cursor/skills/daily-news/SKILL.md`.

## Chat attachments (web + iOS)

Users can attach files in Personal Agent chat (web /education input; iOS paperclip). Staging lands under `education/<email>/.chat-uploads/<sessionId>/`.

- Files stay available for the **entire chat session** — later turns can still copy/read them; do not ask the user to re-send
- Inspect attachments as needed (images may also be shown inline to the model)
- When an attachment belongs in long-term dashboard context, **copy identical bytes** into the matching class / project / todo / important-date / user-level folder using the **original filename** (alongside the JSON — no `context/` subfolder)
- User-level / “main education folder” = `education/<email>/` (next to `meta.json` / `schedule.json`)
- Copy only what should persist; skip the rest
- Do not leave needed long-term context only in `.chat-uploads/` (cleared when the chat session ends)

Text-only and attachment turns both run on **grok-4.6 high** (not fast). The two ModelSelections stay separate so text-only can switch back to composer later.

## Actions

- Parse natural language into class / project / todo / important date create/update/delete. When moving a todo or date into a class or project, write the new folder, then delete the old one. Do not leave empty `todos/<id>/` or `dates/<id>/` shells. Those make the brain education mirror warn about missing json. An intentional delete must append a `deleted.md` row first; a move must not. Nightly actions also creates `date.json` rows only for rare big dates (first/last day, orientation, advisor/parent conferences, out-of-school travel, college visits, graduation-scale milestones) listed in the 02:30 digest. Skip or update duplicates (same parent + date + similar name, not only exact `name`). Skip anything that looks like a `deleted.md` row (judgement, not exact clocks). Do not create dates for hangouts, dentist, picture day, picnic, spirit week, club meetings, ordinary class events, or homework. Those can still go on Apple Calendar.
- Daily Briefing feedback (Yan): when he comments on news selection (more local, less politics, skip a beat, etc.), append a dated note to `education/you@example.com/daily-briefing/preferences.md`. Capsule thumbs are 3-way: up = more of this, down = less of this, neither (`vote: null`) = **neutral** (a real rating, not skipped/ignored). Do not attach briefing todos to a class/project or give them CW/HW/QA/MA tags. Compiling the brief itself is the daily-news skill.
- Set/clear `done`; set tags CW/HW/QA/MA when the user means school-tagged work. When setting `done` true, also set `completedAt` to an ISO timestamp (now); when setting `done` false, remove `completedAt`. On create, set `createdAt` to now.
- Set/clear `showInDates` on todos when the user wants an item shown or hidden in Dates (MAs show there by default)
- Hide or unhide dropped context files. Do not delete the file. `context.md` / `CONTEXT.md` is already hidden from tiles; writing it needs no JSON. To hide any other file, append the basename to `hiddenFiles`. To show a hidden file (including context.md), add the basename to `visibleFiles` on that object's properties JSON (`todo.json`, `date.json`, `class.json`, `project.json`, or `meta.json` for user-level files). To hide context.md again, remove it from `visibleFiles`.
- Pin dropped-file tile order when the user asks. Write `filesTop` / `filesBottom` on that object's properties JSON (same files as hidden/visible). Array order is the stuck order. Add or reorder names as asked; remove a name to unstick it (it goes back to mtime order in the middle). A name should not sit in both lists: top wins if they conflict, but prefer deleting it from the other list. Drop the key if the array would be empty. Do not invent an order they did not ask for.
- Set/clear `canvasLink` (and `canvasId`) on todos/dates when the user provides a Canvas URL, or when following the personal-canvas sync skill for mapped classes. Yan checks off `done` himself; Canvas sync must not copy completion.
- Store chat attachments into object folders when they are useful context (identical file bytes)
- Maintain `schedule.json` when the PDF or calendar changes
- Read OneDrive school files using `meta.json` `onedriveRoot` + `gradeFolder` (read-only unless asked to write). Yan’s Mac: `onedriveRoot` is `$HOME/Documents`; current year folder is `11th Grade`.
- Browser / computer use: prefer Cursor Desktop on this repo, not cloud

## After edits

The Mac Express watcher pushes SSE so `/education` refreshes. Prefer committing education data paths when finishing a batch of changes. School mutations in chat: 1–3 short lines. Object `description` fields are markdown when set; the education UI renders them. Always format them (Description formatting above).
