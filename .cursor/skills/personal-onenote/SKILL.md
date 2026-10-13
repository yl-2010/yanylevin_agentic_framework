---
name: personal-onenote
description: >-
  Read Yan's EPS Microsoft 365 OneNote / Class Notebooks
  (ylevin@eastsideprep.org) via node server/school-onenote.js. Use when Yan
  asks about school work that lives in a Class Notebook (agenda, HW
  instructions, maps, day packets, grammar refs), or when a job names a
  notebook or page. Yan only. Never a default nightly source. Never for
  Prasham.
disable-model-invocation: true
---

# School OneNote, Yan only

**Gate:** signed-in / default user is `yanylevin@gmail.com`. If the user is
Prasham, skip this whole skill.

Account: `ylevin@eastsideprep.org`. Same Chrome login as school Outlook
(`~/.yanylevin/school-mail/chrome-profile`). No Azure app. No API key.

Per-class maps also live on each class `CONTEXT.md`. This file is the
traversal guide. Do **not** dump page bodies into the brain.

## When to use

Open OneNote when the question is about something teachers put in the Class
Notebook, even if Yan never said the word OneNote:

- In-class agenda / what we are doing today
- Homework or CW *instructions* (the prompt, the map, the text to rewrite)
- Day packets, slides posted as pages, grammar refs, rubrics
- Yan's own filled pages (Crash Course notes, written HW on a page)

Canvas is still the due date and the upload. The dashboard todo is the
tracking row. OneNote is the worksheet.

Do **not** list every notebook "just in case." Do **not** run a history
fill. There is no `school-onenote-fill`. This is not a default nightly
source. Nightly triage, synthesis, and fact-check do not scan OneNote
unless a claim they are already handling is specifically about a page.
The canvas nightly is the exception. After it writes todos, that Grok
agent reads the class notebook and writes the sites itself. See
personal-canvas. Do not run `link-todos` for that.

Yoga has no Class Notebook. Free periods neither. Speech & Debate 26-27
is not in this account yet (only last year's Hayes notebooks).

You only see what Yan can open as a student: Content Library, his private
section, Collaboration Space. Leave other students' private sections alone.

## Graph gotchas

`/me/onenote/notebooks` dies on EPS (OneDrive over the 5k-item cap). Recent
notebooks come back with **empty ids**. Class Notebooks live on Teams
SharePoint sites. `/me/onenote/notebooks/{id}` and `/me/onenote/pages/{id}`
404 for those. `school-onenote.js` resolves the site from the recent
`webUrl` and uses `/sites/{siteId}/onenote/...`.

`search` hits `/me` and often misses Class Notebooks. Prefer
`--notebook` + `--section`. Duplicate section names (Spanish has two
`Notas de clase`) need the group prefix:
`--section "_Content Library/Notas de clase"`.

## Commands

From the repo root:

```bash
node server/school-onenote.js status
node server/school-onenote.js notebooks
node server/school-onenote.js sections --notebook "Spanish 4"
node server/school-onenote.js pages --notebook "Spanish 4" --section "_Content Library/Notas de clase"
node server/school-onenote.js page "<id>"
node server/school-onenote.js search "colonial map"
```

Output is JSON. Use `id` from pages when reading a body. Summarize.
Do not print tokens. Do not dump huge HTML (`page` already returns text;
`--html` only if you must see markup).

**Ink (written HW).** Graph HTML comments say `InkNode is not supported` and
`page` text will look empty. That is not a dead end. Fetch the page with
`?includeInkML=true`, extract the InkML, convert himetric traces
(`* 96 / 2540`) to CSS px, and overlay them on the `data-options="printout"`
images. That is how PS2 ink was read. Do not tell Yan ink is unreadable.

If `signedIn` is false or the payload says `not signed in`, run login on the
Mac Studio. Chrome opens **Graph Explorer**, not Outlook. The script clicks
`ylevin@eastsideprep.org` on the Microsoft account picker, then Run query.
Do not tell Yan to click Sign in. Stay at the computer only if 2FA appears.

```bash
node server/school-onenote.js login
```

Cookies live in `~/.yanylevin/school-mail/`. The OneNote Graph token lives in
`~/.yanylevin/school-onenote/session.json` (not in git). Never copy those
folders into the repo.

## 2026-27 class notebooks

Teacher pages live under `_Content Library` unless noted. `Yan Levin` is
his private copies. Prefer the teacher page for instructions.

### Spanish 4 (`Spanish 4 - 2026-2027`)

Sanchez. This is the notebook that actually runs the class.

| Need | Section |
| --- | --- |
| Today's agenda | `_Content Library/Notas de clase` (dated `Clase N` pages) |
| HW / CW prompt | `_Content Library/Tareas - CW` |
| Grammar ref | `_Content Library/GRAMATICA con Profe Sánchez` |
| Verb patterns | `_Content Library/VERBOS` |
| Sentence frames | `_Content Library/FRASES DE ORO` |
| Quizlet list | `_Content Library/Quizlets` |
| QA study guide | `_Content Library/Pruebas` |
| Rubrics | `_Content Library/Rúbricas` |
| Extra reading / listening | `_Content Library/RECURSOS ADICIONALES 2` |
| Group CW | `_Collaboration Space/Período D` |

Yan's `Notas de clase` / `Tareas - Trabajo en clase` are copies. Write-on
HW is on the teacher Tareas page, then a PDF goes to Canvas.

### US History (`US History 26-27`)

Bandel. Fall collab section is `Bandel F`.

| Need | Section |
| --- | --- |
| Syllabus, Foner, Chicago, AI policy | `_Content Library/Course Resources` |
| Unit lessons, PPTs, primary sources, maps, HW prompts | `_Content Library/I. Forming A Nation` |
| Yan's filled HW (Crash Course notes, maps) | `Yan Levin/Homework` |

Later units (`II`–`IV`) and `FINAL PROJECT` are shells. Numbered `1.3`
pages are the lesson. `HW: ...` pages are the assignment (map is on
`HW: The British Colonies`).

### American Lit (`Am. Lit`)

Sundberg Lunstrum. Yan is E period.

| Need | Section |
| --- | --- |
| Day plan / in-class agenda | `_Content Library/Tri 1-Investigation and Vision` (`Day 1`, `Day 2`, `Day 3 (9-11)`) |
| Syllabus, grading | `_Content Library/Course Resources` |
| Thesis / claims / MLA | `_Content Library/Writing Resources` |
| Grammar presentation slots | `_Content Library/Grammar Presentations` → `E Period Sundberg Lunstrum Presentations` |

### Advanced Calculus (`Advanced Calculus 26-27`)

Kruger. Current unit is Integration Techniques.

| Need | Section |
| --- | --- |
| Day packet, warmup, notes | `_Content Library/Integration Techniques` (`Day 0`, `Day 1`, `Day 2`, `Day 3`) |
| Problem set | same section, `Day N problem set` (solutions are `Day N solns`) |
| Keisler / old AP sheet | `_Content Library/Resources` |
| Yan's worked sets | `Yan Levin/Homework` |

Due dates stay on Canvas. The page is the set.

### Data Science 1 (`Data Science 1 (Fall) Notebook`)

Zhou. Fall only.

Everything teacher-posted is in `_Content Library/Using the Content Library`
(Day 0 infographic through Day 5 presentation, slides, Excel how-tos, the
HW/CW pages). Yan's Homework / Class Notes / Quizzes are empty shells.

### Physics (`Physics 26-27`)

Seeley, period H.

| Need | Section |
| --- | --- |
| Day-by-day plan, PPT names, HW | `_Content Library/Schedules` → `Fall Schedule` |
| Classroom norms (Responsible Action, 10%) | `_Content Library/Course Documents` |

`Seeley (H Period)` is empty. `Dr. T (B-C-D-G)` is the other teacher, skip
it. Yan's private sections are empty. A lot of Physics still lives on
Canvas and paper.

## Search

Prefer a named `--notebook` over listing everything. Class Notebooks nest
under `_Content Library`, `_Collaboration Space`, and Yan's name.
`sections` flattens those groups.

This is not school OneDrive. Grade-folder Word/PPT files stay on the
education-dashboard OneDrive path.
