---
name: brain-person-imessage
description: >-
  One-shot Composer 2.5 (Fast off) pass: dump a person's iMessage history
  to /tmp, fill their brain folder from every message, then delete the dump.
  Yan only. Do not run unless asked.
disable-model-invocation: true
---

# Person iMessage fill — Yan only

**Gate:** Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read a /tmp iMessage dump for one
person, write facts into their brain folder and into other existing entities
the dump names, stop. Keep files that already exist. The Node wrapper deletes
the dump after you finish. Do not copy dump files into the repo.

Model: **composer-2.5** (fast=false). One Composer pass per month. Do not skim.

They met in September 2024. A month that only gets "active in group chat" is
unfinished. Earlier fills used dumps with empty bodies; this dump has the
actual text. Replace "empty text in export" / "no export-recorded text"
claims. Timeline rows that only recorded empty-text may be rewritten.

## Dump

Monthly files under `/tmp/yanylevin-imessage-export/<slug>/YYYY-MM.txt`.
Each line:

`ISO | 1:1-or-chat | yan-or-them-or-handle | text`

`1:1` is the private thread (both sides). Other chat names are shared group
threads (every participant, not only the primary person). `them` is the
primary person. `yan` is Yan. Any other `who` is another handle in that chat.
Read every line. Do not open `chat.db`.

## Write

Keep existing files. Never delete a brain file. Merge Standing. Timeline
append-only (`- YYYY-MM-DD | fact [iMessage]`, America/Los_Angeles, skip
duplicates). Facts, not transcripts.

Primary folder: `education/you@example.com/brain/people/<slug>/`

| File | Contents |
| --- | --- |
| `person.md` | Frontmatter, `>` summary, Standing, append-only timeline |
| `relationship.md` | How Yan knows them, Yan's assessment |
| `beliefs.md` | Beliefs, motivations, communication style, hobby horses |
| `threads.md` | Open items between Yan and them |
| `schedule.md` | Recurring calendar (school blocks, sports/club cadence). Not one-off dates |
| `notes.md` | Typed misc |

Also: `people/index.md` for name/alias lookup. If this month states a fact
about someone already in the index, update that card. Same for `groups/` and
`orgs/` when it is clearly that entity. Do not create new person folders.
Ambiguous first names: skip.

## Anti-patterns

- Deleting or emptying existing brain files
- Quoting texts into brain files
- Skimming a month
- Opening dumps outside the listed /tmp files
- Editing `people/index.md`, `people/graph.md`, or `brain/education/`
- Git commit (the Node wrapper does that)
- Creating empty typed files
