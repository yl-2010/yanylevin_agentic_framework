---
name: nightly-lint
description: >-
  Phase 5 of Yan's nightly pipeline: structure police for the brain. Schema
  check, dedup scan, cursor verification. Composer 2.5, fast off. Yan only.
disable-model-invocation: true
---

# Nightly lint — phase 5 of 5

**Gate:** Yan (`you@example.com`) only.  Never spawn a cloud agent. Local only.

## Goal

Everything earlier phases wrote conforms to `brain/schema.md`, nothing is
duplicated, and the cursors moved. You fix structure, not content.

## Contract

- Scope: files touched tonight (git status shows them) plus anything the
  earlier phases flagged in their replies.
- The runner regenerates `people/index.md`, `people/graph.md`, and the
  education mirror after you finish; never edit those by hand. If
  `node server/brain-graph.js --check` reports problems, fix the underlying
  entity files (frontmatter that does not parse, dangling edge targets).
- Dedup: same fact written by a chat-time write and tonight's phase 2 means
  removing the duplicate timeline entry ONLY if it is a true duplicate from
  tonight (same date, same fact). Older timeline entries are immutable.
- Duplicate entities flagged by phase 2: merge per schema (keep the more
  complete card, merge timelines chronologically, merge aliases, repoint
  edges, delete the duplicate).
- Promote: a Standing section that has grown past ~25 lines gets its stable
  facts split into the typed files (relationship.md / beliefs.md / threads.md
  / schedule.md / notes.md). Recurring calendar goes to schedule.md, not
  Standing. Never create empty files.
- Identity pages: any bullet over ~220 characters, or `identity.md` over
  ~80 lines / ~1,200 words, gets rewritten down per schema. Mail-noise
  (Libby holds, sign-in alerts, iCloud-full) does not belong there.
  Placement is structure: if identity.md has another person's email, phone,
  spelling/alias note, nickname, birthday, death detail, or job, move it to
  that person's card and leave the slug. Run
  `node server/brain-placement-lint.js` and fix what it reports. You may
  still edit identity.md; this is not a write ban.
- Resolved threads/ pages phase 3 forgot to delete: confirm the resolution
  landed on the entity timeline + journal, then delete the page.
- Verify `state.json`: `lastSynthesisDateKey` is tonight, and these nightly
  cursors moved for every source that succeeded: `mailSince`,
  `schoolMailSince`, `imessageSince`, `chatHistorySince`, `screenTimeAt`,
  `locationEnrichmentAt`, `healthAt` (`healthAt` when `health/takeaways.md`
  was available, `schoolMailSince` when school Outlook prefetch succeeded).
  Fix if phase 3 missed one. `appleMailFill.lastAt` is a one-shot fill stamp,
  not a cursor. It must not move overnight. Do not create `appleMailSince`.
  A missing `/tmp/yanylevin-apple-mail-export` is expected.

## Anti-patterns

- Rewriting content or adding facts, except moving a misplaced person fact
  from identity.md onto the matching card. You are structure, not synthesis.
- Deleting timeline entries that are not tonight's true duplicates.
- Hand-editing generated files.
- Touching entities no phase wrote tonight (except a flagged merge).

## Verify

`node server/brain-graph.js --check` exits clean. No schema violations in
tonight's files. Cursors correct. Reply with what you fixed.
