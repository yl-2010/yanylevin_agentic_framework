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
5. Write the speech into `case.json` `aff` / `neg` using the layout in
   the file section below. Do not invent a second layout. A case with no
   body stays title-only. Todos under a case live at
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
    case.json                   # name, resolution, aff, neg
    todos/<todoId>/todo.json    # optional; still show on both homes
```

`/debate` is Yan-only (`allowedEmails: you@example.com`). Routes are
`/debate/case/<caseId>/aff` and `/neg`. A case with no `aff` / `neg` body
stays title-only (`Name · Aff`). A case that has a side renders that side
as a speech, in this order, and no other order:

1. Resolution line
2. Framework. Value, criterion, one short why.
3. Definitions. Term, then the cut. The cut is the same card shape as a contention card: tag, quote, link, then cue bullets.
4. Contentions. Cue bullets first. Cards under them.

The blockfile is not a fifth section of the speech. It is the other column. Each block is `A2`, the claim, cue bullets, then cards in the same shape. A side without a blockfile is unfinished. Write it with the speech. On a wide screen the speech is the left column and the blockfile is the right. That is the website above 720px and the iPad. A phone stacks the blockfile under the speech.

Quotes stay full sentences from the source. Everything else is bullets of
things to say, not a written speech. He turns the bullets into sentences.
That includes framework notes, definitions, the chain, and the line after
a card. Do not write those out as paragraphs.

Each card is tag (`Author YY: warrant`), the quote that says the tag, a
link to the direct text, then cue bullets for the math or the implication.
Aff and Neg on the same topic use the same framework, the same defs, and
the same card shape. The side switch is always Aff, then Neg. Do not put a
todo list on the case page. Do not invent a second layout.

Do **not** import old Word cases as `case.json` rows unless Yan asks.

## Research

Brainstorm the chain first: claim, internal link, number, impact. Then hunt
a source that says that warrant, not a nearby vibe.

- Prefer EPA, USDA, WHO, Congress/CRS, academic journals, official stats.
- Tag format Yan uses: `Author YY: short warrant` plus a link (he often
  used Arc quote URLs). After the quote, cue bullets for the math or the
  implication. Not a written `this means` paragraph.
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
- Invent a second case-page layout. Speech order stays resolution, framework, definitions, contentions. The blockfile is the other column, not a new speech order.
- Dump generic util / Kant / "I value morality because ought"
- Treat leftover paste (Nukes Word mixed with Rewilding, AGI Neg pasted
  from Treaties, later blockfiles copied from Wealth Tax Aff) as his
  finished case
