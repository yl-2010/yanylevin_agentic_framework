---
name: personal-people
description: >-
  Yan's entity graph in brain/ (people, groups, orgs, places). Required
  whenever a prompt names someone (legal name, nickname, or alias): pull the
  entity card, then only the typed file the task needs. Aliases are the same
  person (check the card / people/index.md). Also use when Yan asks who someone
  is, and for same-turn brain writes. Yan only — never for Alex.
disable-model-invocation: true
---

# People and entities — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is
Alex, skip this whole skill. Never glob `brain/people/`. Never dump the
folder into a turn.

Standing memory about people Yan knows, plus groups, orgs, and places, as a
typed graph. Contract: `education/you@example.com/brain/schema.md`. Live
contact lookup uses AddressBook sqlite
(`.cursor/skills/personal-contacts/SKILL.md`), not Contacts.app.

## Read (required when a turn names anyone)

Not optional. Not "only if the question is about them."

1. Pull the card: `node server/brain-entity-card.js <slug|name|alias>`.
   It returns fields, edges both directions, which typed files exist,
   compiled truth, and recent timeline in one call. If you only have a rough
   name, check `brain/people/index.md` (generated; slug, name, relationship,
   aliases) first.
2. Aliases live on the card and in `people/index.md`. They are case-insensitive.
   Pull the card; do not keep a second alias table here.
3. Several people can share a first name. Pull every matching card before
   answering; do not pick the first hit.
4. Open a typed file (`relationship.md`, `beliefs.md`, `threads.md`,
   `schedule.md`, `notes.md`) only when the task needs that context. The
   card is usually enough. Open `schedule.md` for their classes, free
   periods, advisory, or other recurring commitments.
5. Not in the index: say so. Optionally search Contacts or iMessage. Do not
   invent a second person; do not create a card unless Yan asks.
6. Graph questions ("who is in JYPE", "who connects to Milos") read the
   generated `brain/people/graph.md`, or the group/org entity card.

## Person folder shape

Every person is `people/<slug>/`, identical allowed file set (schema has the
full contract):

| File | Contents |
|------|----------|
| `person.md` | REQUIRED. Frontmatter (relationship, gender, aliases, emails, phones, school, groups, edges, last_touched) + executive summary + Standing + append-only `<!-- timeline -->`. |
| `relationship.md` | How Yan knows them, Yan's assessment. |
| `beliefs.md` | Beliefs, motivations, communication style, hobby horses. |
| `threads.md` | Open items between Yan and them. |
| `schedule.md` | Recurring calendar (school blocks, sports/club cadence). Not one-off dates. |
| `notes.md` | Typed misc. |

Only person.md always exists; the others appear when there is real content.

## Write (same-turn rule)

When Yan states a fact or correction about an entity in chat, write it the
same turn:

- New event or dated fact: append `- YYYY-MM-DD | fact [chat]` under the
  timeline sentinel. GPS stays from the 03:00 location-brain job use `[GPS]`.
  Never edit or reorder existing entries.
- Changed standing fact (new phone, relationship change, gender, correction): update
  the frontmatter field or the Standing line, and bump `last_touched`.
- Follow schema frontmatter rules exactly (scalars bare, arrays/objects as
  one-line JSON, edges block list, enum-only edge types).
- Then run `node server/brain-graph.js` if you changed frontmatter.
- Person facts (spelling, emails, nicknames, phones, birthdays, deaths, jobs)
  stay on that entity. Do not also copy them onto identity.md. Identity people
  lines are name, role, and `people/slug` only.

Full card creation is different: only when Yan asks, or in the nightly
pipeline (check `skipped.md` and index aliases first; dedup per schema). Do
not paste texts or emails. Do not invent biography. Group-chat titles are
groups (`brain/groups/`), not fake people.

Nightly phase rules live in `.cursor/skills/nightly-entities/SKILL.md` and
`.cursor/skills/nightly-lint/SKILL.md`.
