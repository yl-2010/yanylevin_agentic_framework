---
name: phone-location
description: >-
  Read Yan's last-known iPhone location and composed stay/trip history.
  Use when the user asks where Yan is, where he was, how he got somewhere,
  what's nearby, or needs lat/lng for a map. Yan only — never for Alex.
disable-model-invocation: true
---

# Phone location — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Never read `.location.json` or `location/` for Alex.

## Live (where Yan is)

Read `education/you@example.com/.location.json` when you need where Yan is **now**. It is the phone’s GPS, not this Mac Studio (the Studio stays home).

Typical fields: `latitude`, `longitude`, optional `accuracyMeters`, `timestamp` / `receivedAt`, `source` (`ios` / `visit` / `periodic`), motion (`speedMps`, `courseDegrees`, `altitudeMeters`), `visitKind`, and place labels. Treat a fix older than about 6 hours as stale and say so.

## History (where Yan was / how he got there)

Do **not** dump history into every turn. When the question is about today, yesterday, a trip, “where was I”, or “how did I get here”, read these files first:

- `education/you@example.com/location/places.md` — stays with arrive/leave/dwell (enriched overnight with business/building/activity when known)
- `education/you@example.com/location/trips.md` — walk / car / driven / plane / uber / robotaxi / lyft paths

Only open `log-YYYY-MM.jsonl` if the markdown is missing or the question needs raw coordinates. Do not invent a timeline from `.location.json` alone.

A scheduled Composer job at 01:00 (and every 4h if new points) updates the markdown from the JSONL (and Mail.app ride receipts when traveling). A separate Grok 4.6 job at 01:00, after compose, enriches those lines with what Yan was doing. Context synthesis at 02:30 may rewrite a stay or trip when it infers more (whose house, robotaxi not car). At 03:00 a Composer job projects named stays into durable `education/you@example.com/brain/places/` cards. If markdown is behind the live fix, say the history may be a few hours stale.

## Do not

Do **not** scrape Find My, do **not** run Mac Shortcuts for location, and do **not** use Core Location on the Mac. Chat turns should not search Mail for receipts; that is the compose job.

The **iPhone** app posts `POST /api/education/location` while Yan is signed in (When In Use, and Always if he allows background). Always: significant-change (~500m) plus visit monitoring, and a 15-minute heartbeat tagged `source: "periodic"` (raw `.location.json` + JSONL only; does not start compose/enrichment). Force-quit stops the 15-minute heartbeat until the app is opened again; significant-change and visits still relaunch the app and post. Chat maps on iPhone and iPad may use on-device GPS for the blue dot; the **iPad app does not post** to this ingest or send `phoneLocation` in agent uiContext. Chat from iPad still uses this iPhone feed on the Mac. An iPhone Shortcut can post the same URL with `Authorization: Bearer` + `LOCATION_INGEST_TOKEN` from `server/.env` if the app is not running.

For maps / nearby, use this lat/lng then Read `.cursor/skills/chat-widgets/SKILL.md` before emitting a map widget. Every pin needs a **1–2 sentence `description`** (one full sentence at least) for the location card. Never one-word card copy like `"Italian"` or `"Cafe"`. Hours for a nearby place: official website first, then Google Maps. Never Apple Maps hours alone.
