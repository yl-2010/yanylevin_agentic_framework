---
name: brain-school-mail
description: >-
  One-shot Composer 2.5 (Fast off) pass: dump ~2 years of EPS Outlook
  (owner@school.example) to /tmp, fill brain from every month, then
  delete the dump. Yan only. Do not run unless asked.
disable-model-invocation: true
---

# EPS Outlook fill — Yan only

**Gate:** Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read a /tmp dump of school Microsoft
365 mail, write facts into brain cards (and education dates when they belong
on the Dates panel), stop. Keep files that already exist. The Node wrapper
deletes the dump after you finish. Do not copy dump files into the repo.

Model: **composer-2.5** (fast=false). One Composer pass per month. Do not skim.

## Dump

Monthly files under `/tmp/yanylevin-school-mail-export/YYYY-MM.txt`. Each
message is:

`ISO | from=addr | to=addr | subject`

then a clipped text body.

Read every message. Skip empty marketing. Extract school, teacher, classmate,
PathIvy, college, family-school, and logistics facts.

## Write

Keep existing files. Never delete a brain file. Timeline append-only
(`- YYYY-MM-DD | fact [school-mail]`, skip duplicates). Facts, not transcripts.

Check `brain/people/index.md` and `skipped.md` before creating anyone.

Create a person folder only for a real EPS teacher, counselor, classmate, or
family-school contact Yan clearly knows. Never card Scoir, GitHub, university
admissions blasts, or mailing lists.

Orgs (`brain/orgs/`) for EPS, PathIvy, and similar standing institutions when
the mail adds a fact. Education Dates panel for orientation, conferences,
picture day, field trips that are not already there
(`.cursor/skills/personal-agent/education-dashboard.md`). Read
`education/you@example.com/deleted.md` first. Skip a date that looks like
something Yan already deleted (judgement, not exact clocks).

Identity.md only for Yan map facts (current grade). A new email on
identity-accounts.md means Yan's address. Other people's mail goes on their
card. School standing goes to `identity-school.md`. Dated events go to the
matching org timeline (`orgs/eastside-prep.md`). Do not paste bodies.

## Anti-patterns

- Deleting or emptying existing brain files
- Quoting emails into brain files
- Skimming a month
- Opening dumps outside the listed /tmp files
- Editing `people/index.md`, `people/graph.md`, or `brain/education/`
- Git commit (the Node wrapper does that)
- Creating empty typed files
