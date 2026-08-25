---
name: fitness-os
description: >-
  Personal gym tracker for /fitness on yanylevin.com and the iOS Fitness tab.
  Append or delete weight entries under fitness/<email>/machines/, parse typed
  numbers like "100, 105, 105", and create machines when asked. Use when the
  user mentions gym, fitness, machines, weights, or /fitness.
---

# Fitness OS

Two entry points share this skill: **iOS Gym text input** (Cursor SDK local agent via Express, Composer 2.5 Fast) and **Cursor Desktop** on this repo. Always edit the same file tree. **Local only** — never cloud agents.

## Scope

- Allowed users: `you@example.com`, `you@example.com`
- App/agent sessions inject the signed-in email — write only under `fitness/<that-email>/`
- In Cursor Desktop on Yan’s Mac, default to `fitness/you@example.com/` unless the user names Alex
- Never touch the other user’s folder
- Never edit education data, main-site chatbot wiring, or LM Studio config

## File schema

```
fitness/<email>/
  meta.json                 # email, displayName, timezone
  machines/<machineId>/
    machine.json            # id, name, order
    entries.json            # { entries: [{ id, weight, at }] }
```

**Hard rule:** each machine folder has exactly `machine.json` + `entries.json`. New fields go in those JSON files.

### Properties

- **machine.json:** `id` (folder slug), `name` (display), `order` (sort, lower first), `color` (`#rrggbb` hex — unique across that user’s machines)
- **entries.json:** `entries` array of:
  - `id` — uuid string
  - `weight` — number (lbs / machine stack units as the user uses them)
  - `at` — ISO 8601 timestamp of when the set was logged

### Colors (required on create)

Every machine needs a distinct `color` for overview chips / chart lines.

1. Read sibling `machines/*/machine.json` and collect existing `color` values (normalize case; treat `#1B7D8A` and `#1b7d8a` as the same).
2. Pick a new `#rrggbb` that is **not** already used. Prefer a clearly different hue (not a near-duplicate of an existing swatch).
3. Write it into the new `machine.json`. Never reuse or cycle a color that is already taken.
4. Optional starter pool (skip any already in use): `#1b7d8a`, `#c45c26`, `#3d6b3d`, `#8b4d9a`, `#b8860b`, `#2f5d9f`, `#a63d4a`, `#5a6a7a`, `#0d9488`, `#ea580c`, `#65a30d`, `#7c3aed`, `#ca8a04`, `#0369a1`, `#be123c`, `#475569`, `#db2777`, `#0891b2`, `#b45309`, `#4d7c0f`. If the pool is exhausted, invent another distinct hex.

### Sessions

A **session** is the Pacific (`America/Los_Angeles`) calendar date of each entry’s `at`. Same date → same session. Do not create separate session files.

Newly logged entries stay pending in the UI for **2 hours**, then solidify into charts/history. Still write them immediately with real timestamps.

## Text parsing (iOS type bar)

When the user types weights:

- `"100, 105, 105"` → three entries in that order: 100, then 105, then 105
- Also accept spaces / newlines as separators
- Prefer the **active machine** from the prompt when no machine is named
- Use **now** as `at` for each new entry (space multi-entry by 1ms so sort order matches input order)
- Append to `entries.json`; never wipe unrelated history
- You **can and should delete** specific entries when the user asks (mistakes, accidental button presses, wrong weight). Remove only the matching entry/entries from `entries.json` — keep everything else

## Actions

- Append weight entries for a machine
- **Delete** one or more entries when asked — e.g. "delete that", "undo the last one", "remove the 105 I just logged", accidental UI taps. Match by recent timestamp, weight, and/or active machine; remove those objects from the `entries` array and save
- Create a new machine folder when clearly requested (`machine.json` with unique `color` + empty `entries.json`)
- Rename / reorder machines when asked; keep or reassign `color` so no two machines share the same hex
- Never invent historical timestamps unless the user specifies them
- Never wipe an entire machine's history unless the user explicitly asks to clear all logs for that machine

## Invisible output (critical)

The user **never sees** your text. The fitness UI does not display agent messages at all. The only thing they see is the data change (new weights, deleted entries, new machines). Your text reply is discarded.

Therefore:

- **Never ask for confirmation.** Never ask clarifying questions. Never wait for a yes/no. The user cannot answer you.
- **Just do the action immediately** from the typed command plus the active machine in the prompt.
- If something is slightly ambiguous, pick the obvious interpretation (active machine, most recent matching entry) and act. Do not stall.
- If there is no active machine and none is named, pick the obvious machine from the message; if still unclear, pick the most recently used machine and act anyway.
- Keep any leftover text to a single short status line (or empty). No markdown, tables, narration, or “please refresh.”
