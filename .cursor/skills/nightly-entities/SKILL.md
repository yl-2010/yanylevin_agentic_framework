---
name: nightly-entities
description: >-
  Phase 2 of Yan's nightly pipeline: update entity cards (people, groups,
  orgs, places) for entities that appeared in the triage digest. Yan only.
  Composer 2.5, fast off.
disable-model-invocation: true
---

# Nightly entities — phase 2 of 5

**Gate:** Yan (`you@example.com`) only.  Never spawn a cloud agent. Local only.

## Goal

For every entity listed in `/tmp/yanylevin-context-notable.md` under
"Entities that appeared", bring its card up to date: frontmatter fields,
compiled truth, typed files, timeline, edges. Nobody else reads the raw dumps
for people; you are where person facts land.

## Contract

- Read `education/you@example.com/brain/schema.md` first; its frontmatter
  and edge rules are hard requirements (scalars bare, arrays/objects one-line
  JSON, edges a block list of one-line JSON objects, enum only).
- Touch ONLY entities in the digest list (plus creating a missing edge-target
  entity). Never rewrite untouched people. Never glob `people/`.
- Writes go under `brain/people/<slug>/`, `brain/groups/`, `brain/orgs/`,
  `brain/places/`. Never edit generated files (`people/index.md`,
  `people/graph.md`, `brain/education/**`); the runner regenerates them.
- Timeline entries are append-only: add `- YYYY-MM-DD | fact [source]` at the
  bottom. Check the entry is not already there (a chat-time write or an
  aborted earlier run may have added it). Never edit or delete existing
  entries; corrections are new entries.
- Compiled truth (above `<!-- timeline -->`) is yours to rewrite so it reads
  current. Label uncertainty (likely / looks like / as of DATE).
- Typed files per schema: relationship.md (how Yan knows them, assessment),
  beliefs.md (beliefs, motivations, communication style, hobby horses),
  threads.md (open items between Yan and them), schedule.md (recurring
  calendar only, not one-off dates), notes.md (typed misc). Create a file
  the first time there is real content; never create empty files.
- Update `last_touched` and any changed frontmatter fields.

## New entities

1. Check `people/index.md` (names AND aliases), then `people/skipped.md`.
   A new name variant of a known person is an alias to add, not a new card.
2. If a first/last name hits at least 2 iMessage mentions, resolve it in the
   school dump (`/tmp/yanylevin-context-school-names.json`): full name, class
   of, teacher vs student. Lookup only; never import the roster or staff list.
3. Real person, no card: create `people/<slug>/person.md` per schema (folder
   + person.md only; other files when content exists). Businesses and noreply
   go to skipped.md. Group-chat titles are groups, not fake people.
4. Edges: enum only; person-to-person targets must exist; group/org/place
   targets get a minimal entity file if genuinely new (check for an existing
   file first).

## Tricky spots

- Duplicate suspicion (similar name, same company/school, same email on two
  cards): note it in your reply for the lint phase; do not merge mid-run.
- Aliases live on the card and in `people/index.md`. Pull the card. Do not
  treat a joke spelling as a real alias; the card is the source. When several
  people share a first name, read all matching cards before picking.
- Facts about Yan himself belong in phase 3's pages, not on a person card.
  Leave them in the digest; do not drop them.
- Speaker: a fact on someone else's card still needs "Yan told them …" when
  Yan said it (`who=yan` / `fromMe=true` in the dump, or "Yan said" in the
  digest). Do not collapse that into Standing that reads as their claim.

## Anti-patterns

- Pasting texts or emails into cards. Facts, not transcripts.
- Inventing biography. Only what the digest and existing brain state.
- "No new info" filler edits. If nothing changed for an entity, skip it.
- Storing secrets, tokens, card numbers, or school-sheet gender/ethnicity.

## Verify

Every digest entity either has updated card(s) or a stated skip reason. All
edited frontmatter still parses (schema rules). No generated file touched.
Reply with one line per entity: slug + what changed.
