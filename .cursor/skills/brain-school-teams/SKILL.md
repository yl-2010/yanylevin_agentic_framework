---
name: brain-school-teams
description: >-
  One-shot Composer 2.5 (Fast off) pass: dump EPS Teams chat and channel
  history (owner@school.example) to /tmp, fill brain from every month,
  then delete the dump. Yan only. Do not run unless asked.
disable-model-invocation: true
---

# EPS Teams fill — Yan only

**Gate:** Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read a /tmp dump of school Microsoft
Teams, write facts into brain cards (and education dates when they belong
on the Dates panel), stop. Keep files that already exist. The Node wrapper
deletes the dump after you finish. Do not copy dump files into the repo.

Model: **composer-2.5** (fast=false). One Composer pass per month. Do not skim.

## Dump

Monthly files under `/tmp/yanylevin-school-teams-export/YYYY-MM.txt`. Each
message is:

`ISO | kind=chat|channel | chat=Name | type=oneOnOne|group|meeting | speaker=Yan|Alex | from=Name <email> | fromMe=true|false | atLocal=Thu Sep 10, 7:15 PM PT`

or for a class channel:

`ISO | kind=channel | team=Spanish 4 | channel=General | speaker=Yan|Name | from=Name | fromMe=true|false | atLocal=...`

then a clipped text body.

Read every message. Skip empty control noise (calls, join/leave). Extract
classmate, teacher, group, class-channel, and school-logistics facts.

`fromMe=true` / `speaker=Yan` is Yan. Speaker matters: a fact on someone else's card still
needs "Yan told them …" when Yan said it. Copy `atLocal`, not UTC `at`.

## Write

Keep existing files. Never delete a brain file. Timeline append-only
(`- YYYY-MM-DD | fact [school-teams]`, skip duplicates). Facts, not transcripts.

Check `brain/people/index.md` and `skipped.md` before creating anyone.

Create a person folder only for a real EPS teacher, counselor, classmate, or
family-school contact Yan clearly knows. Never card mailing lists, bots, or
a meeting title as a person. Group chats are `brain/groups/` (Class of 2028,
advisory), not fake people.

Orgs (`brain/orgs/`) for EPS when the thread adds a standing fact. Education
Dates panel for events that belong there and are not already present
(`.cursor/skills/personal-agent/education-dashboard.md`). Read
`education/you@example.com/deleted.md` first. Skip a date that looks like
something Yan already deleted (judgement, not exact clocks).

Identity.md only for Yan map facts (current grade). School standing goes to
`identity-school.md`. Dated events go to the matching org or group timeline.
Do not paste message bodies.

## Anti-patterns

- Deleting or emptying existing brain files
- Quoting Teams messages into brain files
- Skimming a month
- Opening dumps outside the listed /tmp files
- Editing `people/index.md`, `people/graph.md`, or `brain/education/`
- Git commit (the Node wrapper does that)
- Creating empty typed files
- Carding a group-chat title as a person
