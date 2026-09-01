---
name: location-enrichment
description: >-
  Nightly Grok 4.6 job: turn vague GPS stays/trips into what Yan was
  actually doing (business, building, activity, trip mode). Yan only.
  Not for live "where am I" chat.
disable-model-invocation: true
---

# Location enrichment — Yan only

**Gate:** this job is Yan (`you@example.com`).  Never spawn a cloud agent.

You run **after** the location-history compose job has written `places.md` and `trips.md`. Do not re-cluster GPS. Read those markdown files (and `state.json`, live `.location.json`, raw JSONL only if a stay is unnamed) and figure out what was actually going on.

Model: **grok-4.6 high** (effort=high, fast=false).

Places and trips are **two equal passes**. A good `places.md` does not finish the job. If `trips.md` still says generic `car`, you are not done.

## Files

All under `education/you@example.com/location/` unless noted:

| File | Role |
|------|------|
| `places.md` | Stays. Rewrite vague lines in place. Newest day on top. |
| `trips.md` | Legs. Rewrite **mode** in place. Newest day on top. This pass is required. |
| `state.json` | Compose cursor plus your `enrichment` object. |
| `log-YYYY-MM.jsonl` | Raw GPS. Only if a stay has no usable name. |

Personal Agent transcripts (required source): `education/you@example.com/.chat-history/`. See `.cursor/skills/past-chats/SKILL.md`.

Live last-known fix: `education/you@example.com/.location.json` (do not treat as history).

## What "enriched" means

A stay is still vague if it is only a street address, a neighborhood, or a pin with no business/building/activity. After you finish, each stay should say:

- **Where:** business, building, campus, home, someone's house, airport, park, or "unknown street" if you truly cannot tell
- **What:** short activity when you have evidence (dinner, class, hanging out, gym, flight, overnight, working)
- **Who/how** only when it is clear (friend drove, Uber, family)

The 02:30 context-synthesis job may rewrite these files later when it infers more (whose house, why he was there). Leave those corrections in place on the next 01:00 run. Do not revert a specific name back to a street.

### Trips (required)

Compose labels almost every road leg `car`. That is a GPS default, **not** a conclusion. A trip is still vague if the mode is `car` or `rideshare` with no receipt/text evidence.

You **must** search Mail.app for ride receipts covering the trip dates **before** you keep `car`. Do this even when every stay already has a business name, and even in the Seattle metro (the compose job skips Mail at home; you do not).

Upgrade when a receipt or text matches:

- `robotaxi` — Tesla Robotaxi, Waymo, Zoox, Cruise, or any autonomous receipt
- `uber` / `lyft` / `rideshare` — human driver receipts
- `driven` — texts like "I'll pick you up" / "on my way"
- `walk` / `plane` — keep if compose already got this right
- `bike` — Watch cycling or Yan chat. One workout is one trip. Do not split it back into walks
- `car` — only after Mail + iMessage + chat history turned up nothing for that leg

## Context you may use

Look as far as you need. Yan only. Do not dump full threads into the markdown.

- **Calendar:** `node server/calendar-cli.js events --from <ISO> --to <ISO>` (see `.cursor/skills/personal-calendar/SKILL.md`)
- **iMessage:** `node server/imessage-read.js search "…"` / `thread "Name"` (see `.cursor/skills/personal-imessage/SKILL.md`)
- **Mail.app:** ride receipts, reservations, tickets. Required for every `car` trip. Details below.
- **Contacts:** resolve names from numbers (`.cursor/skills/personal-contacts/SKILL.md`)
- **Chat history (required):** Grep and Read `education/you@example.com/.chat-history/` for stay addresses, business/building names, trip modes, and what Yan said he was doing that day. Same rank as Calendar and iMessage. Do not skip because mail or GPS already named something. Do not paste transcripts into `places.md` / `trips.md`. `.cursor/skills/past-chats/SKILL.md`
- **Web search:** street address → business/building. Prefer a real name over leaving the street number.

## Trip pass: Mail.app ride receipts

Do this **after** (or in parallel with) places. One-needle `whose` queries with a date cutoff. Never iterate the whole inbox. Never nest many needles in one script (Exchange will hang).

**Where the receipts actually are:** Tesla Robotaxi and Uber Family receipts land in **Exchange** `Inbox` (`you@example.com`), sender `tesla.com` / `uber.com`. They are usually **not** in Gmail. Gmail's inbox mailbox is `"INBOX"` (all caps), not `"Inbox"`.

Tesla subjects look like `Robotaxi Ride Receipt on August 16, 2026`. Uber subjects look like `Your Saturday afternoon trip with Uber` (sometimes prefixed `[Family]`).

Search Exchange first (swap the subject/sender string; run **separate** scripts):

```bash
osascript <<'APPLESCRIPT'
tell application "Mail"
  set inboxBox to mailbox "Inbox" of account "Exchange"
  set cutoff to (current date) - (14 * days)
  set output to ""
  repeat with m in (messages of inboxBox whose date received > cutoff and subject contains "Robotaxi")
    set output to output & (subject of m) & " | " & (sender of m) & " | " & (date received of m as string) & linefeed
  end repeat
  return output
end tell
APPLESCRIPT
```

Also run the same pattern with `sender contains "tesla.com"`, `sender contains "uber.com"`, `subject contains "trip with"`, `subject contains "Waymo"`, `subject contains "Lyft"`, `subject contains "Zoox"`. Then Gmail if Exchange is empty:

```bash
osascript <<'APPLESCRIPT'
tell application "Mail"
  set a to account "Google"
  set inboxBox to missing value
  repeat with b in mailboxes of a
    if name of b is "INBOX" then set inboxBox to b
  end repeat
  set cutoff to (current date) - (14 * days)
  set output to ""
  repeat with m in (messages of inboxBox whose date received > cutoff and subject contains "Robotaxi")
    set output to output & (subject of m) & " | " & (sender of m) & " | " & (date received of m as string) & linefeed
  end repeat
  return output
end tell
APPLESCRIPT
```

Read one matching body (`content of theMsg`). Extract **only** service, pickup address, dropoff address, start time, end time, duration/distance if present. No fares, no card digits, no full bodies into `trips.md`.

Match a receipt to a GPS leg by overlapping **local** time (job timezone) and pickup/dropoff vs nearby stays. Receipt wins for mode. GPS keeps the path. A stay tagged "ride pickup" makes the **following** trip a ride until receipts say otherwise.

If several Tesla receipts share one calendar day, read each body and match each to a different leg. Do not label every `car` that day `robotaxi` from a single receipt, and do not leave a matching leg as `car`.

## Steps

1. Read `state.json` (`enrichment.lastEnrichmentAt` / `lastEnrichmentDateKey`). If missing, backfill the **last 14 days** only. Leave older days unless `--force`.
2. Read `places.md` **and** `trips.md`. Skip a stay only if it already has a business/building. **Do not skip** a trip whose mode is still `car` / `rideshare`. Force: re-check those even if you enriched places today.
3. Stay pass: calendar, texts, **chat history**, address search. Grep `.chat-history/` for each unenriched stay (address, neighborhood, business guess).
4. **Trip pass (required):** Mail.app receipts as above, then iMessage if mail is empty. Also grep chat history for robotaxi / Uber / "picked me up" / flight mentions covering those dates. Rewrite matching legs.
5. Rewrite that day's sections in place. Keep arrive/leave/dwell. Newest day on top. Do not invent overnight stays.
6. Write `state.json` **keeping** existing compose fields (`lastProcessedReceivedAt`, `lastComposeAt`, `timezone`) and set:

```json
{
  "lastProcessedReceivedAt": "<keep>",
  "lastComposeAt": "<keep>",
  "timezone": "<keep>",
  "enrichment": {
    "lastEnrichmentAt": "<now ISO>",
    "lastEnrichmentDateKey": "<job date key>",
    "timezone": "<job timezone>"
  }
}
```

## Markdown shape

`places.md`:

```markdown
# Places

## 2026-08-16

- **Leon Street Flats** (2302 Leon St, West Campus, Austin, TX) — 18:28–23:30 (5h 2m) — Airbnb overnight
- **Austin Bouldering Project** (979 Springdale Rd, Govalle, Austin, TX) — 15:58–18:17 (2h 19m) — climbing
- **Milos's house** (5403 Roosevelt Ave, Brentwood, Austin, TX) — 14:40–15:44 (1h 4m) — estore work
```

`trips.md`:

```markdown
# Trips

## 2026-08-16

- **robotaxi** 18:17–18:28 — Govalle → West Campus
- **robotaxi** 14:24–14:40 — The Drag → Brentwood (Milos's house)
```

Keep lines short. Real names. No coordinates unless the place is unknown. No fares. Never em dashes in chat replies; markdown here may use `—` as in the existing files.

## Heuristics

- Calendar title at that hour usually wins for "what".
- A Personal Agent chat that names a place, house, or activity around that hour can win for where/what.
- Tesla / Waymo / Zoox / Uber / Lyft receipt wins for mode. Tesla Robotaxi → `robotaxi`, not `car` and not `uber`.
- Texts like "on my way" / "I'll pick you up" → `driven`. Chat mentions of the same ride count as evidence too.
- Airport + city jump already in trips.md as `plane` — add airline/flight only if a ticket/email says so.
- If you cannot tell after Mail + texts + chat history, keep `car` (or the street) rather than guessing a business.
- Do not copy other people's full messages into these files.

## Do not

Do not git-commit. Do not spawn a nested agent. Do not touch Alex's files. Do not send mail or iMessage. Do not skip the trip/mail pass because places already look enriched. Do not skip chat history because Calendar, Mail, or GPS already ran.
