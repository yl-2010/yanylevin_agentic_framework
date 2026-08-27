---
name: brain-apple-mail
description: >-
  One-shot Composer 2.5 (Fast off) pass: dump Mail.app (Exchange, Google,
  iCloud) full history to /tmp, fill brain from every month, then delete
  the dump. Yan only. Do not run unless asked.
disable-model-invocation: true
---

# Apple Mail fill, Yan only

**Gate:** Yan (`you@example.com`).  Never spawn a cloud agent.

You are a one-shot local Cursor agent. Read a /tmp dump of Mail.app personal
mail, write facts into brain cards, stop. Keep files that already exist. The
Node wrapper deletes the dump after you finish and stamps
`appleMailFill.lastAt` on `state.json` (top-level, not under `cursors`). Do
not write `appleMailSince` into cursors. Do not copy dump files into the
repo.

Model: **composer-2.5** (fast=false). One Composer pass per month. Do not skim.

School Outlook (`owner@school.example`) is out of scope. That fill already
ran. This dump is Mail.app only: Exchange `you@example.com`, Google
`you@example.com`, iCloud `you@icloud.com`.

Earlier AppleScript fills often looked blank. This dump was parsed from on-disk
`.emlx` MIME. It has the words. Ignore "empty export" / "blank body" claims.

## Dump

Monthly files under `/tmp/yanylevin-apple-mail-export/YYYY-MM.txt`. Each
message is:

`ISO | account=Exchange|Google|iCloud | folder=Inbox | from=addr | to=addr | subject`

then plaintext (HTML stripped). `[image omitted]` means the message was
image-only, not empty.

Read every message. Skip newsletters, Scoir, GitHub, and mailing lists.
Do **not** skip noreply booking, itinerary, receipt, refund, or travel mail
(Alaska, Tesla, Airbnb, hotels). Extract people Yan knows, family, friends,
PathIvy, work, and standing logistics. Round-trip itineraries: every leg, not
only the subject-line outbound.

## Write

Keep existing files. Never delete a brain file. Timeline append-only
(`- YYYY-MM-DD | fact [mail]`, skip duplicates). Facts, not transcripts.

Check `brain/people/index.md` and `skipped.md` before creating anyone.

Create a person folder only for a real person Yan clearly knows. Newsletters,
noreply, Scoir, GitHub, stores, and mailing lists go to `skipped.md`. Never
card them. Update existing cards when the index already has them.

Orgs and groups only when the mail adds a standing fact. Identity.md only for
Yan map facts (current grade, home pointer). A new email on identity-accounts.md
means Yan's address. Other people's mail goes on their card.
School/accounts/logistics go to `identity-school.md`, `identity-accounts.md`,
`identity-logistics.md`. Dated events go to the matching org timeline. Never
Libby holds, sign-in alerts, iCloud-full, or Duolingo day-counts. Do not paste
bodies.

## Anti-patterns

- Deleting or emptying existing brain files
- Quoting emails into brain files
- Skimming a month
- Treating the dump as empty
- Opening dumps outside the listed /tmp files
- Editing `people/index.md`, `people/graph.md`, or `brain/education/`
- Git commit (the Node wrapper does that)
- Creating empty typed files
- Carding school-Outlook-only contacts that this dump does not name
