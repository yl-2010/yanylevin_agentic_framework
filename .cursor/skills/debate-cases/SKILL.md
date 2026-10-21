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
as a speech, in this order, and no other order. He reads it straight down
during the speech. Do not preview the case and then expand it later.

1. Resolution sentence, the line he says first. `I affirm Resolved: ...`
   or `I negate Resolved: ...`. The stored `resolution` stays
   `Resolved: ...`. The page adds the verb.
2. Definitions. Each key term in the resolution, then one card. One online
   dictionary per term. No second source, and no bullet list that restates
   the definition before the card.
3. Framework. Value, then criterion, then the cards that justify them.
   Look at his old cases for the why. Morality plus util is the usual pair
   when the resolution says ought or unethical. Do not put a bullet summary
   of the framework and then the same cards again.
4. Contentions, in the order he says them. No chain of bullets above the
   cards. The cards are the speech.

The blockfile is not a fifth section of the speech. It is the other column.
Each block is `A2`, the claim they will make, then cards in the same shape.
No bullet summary of the answer above the cards. A side without a blockfile
is unfinished. Write it with the speech. The card has to answer that claim.
The bold lines are the answer he reads. A quote that states their argument,
or a quote he would have to spin into the opposite, is the wrong card. Hunt
a source that denies the claim, or that measures it and does not find it.
Do not park their evidence in the block and explain it away in the means line.

On a wide screen the speech is the
left column and the blockfile is the right. That is the website above 720px
and the iPad. A phone stacks the blockfile under the speech.

Each card, in this order:

1. Cite, at the very start, so he knows what to say. Authored cards are
   `Smith 24` (last name, two digits of the year). A dictionary cite is the
   dictionary name. The cite is the link. Put the URL on that tag.
2. `summary`. One or two sentences on what the source says. This is the
   only plain-language line before the quote. Do not repeat it in a chain.
3. `quote`. Exact text from the source. Include the sentences around the
   point so he has context. Mark the words he should read with `**double
   asterisks**`. The page bolds those words. Do not bold the whole quote.
4. `source`. Full name of the publication, not a second link.
5. `means`, only for the number or the next line that this card alone
   produces. Not a restatement of the quote, and not a preview of a later
   card.

Aff and Neg on the same topic use the same framework, the same defs, and
the same card shape. The side switch is always Aff, then Neg. Do not put a
todo list on the case page. Do not invent a second layout.

Do **not** import old Word cases as `case.json` rows unless Yan asks.

## Research

Brainstorm the chain first: claim, internal link, number, impact. Then hunt
a source that says that warrant, not a nearby vibe.

- Prefer EPA, USDA, WHO, Congress/CRS, academic journals, official stats.
- Cite format: `Smith 24`, then `summary`, then the quote with the point
  inside `** **`, then the link on the cite. After the quote, `means` only
  for math or the implication of that card.
- The bolded words have to say the summary. If they do not, keep looking.
- In a blockfile, the bolded words also have to answer the `A2` claim. If the quote is the argument he is answering, it is their card. Find one that rebuts it.
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

Word on Mac: `textutil -convert txt -stdout "file.docx"`. That is a read.
Do not save over the Word file. Pages files are iCloud packages, not cases.

## OneNote

Hayes notebooks list as recent, but they live on her personal OneDrive
(`/personal/mhayes_eastsideprep_org/`). `school-onenote.js` site resolve
only handles `/sites/` and `/teams/`, so `sections` may 404. `search` may
400. If that happens, write the case from the Word text and say so. Do not save over those Word files. Do not invent
Interventionalism cards from the Nat Quals sentence alone.

```bash
node --env-file=server/.env server/school-onenote.js notebooks
node --env-file=server/.env server/school-onenote.js sections --notebook "'25-'26 Speech _ Debate"
```

## Don't

- Create extra cases in the UI
- Put objects under JYPE
- Invent a second case-page layout. Speech order stays the resolution sentence, then definitions, then framework, then contentions. The blockfile is the other column, not a new speech order. Do not put a bullet outline of the case above the cards.
- Dump generic util / Kant / "I value morality because ought"
- Treat leftover paste (Nukes Word mixed with Rewilding, AGI Neg pasted
  from Treaties, later blockfiles copied from Wealth Tax Aff) as his
  finished case
