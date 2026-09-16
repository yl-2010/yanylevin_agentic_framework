---
name: debate-cases
description: >-
  Yan's LD debate research and case building for /debate. Brainstorm in his
  argument shape, then hunt sources that actually say the claim. Use when
  Yan is on /debate, a case Aff/Neg page, or asks to build/research a case.
---

# Debate cases, Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is
Alex, skip this whole skill.

Chat is the normal Personal Agent. Objects live in the personal debate
project, not `education/projects/jype/`.

Do **not** dump full old case text into git. Patterns live in
`education/you@example.com/projects/debate/CONTEXT.md`. Re-read that
file when Yan asks how he writes cases, or before updating it.

## Workflow

1. Read `education/you@example.com/projects/debate/CONTEXT.md` for his
   style (logical chains, how he uses sources, value/criterion habits).
2. If a case page is open, note case id + Aff vs Neg.
3. Brainstorm in HIS shape first. Do not dump generic PF/LD templates or
   canned utilitarianism dumps.
4. Then research deeply for real sources that say exactly what the claim
   needs. Prefer primary/academic over random blogs. Quote the line that
   actually warrants the tag.
5. Case expanded views are currently title-only/blank. Do not invent a
   layout. Put research notes in CONTEXT.md or a dropped file next to
   `case.json` only if Yan asks to save them. Todos under a case live at
   `education/you@example.com/projects/debate/cases/<id>/todos/<todoId>/todo.json`
   and still show on /debate home and /education home. Do not put a todo
   list on the case page.
6. Objects live in the personal debate project, not
   `education/projects/jype/`. Chat is the normal Personal Agent.

## File layout

```
education/you@example.com/projects/debate/
  project.json
  CONTEXT.md                    # agent notes, hidden from UI by default
  cases/<caseId>/
    case.json                   # name; Aff/Neg are sides, not folders
    todos/<todoId>/todo.json    # optional; still show on both homes
```

`/debate` is Yan-only (`allowedEmails: you@example.com`). Routes are
`/debate/case/<caseId>/aff` and `/neg`. `renderCase()` is title only
(`Name · Aff`). Do not fill that page with cards, blocks, or a todo list.

Do **not** import old Word cases as `case.json` rows unless Yan asks.

## Research

Brainstorm the chain first: claim, internal link, number, impact. Then hunt
a source that says that warrant, not a nearby vibe.

- Prefer EPA, USDA, WHO, Congress/CRS, academic journals, official stats.
- Tag format Yan uses: `Author YY: short warrant` plus a link (he often
  used Arc quote URLs). Then a `this means` / `doing the math` line in his
  voice.
- The card body has to say the tag. If it does not, keep looking.
- Do not paste camp briefs, Victory/Champion dumps, or Kankee packets as
  if they were his case.

## Old cases (when updating CONTEXT.md or answering "how do I write cases")

Summarize patterns. Do not commit full case text.

Search order:

1. OneDrive 10th:
   `$HOME/Documents/10th Grade/I Debate/`
   (Rewilding, Nukes, flows, Big Questions)
2. OneDrive 9th:
   `.../9th Grade/PI Debate Team/`
   (Wealth Tax, Treaties, AGI / Artifical Intelligence)
3. OneNote: `node --env-file=server/.env server/school-onenote.js` from
   repo root, notebook `'25-'26 Speech & Debate`, Yan's `LD/Yan`
   (Rewilding, Nukes, Interventionalism, Main). 26-27 notebook is not in
   the account yet. Use `.cursor/skills/personal-onenote/SKILL.md`.
   Summarize, do not dump.
4. School Outlook for Google Docs: Taiwan PF, ICC, UNCLOS (Ruike / Alice).
   `.cursor/skills/personal-school-mail/SKILL.md`
5. iCloud `School/9th Grade/PI Debate Team` (two Pages files)
6. Leftover Desktop/Downloads/Documents sweep for stray aff/neg/docx.
   Skip GLR debate-pushups video.

Word on Mac: `textutil -convert txt -stdout "file.docx"`. Pages files are
iCloud packages, not cases.

## OneNote

Hayes notebooks list as recent, but they live on her personal OneDrive
(`/personal/mhayes_eastsideprep_org/`). `school-onenote.js` site resolve
only handles `/sites/` and `/teams/`, so `sections` may 404. `search` may
400. If that happens, write from the Word files and say so. Do not invent
Interventionalism cards from the Nat Quals sentence alone.

```bash
node --env-file=server/.env server/school-onenote.js notebooks
node --env-file=server/.env server/school-onenote.js sections --notebook "'25-'26 Speech _ Debate"
```

## Don't

- Create extra cases in the UI
- Put objects under JYPE
- Invent a case-page layout
- Dump generic util / Kant / "I value morality because ought"
- Treat leftover paste (Nukes Word mixed with Rewilding, AGI Neg pasted
  from Treaties, later blockfiles copied from Wealth Tax Aff) as his
  finished case
