# Education dashboard context

Read this file only when the turn is about the **/education** dashboard (classes, todos, dates, projects, school attachments, OneDrive school files). This is **not** a skill and is **not** widget/mail/news-compile instructions.

Schedule files (weekly PDF / `schedule.json` / bells): Read `.cursor/skills/class-schedule/SKILL.md`. Past chats: `.cursor/skills/past-chats/SKILL.md`.

The live UI is `yanylevin.com/education` (`education/index.html`, `education/app.js`, `education/styles.css`, `education/chatbot.js`, `education/markdown.js`). Data lives under `education/<email>/`. Express `/api/education/data` (not this agent) is what the page reads. Git does not auto-deploy. If you change those UI files, run `npm run deploy:web` after push. Skip the deploy for `education/<email>/` data-only edits.

Yan-only `/debate` (`debate/index.html`) reuses the same SPA and `/api/education`. Objects live under `education/you@example.com/projects/debate/` so they still show on `/education`. Chat is the Personal Agent (same history). Google login is `you@example.com` only. Do not copy the JYPE isolated workspace.

Shared JYPE dashboard is `yanylevin.com/jype` (`jype/index.html` reuses the education SPA via `window.YL_EDU`). Data and files live under `education/projects/jype/` in the old GitHub class layout (`classes/<id>/class.json`, `projects/<id>/project.json`, `todos/`, `dates/`). Live HTML sites are `sites[]` URL tiles on the related class (or project if it is not a class), not a Notes project. Yan’s personal pages stay on his OneDrive class until he sends that URL to a JYPE member or the JYPE agent creates the page. No Canvas sync. Todos are agent-only. Chats: `education/projects/jype/.chat-history/`. Express `/api/jype/*`. Do not write Yan's personal `education/you@example.com/` tree unless Yan asks.

Allowed users and write scope are in `.cursor/skills/personal-agent/SKILL.md`. Never delete fixture objects (`"fixture": true` or ids starting with `_example-`). Fixtures are hidden from `/api/education/data`; keep them on disk as the layout reference.

## File schema

Canonical schedule files live in `.cursor/skills/class-schedule/SKILL.md` (weekly PDF + `education/<email>/schedule.json`).

```
education/<email>/
  meta.json                 # gradeFolder, onedriveRoot, onedriveWebRoot (SharePoint Documents URL for opening Word/Excel/PPT in the native apps), optional hiddenFiles / visibleFiles / filesTop / filesBottom for user-level dropped files; optional projectsTop / projectsBottom for the Projects panel
  .projects-opened.json     # last-opened map (user clicks + agent creates). Gitignored. Write on project create; do not git add.
  schedule.json             # bells + weekdayPeriods + closedDates (from PDF)
  deleted.md                # agent-only: objects this user deleted on purpose; nightly jobs skip recreating them
  .chat-history/            # Personal Agent transcripts (listed unless hidden, or expired iMessage/Teams @agent ephemeral)
  .chat-uploads/            # attachment staging (expires with session)
  # optional user-level dropped files sit here (not a context/ subfolder)
  todos/<todoId>/todo.json + optional dropped files
  dates/<dateId>/date.json + optional dropped files
  daily-briefing/           # Yan only: meta.json, profile.md, preferences.md, taste.md
  location/                 # Yan only: GPS stays/trips (not a dashboard object)
  classes/_example-dummy/   # fixture layout only. Real Yan classes live on OneDrive
    projects/<projectId>/
    project.json + optional dropped files (e.g. CONTEXT.md, hidden from UI by default)
    todos/<todoId>/todo.json + optional dropped files
    dates/<dateId>/date.json + optional dropped files
    cases/<caseId>/                 # Debate project only today
      case.json                     # name; Aff/Neg are sides, not separate folders
      todos/<todoId>/todo.json      # optional; still show on /debate home and /education home

OneDrive (Yan, `meta.json` onedriveRoot + gradeFolder, currently `11th Grade`):

  <class folder>/                 # e.g. H. Physics. Missing classes use a leading-dot name (`.Independent Study`) so Finder hides them until Cmd+Shift+.
    .education/                   # Finder-hidden. class.json + .CONTEXT.md only
      class.json
      .CONTEXT.md
    <Finder name>/.todo.json + that todo's files   # folder leading-dot when hidden (OneDrive syncs the rename)
    <Finder name>/.date.json + that date's files
```

**Hard rule:** exactly one properties JSON per object folder. New fields = new keys in that JSON, never sidecar property files. Dropped context files sit directly in the object folder (alongside the JSON) — no `context/` subfolder. **Yan standing (2026-09-17):** OneDrive is the default for storing and handling every file under a school class. Do not keep class files in `education/<email>/` or the GitHub repo unless Yan specifically says so in that prompt. **Yan classes live on OneDrive**, not under `education/<email>/classes/` (that tree only keeps `_example-dummy`). `class.json` and `.CONTEXT.md` stay in `.education/`. Every class todo and date is a folder directly under the visible class folder (`H. Physics/HW Sep 15 Ping Pong Vacuum Cannon WS/.todo.json`), with its files in that same folder. Do not leave school files at the class folder root if they belong to a todo. On OneDrive, bookkeeping is Finder-hidden with a leading dot: `.todo.json`, `.date.json`, `.CONTEXT.md`, `.deleted.md`. Projects, user-level todos, and Alex stay plain `todo.json`. Finder hides a todo/date folder until it is relevant (opened on web/iOS, or HW/CW the period before due, QA/MA two periods before due) and hides it again once a completed todo has moved into the class-view Completed box. Overdue open todos stay visible. A Canvas submission counts as checked off for Finder only. The folder hides once that todo would sit in the class Completed box. Do not write `done` into the file. Show a still-future folder early only when Yan put a file in it, or told an agent to put a file in it. When Yan asks to hide one of those folders anyway, set `finderHidden: true` on that `.todo.json` or `.date.json`. Visibility sync keeps the leading-dot name until that key is removed. Opening the page does not clear it. A Canvas download does not count. Files listed in `canvasFiles` do not count. Do not early-show Completed folders or undated todos that only unhide when opened. Hide by renaming to a leading-dot folder (`.HW Sep 15 Ping Pong Vacuum Cannon WS`) so OneDrive syncs it to every Mac. Cmd+Shift+. still shows those folders. Do not use `chflags hidden`. OneDrive does not copy that flag, and it stalls the Mac client. Projects and user-level objects stay under `education/<email>/`. Alex has no `onedriveRoot`; his classes stay in `education/you@example.com/classes/` with nested `todos/` + `dates/`.

**OneDrive Finder names (class todos/dates only):** spaces, not kebab hyphens. Web and iOS still paint `todo.json` `name` + `tag` (or `date.json` `name`). The due date is Finder-only.

- Todos: `TAG Mon D Name` → `HW Sep 15 Comparing Motion Diagrams`. Skip `TAG` when there is no CW/HW/QA/MA. Skip `Mon D` when there is no `dueDate`. Day has no leading zero (`Sep 2`).
- Dates: `Mon D Name` → `Aug 27 Advisory conference`. Skip the date part when `date` is missing.
- Illegal filename characters (`/ : " ? *` and similar) become spaces. A ` - ` dash between words becomes a space. Keep hyphens inside words (`in-class`, `14-15`, `Write-up`).
- Unique within that class folder. Extra copies Yan asked for: `HW Sep 15 Essay (2)`.
- Express visibility sync renames kebab leftovers and updates the folder when tag / due / name change. Create with this name so Finder looks right immediately.
- Projects, user-level, and Alex classes are not Yan's school OneDrive. Those folder ids can stay unique slugs (spaces are fine; do not kebab for the sake of kebab).

**OneDrive class folders (web + iOS class page):** Express lists the live `onedriveRoot` / `gradeFolder` / `onedriveFolder` tree and skips todo/date object folders (those files show on the todo/date page). Bytes stay in OneDrive. Nested leftover folders still expand as tiles. `.education/` is omitted from tiles. `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` still apply by basename.

**Opening files (web + iOS):** Word / Excel / PowerPoint that live under `onedriveRoot` open the same OneDrive item in the native app (`ms-word:` / `ms-excel:` / `ms-powerpoint:` with the SharePoint URL from `onedriveWebRoot`). Desktop from the website, Word/Excel/PPT iOS apps from the phone. Cmd-click, middle-click, and drag-to-tab stay native `<a href>`. Office tiles use the SharePoint URL so the new tab is still that file. Pictures use `/api/education/file` directly on click too. That covers png, jpg, gif, webp, heic, and avif. The new tab is the picture, so dragging it into another tab still shows it. HTML and PDF still open a copy on a plain click, a blob on the web and Quick Look on iOS. Query values with spaces, `#`, or accents are `ylb64.` tokens so a dragged link is not cut off at `#`. Project files under `education/<email>/` are never OneDrive, so they stay copies.

Yan’s Mac: `onedriveRoot` is `$HOME/Documents`; `onedriveWebRoot` is the SharePoint Documents URL in `meta.json`; current year folder is `11th Grade`. Visible class folders stay all year: `A. Data Sci 1`, `C. Advanced Calc`, `D. Spanish 4`, `E. US History`, `F. American Lit`, `G. PE Yoga`, `H. Physics`. Hidden until Cmd+Shift+.: `.Independent Study`, `.Advanced Programming AI-ML`, `.Advanced Programming Emergent Topics`, `.Free Period A`, `.Free Period B`. History is F fall / E winter-spring; Lit is E fall / F winter-spring. Those letter swaps live on `class.json` `period` as `{ "fall", "winter", "spring" }` with `"trimester": "year"`. There is no winter-spring shell class. Period letters on the folder names are not always the current period. Class Notebooks are not those grade folders. Do not git-publish OneDrive paths.

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
- **URL tiles (web + iOS, `/education` and `/jype`):** a file tile that is only a link. Click opens the URL. Nothing is downloaded.
  - `sites` on `class.json` / `project.json` / `todo.json` / `date.json`: `[{ "name": "QA #1 Study Guide", "url": "https://yanylevin.com/spanish4/fall-qa-1/" }]`. Prefer this for live HTML pages. A OneNote page adds `clientUrl` (`onenote:https://…`), `oneNote` (`personal` or `content-library`), and `pageId`. The tile name for Yan's page is the assignment name. The teacher page is `Content Library: ` plus the page title. Web click opens desktop OneNote. iOS opens the OneNote app. The nightly Canvas agent writes these. Leave them alone on any other pass.
  - Or drop a small JSON in that folder (`{"kind":"url","name":"...","url":"https://..."}`) or a `.url` Internet Shortcut. Same tile. Works on OneDrive class folders too.
  - Study guides and notes go on the related **class**, not a Notes project.
  - **JYPE vs Yan:** a page Yan made for himself belongs on his OneDrive `.education/class.json`. Put it on `education/projects/jype/classes/<id>/class.json` only when the JYPE agent created it, or when Yan sends that URL to Alex, Example Friend, Example Neighbor, or the JYPE group. Shared class ≠ shared tile.
- **Project list order (web + iOS):** default is newest last-opened first. Opening the project screen (web or iOS) records that. Creating a project counts the same: write the folder id and now (ISO) into `.projects-opened.json` after `project.json`. Never-opened leftover-`order` projects stay below those, then A-Z. Override with two optional string arrays on **`meta.json`**. Array order is the pin order. Pins match folder id or display name, case-insensitive.
  - **`projectsTop`:** stuck to the top of the Projects box, in this order
  - **`projectsBottom`:** stuck to the bottom, in this order
  - Everything not listed stays in the middle, still newest-opened first
  - Missing names are skipped. A name in both lists stays on top. Omit the key when the list is empty (do not leave `[]`).
  - On create, merge that project id into `.projects-opened.json` (now ISO). Create the file if missing. Keep other keys. Do not git add it. Do not set leftover `order` on a new project.

### Properties

- **class.json:** `name`, `period` (A–H letter, or a `{ "fall", "winter", "spring" }` map when the letter swaps), `trimester`, optional `description` (always markdown when set), optional `sites` (URL tiles above), optional `onedriveFolder` (basename under `meta.json` `onedriveRoot`/`gradeFolder`, e.g. `"H. Physics"` — class page file tiles list leftover files in that folder live; omit to auto-match by class name), optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays — dashboard file-tile visibility and pin order; `context.md` is hidden by default), optional `canvasLink` (https URL to that course’s Canvas gradebook, e.g. `https://canvas.instructure.com/courses/3639020/grades` — web and iOS class views show the same Canvas orb as todos/dates only when set; clear/omit to hide), optional extras
  - `trimester`: `"year"` (always visible), `"fall"` | `"winter"` | `"spring"` (one tri), or an array like `["fall", "spring"]` for multi-tri but not year-long
  - Year-long folders + context stay on disk all year
  - Trimester-only classes stay on disk forever (never delete)
  - Visibility is enforced by the Express `/api/education/data` payload (out-of-season classes omitted). The API still sends `schedule.trimesters` plus a class `periods` map when the letter changes by term. The web UI never labels year-long vs trimester.
  - **Free periods:** when an A–H period has no real class that trimester, use a Finder-hidden OneDrive folder `.Free Period <LETTER>/.education/` with `"name": "Free Period"`, `"period": "<LETTER>"`, `"freePeriod": true`, `"id": "free-period-<letter>"`, and `trimester` covering only the terms that slot is empty. Schedule rows show period tag + `Free Period` (e.g. `C Free Period`). Todos/dates under that shell use context label `Free Period C` so multiple free periods stay distinct. Prefer a real class over a free-period shell when both match the same letter.
- **project.json:** `name`; optional `description` (always markdown when set); optional `href` (https or site path — clicking the project leaves this dashboard and opens that URL, e.g. Yan’s JYPE tile `"href": "/jype/"`); optional `sites` (URL tiles); optional leftover `order` (number, used only among never-opened unpinned projects); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays). No `period`, no `trimester`, not on the class schedule. Do not set `order` to pin a project; use `meta.json` `projectsTop` / `projectsBottom`.
  - Same nested `todos/` + `dates/` folder layout as classes
  - Mirror `projects/_example-dummy/` when creating objects (skip `fixture` and `order` on a real project). After create, record the folder id in `.projects-opened.json` as opened now so it shows at the top of the unpinned list.
  - Home UI: Projects box sits below class day panels + Dates (web right column; iOS wide same; iOS single-column above Completed)
  - Yan’s Debate tile uses `"href": "/debate/"`. JYPE uses `"/jype/"`.
- **case.json** (only under `projects/debate/cases/<id>/`): `name`. Optional `resolution`, `aff`, and `neg`. Each case is one object with Aff and Neg sides (not two folders). `/debate` lists them as a stacked Aff/Neg pair above Dates. Clicking a side opens `/debate/case/<id>/aff` or `/neg`. A side with no body is the title only. A side with a body renders the speech: resolution, framework (value, criterion, why), definitions, then contentions (chain first, then cards). A card is `tag`, `quote`, `source`, `url` (https link to the direct text), and `means` (cue bullets). Framework `text`, definition `points`, contention `chain`, and card `means` are bullets of things to say. A framework and a definition can each carry `cards` in the same shape as a contention card (`tag`, `quote`, `source`, `url`, `means`). Each side also has a `blockfile` of A2 answers (label, title, chain cues, cards). On a wide screen the speech is the left column and the blockfile is the right. A phone stacks the blockfile under the speech. Quotes stay full sentences. The side switch is always Aff, then Neg. Do **not** render a todo list on the case page. Nested `cases/<id>/todos/` still flatten onto the debate project so they show on `/debate` home and `/education` home. Case building is `.cursor/skills/debate-cases/SKILL.md`.
- **todo.json:** `name`; optional `description` (always markdown when set); `dueDate` (YYYY-MM-DD), `dueTime` (HH:MM); `done` (boolean, default false); optional `completedAt` (ISO timestamp set when checked off, cleared when reopened — Completed list sorts by this, newest first); optional `createdAt` (ISO timestamp set when the todo is created — open TODO lists use this for same-due ties; API falls back to file birthtime when omitted); optional `tag`: `CW` | `HW` | `QA` | `MA` (omit for normal todos); optional `showInDates` (boolean — when true, the open todo also appears in Dates lists alongside important dates); optional `hiddenFromHome` (boolean — when true, omitted from home TODO/Completed and the unfiltered home widget; class and project pages still show it); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays); optional `sites` (URL tiles); optional `canvasLink` (https URL to the Canvas assignment/page — UI shows a Canvas button only when set; clear/omit to hide); optional `canvasId` (Canvas assignment id, set by Canvas sync so later runs match even if the title/due date changed); optional `canvasFiles` (`[{ "id", "name" }]` — teacher attachments Express downloaded into this folder; do not submit those as Yan's work; omit when empty); optional `kind`: `"dailyBriefing"` for the morning news todo (user-level only, no tag, `showInDates: false`, `capsules` array, per-capsule and top-level `citations`). Compiling the brief is the **daily-news** skill, not this file. When a news capsule is attached in chat, read that file and answer follow-ups; do not retag briefing todos as schoolwork. Canvas sync (personal-canvas skill) may create/update class todos from Canvas; it must **never** write `done` or `completedAt`.
  - optional `linkedFiles` (`[{ "todo", "canvasId", "name" }]` or `[{ "todo", "canvasId", "pageId" }]`). A pointer to a file or OneNote page that stays in another todo of the same class. `name` is the filename in that folder. `pageId` is a OneNote site already on that todo. Express reads the https URL and `onenote:` client URL from there. `canvasId` is matched first, so a renamed Finder folder still resolves. `todo` is the Finder folder id without a leading dot, used when there is no Canvas id. The website and iPhone show the same open button as the file on the source todo. Do not copy the bytes. Omit the key when the array is empty. Add or remove a pointer when Yan asks in chat. The nightly Canvas pass adds one when he would work in that same doc for this todo.
  - Do not put CW/HW/QA/MA in `name`. Use `tag`. The UI shows that tag in accent blue at the same size as the title.
  - **Defaults:** `tag: "MA"` → `showInDates` defaults **on** (omit or `true`); any other todo → defaults **off**. `hiddenFromHome` defaults **off** (omit or `false`)
  - Set `showInDates: false` when the user asks to hide a specific MA from Dates; set `showInDates: true` when they ask to show a non-MA todo in Dates
  - Set `hiddenFromHome: true` when the user wants an item off the home dashboard but still on its class/project page; omit or `false` to show on home again. Express `/api/education/data` omits those todos from `class.todos` (so home flatten skips them) and puts them on `classOnlyTodos`. Class pages merge both lists.
  - **Open TODO sort (web + iOS):** earliest `dueDate` first (overdue included); undated below all dated; same date → timed above date-only; exact same due (or both undated) → older `createdAt` above newer (most recently added at the bottom)
  - **Class page Completed (web + iOS only):** a checked-off todo stays in that class's TODO list (struck through) until the hold ends. Due on a day this class meets: before or during that period stays until the period ends; after class that day moves to Completed at the due time. Not a meeting day: stays until the end of this class's next meeting after the due date. Date-only due = start of that day, so a class that meets later that day holds until that period ends. No due date → Completed immediately. Home and project pages still move to Completed as soon as the box is checked.
- **date.json:** `name`; `date`; optional `time`, `description` (always markdown when set); optional `hidden` (true omits the date from `/education` and iOS Education; the folder stays on disk); optional `hiddenFiles` / `visibleFiles` / `filesTop` / `filesBottom` (string arrays); optional `sites` (URL tiles); optional `canvasLink` / `canvasId` (same Canvas button as todos, used for syllabus or calendar-event dates)
  - Dates / showInDates todos under a **class** filter as the education-hat (`class`) category
  - Dates / showInDates todos under a **project** (including PathIvy) or user-level filter as the dot (`loose`) category, never the hat
  - Home Dates filter order: MA · class hat · dot

Mirror the layout of `classes/_example-dummy/` (and `projects/_example-dummy/` for projects) when creating objects.

### Description formatting

`description` is markdown. Web and iOS render it on the detail screen. Names stay plain text (list rows do not parse markdown).

When the field is set, **always write markdown**. Never a single run-on paragraph when there is more than one fact. Use `**lead-ins**`, bullets, links, and blank lines.

Copy the shape of `education/you@example.com/dates/fall-orientation-day-1/date.json`.

### Todo identity (never collide)

Todos are distinct by the triple **`name` + parent + `dueDate`**:

- **parent** = the parent class folder (OneDrive `<onedriveFolder>/<Finder name>/` for Yan; `classes/<classId>/todos/…` for Alex / fixtures), project folder (`projects/<projectId>/todos/…`), or **user-level** (`todos/…`)
- **`dueDate`** = the `YYYY-MM-DD` string, or **none** when omitted / empty (`dueTime` alone does **not** make them distinct)
- Same name under different parents, or same name/parent with different due dates → **different todos** (create both as asked)
- Folder `todoId` is the on-disk folder name — still keep it unique **within that parent folder** (never overwrite). On OneDrive classes, that name is the Finder string above (`HW Sep 15 Title`), not a kebab of the title.

**Before creating a todo**, scan existing todos in that same class / project (or user-level). If another already has the **same `name` + same parent + same `dueDate` (including both none)**, or a **similar name** on that same parent + dueDate (same rules as dates: lowercase, strip years, advisor/advisory, singular/plural):

1. **Update that folder** unless Yan asked for a second copy of the same work
2. The ` (2)` / ` (3)` suffix is **only** when Yan asked for another copy with the same triple. Then: do **not** overwrite; append ` (2)` first; **if `Name (2)` already exists with that same parent + dueDate, use ` (3)`**; if that exists too, ` (4)`, and so on — always the smallest unused ` (N)` (e.g. `Essay` → `Essay (2)` → `Essay (3)`)
3. Use a matching unique folder name (OneDrive: `HW Sep 15 Essay (2)`; elsewhere a unique folder id is fine)
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

Folder `dateId` stays unique within that parent folder. On OneDrive classes, that is the Finder name (`Aug 27 Advisory conference`), not a kebab of the title.

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

### Open the page (`open_education_page`)

Express / web / iOS only. Cursor Desktop does not have this tool.

Call `open_education_page` when the user asks about **one** dashboard object, says show me / take me there, or you just created the thing they would look at. The website navigates in place (chat stays open). iOS stays on Chat; the Education tab is already on that page when they switch to it.

The jump happens **once**, when your final reply for this turn lands. Not when you call the tool. File writes and chat polls do not replay it. Last call in the turn wins. A later turn can jump again (same page or a different one) by calling the tool again.

- `view`: `home` | `class` | `project` | `todo` | `date` | `capsule` | `case`
- `todoId` / `dateId` / `classId` / `projectId` are **folder names on disk**, not the UI title. Class OneDrive todos look like `HW Sep 15 Title`. Class todos need `classId`. Project todos need `projectId`. Capsules need `todoId` + `capsuleId`. Debate cases need `caseId` plus `caseSide` (`aff` or `neg`). That opens `/debate`, not a nested `/education` project page.
- After a create, call once the folder exists so clients can resolve it.
- Skip if Live context is already that page. Skip lists of many items. Skip mail, news compile, fitness, and anything outside `/education`.
- You can call it mid-turn (after you know the id). The page still waits until the turn ends. Do not mention the tool or tell them to refresh.

## Chat attachments (web + iOS)

Users can attach files in Personal Agent chat (web: drag onto /education composer or thread, or paste; iOS paperclip). Staging lands under `education/<email>/.chat-uploads/<sessionId>/`.

- Files stay available for the **entire chat session** — later turns can still copy/read them; do not ask the user to re-send
- Inspect attachments as needed (images may also be shown inline to the model)
- When an attachment belongs in long-term dashboard context, **copy identical bytes** into the matching place. If Yan asked you to handle the file and the upload name is junk (`Scanned Document 16`, `IMG_1234`, `Screenshot`, `Untitled`, kebab-case, snake_case), **rename it** to a readable title: words separated by spaces, no hyphens or underscores, keep the extension (`Motion Diagram Warm Up.pdf`). Keep the original name only when it is already a proper title. Prefer `node --env-file=server/.env server/canvas-files.js store --src <path> --class <id> --todo "<Finder folder>"` (or `--canvas-id`) so the copy lands in OneDrive with a File Provider fsync. Do **not** `cp` into `education/<email>/classes/` and call it done. The website/app lists the OneDrive folder live; a GitHub copy shows in the UI and misses Finder/phone OneDrive.
  - **Class** (or a leftover file that should appear on the class page): that class’s visible OneDrive folder (`meta.json` `onedriveRoot` + `gradeFolder` + `class.json` `onedriveFolder`). OneDrive is the default. Do not write under `education/<email>/` or `education/<email>/classes/` unless Yan says otherwise. Prefer the todo folder when the file belongs to a todo.
  - **Class todo / date:** that class’s OneDrive `<onedriveFolder>/<Finder name>/` next to the JSON. Not `.education/todos/`. Not the GitHub `education/` tree.
  - **Project / user-level:** the object folder alongside the JSON (no `context/` subfolder), same as before
- User-level / “main education folder” = `education/<email>/` (next to `meta.json` / `schedule.json`)
- Four11 / class-schedule cards (Yan or classmates): parse into `schedule.json`, `brain/identity-school.md`, and `people/<slug>/schedule.md`. Do **not** copy the original PDF/screenshot into the user-level education folder
- Copy only what should persist; skip the rest
- Do not leave needed long-term context only in `.chat-uploads/` (cleared when the chat session ends)

Text-only and attachment turns both run on **grok-4.7 high** with Fast off. The two ModelSelections stay separate so text-only can switch back to composer later.

## Actions

- Parse natural language into class / project / todo / important date create/update/delete. When moving a todo or date into a class or project, write the new folder, then delete the old one. Do not leave empty `todos/<id>/` or `dates/<id>/` shells. Those make the brain education mirror warn about missing json. An intentional delete must append a `deleted.md` row first; a move must not. Nightly actions also creates `date.json` rows only for rare big dates (first/last day, orientation, advisor/parent conferences, out-of-school travel, a college visit Yan said he signed up for, graduation-scale milestones) listed in the 02:30 digest. Skip or update duplicates (same parent + date + similar name, not only exact `name`). Skip anything that looks like a `deleted.md` row (judgement, not exact clocks). Do not create dates for hangouts, dentist, picture day, picnic, spirit week, club meetings, or ordinary class events. Those can still go on Apple Calendar. Homework and other todos stay on the dashboard. Do not copy them onto Apple Calendar unless Yan asked for that item there. College spam and the weekly EPS college-visit list stay off both Dates and Apple Calendar. Only a visit Yan said he signed up for.
- **College applications (Yan, 2026-10-03).** New college-app todos go on the PathIvy project, `projects/pathivy/todos/`. That includes PSAT practice, counselor talks, teacher thank-you cards, and teacher asks that are for the application. Ask Seeley about AP Physics tests is PathIvy, not Physics.
- Daily Briefing feedback (Yan): when he comments on news selection (more local, less politics, skip a beat, etc.), append a dated note to `education/you@example.com/daily-briefing/preferences.md`. Capsule thumbs are 3-way: up = more of this, down = less of this, neither (`vote: null`) = **neutral** (a real rating, not skipped/ignored). Do not attach briefing todos to a class/project or give them CW/HW/QA/MA tags. Compiling the brief itself is the daily-news skill.
- Set/clear `done`; set tags CW/HW/QA/MA when the user means school-tagged work. When setting `done` true, also set `completedAt` to an ISO timestamp (now); when setting `done` false, remove `completedAt`. On create, set `createdAt` to now.
- Set/clear `showInDates` on todos when the user wants an item shown or hidden in Dates (MAs show there by default)
- Set/clear `hiddenFromHome` on todos when the user wants an item off the home TODO/Completed lists (and the unfiltered home widget) while keeping it on the class or project page. Default is show on home. Yan standing: routine P.E. Yoga classworks (prep/participation, titles like `Yoga Class #N`) stay `hiddenFromHome: true` unless the work is actually a submission (survey, write-up, student-led session, anything that is not the usual show-up-and-participate CW)
- Hide or unhide dropped context files. Do not delete the file. `context.md` / `CONTEXT.md` is already hidden from tiles; writing it needs no JSON. To hide any other file, append the basename to `hiddenFiles`. To show a hidden file (including context.md), add the basename to `visibleFiles` on that object's properties JSON (`todo.json`, `date.json`, `class.json`, `project.json`, or `meta.json` for user-level files). To hide context.md again, remove it from `visibleFiles`.
- Pin dropped-file tile order when the user asks. Write `filesTop` / `filesBottom` on that object's properties JSON (same files as hidden/visible). Array order is the stuck order. Add or reorder names as asked; remove a name to unstick it (it goes back to mtime order in the middle). A name should not sit in both lists: top wins if they conflict, but prefer deleting it from the other list. Drop the key if the array would be empty. Do not invent an order they did not ask for.
- Set/clear `hidden` on a project or important date when the user wants it off or back on the education view. `true` omits it from `/education` and iOS Education. Omit or `false` to show it again. Do not delete the folder for a hide. Do not set `hidden` on shared JYPE objects unless the user asks to hide them from `/jype`.
- Pin Projects-box order when the user asks. Write `projectsTop` / `projectsBottom` on `meta.json`. Array order is the stuck order. Entries are folder ids or display names (case-insensitive). Add or reorder as asked; remove a name to unstick it (it goes back to last-opened order in the middle). A name should not sit in both lists: top wins if they conflict, but prefer deleting it from the other list. Drop the key if the array would be empty. Do not invent an order they did not ask for.
- When creating a project, also merge its folder id and now (ISO) into `education/<email>/.projects-opened.json` so it sorts like a just-opened project (below `projectsTop`, above older unpinned). Create the file if missing. Keep other keys. Remove that id if the project is deleted. Do not git add this file.
- Set/clear `canvasLink` (and `canvasId`) on todos/dates when the user provides a Canvas URL, or when following the personal-canvas sync skill for mapped classes. On mapped **classes**, set `class.json` `canvasLink` to the course gradebook (`htmlUrl` + `/grades`). Yan checks off `done` himself; Canvas sync agents must not copy completion into todo.json. Express overlays Canvas submitted/graded/planner-complete as `done` on the education API, and writes a Canvas planner override when Yan checks off a Canvas-linked todo.
- **Submit to Canvas** only when Yan says submit / turn in / upload this to Canvas. A chat file plus those words is the whole request: identify the assignment (Live context page first, then filename / due-soon / class), rename if the upload name is junk, store on OneDrive, then `canvas-files.js submit --file`. He does not have to name the assignment when it is obvious. Save / put this in / handle / store never submits. Details: `.cursor/skills/personal-canvas/SKILL.md`. Do not submit teacher files listed in `canvasFiles`.
- Store chat attachments into object folders when they are useful context (identical file bytes). Rename junk upload names per Chat attachments above. **Yan class todo/date files go on OneDrive**, next to that JSON. The app/website already lists that folder. Never leave the kept copy only under `education/you@example.com/` (except `.chat-uploads` staging). Only put a file on the class page itself when it is not tied to a todo. "Put this in" / "save this" / "handle this file" is store only.
- When creating a static `.html` on a **class** (quotes, errors, study sheet), read `.cursor/skills/object-html/SKILL.md` and write it in that class’s OneDrive folder. Todo / date / project HTML still sits next to that object’s JSON.
- Maintain `schedule.json` when the PDF or calendar changes
- Read OneDrive school files using `meta.json` `onedriveRoot` + `gradeFolder` + the class `onedriveFolder` (read-only unless asked to write). Yan’s Mac: `onedriveRoot` is `$HOME/Documents`; current year folder is `11th Grade`. Class page tiles already list that folder live; do not copy those files into `education/<email>/`. Class Notebooks are not those grade folders. Use `.cursor/skills/personal-onenote/SKILL.md` when a school question is about an agenda, HW instructions, maps, or day packets, or when a todo already names a OneNote page. Each class `CONTEXT.md` has that notebook's section map.
- Browser / computer use: prefer Cursor Desktop on this repo, not cloud

## After edits

The Mac Express watcher pushes SSE so `/education` refreshes. Prefer committing repo education paths when finishing a batch of changes. Do not git-add OneDrive class trees. School mutations in chat: 1–3 short lines. Object `description` fields are markdown when set; the education UI renders them. Always format them (Description formatting above).
