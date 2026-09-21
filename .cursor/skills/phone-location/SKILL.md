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

Typical fields: `latitude`, `longitude`, optional `accuracyMeters`, `timestamp` / `receivedAt`, `source` (`ios` / `visit` / `periodic`), motion (`speedMps`, `courseDegrees`, `altitudeMeters`), `visitKind`, place labels, and optional `device` (`batteryLevel`, `charging`, `lowPowerMode`, `network`, `ssid`, `audio`, `postedAt`). This is last-known, not a live 5-minute tick. Sitting still does not post again until iOS wakes the app on a significant move (~500m), a visit, or he opens the app. That silence is expected. Do not treat it as a failure. Use the last pin as where he still is unless calendar, life-state, or iMessage says he moved. If you mention age, say last-known at that time, not that GPS is broken.

## History (where Yan was / how he got there)

Do **not** dump history into every turn. When the question is about today, yesterday, a trip, “where was I”, or “how did I get here”, read these files first:

- `education/you@example.com/location/places.md` — stays with arrive/leave/dwell (enriched overnight with business/building name when known; not indoor activity)
- `education/you@example.com/location/trips.md` — walk / bike / car / driven / plane / uber / robotaxi / lyft paths

Only open `log-YYYY-MM.jsonl` if the markdown is missing or the question needs raw coordinates. Do not invent a timeline from `.location.json` alone.

A scheduled Grok 4.7 high job at 01:00 (and every 4h if new points) updates the markdown from the JSONL (and Mail.app ride receipts when traveling). A separate Grok 4.7 xhigh job at 01:00, after compose, names businesses/buildings and trip modes. Indoor activity stays in life-state. Context synthesis at 02:30 may rewrite a stay or trip when it infers more (whose house, robotaxi not car), still as an address, not a room tour. At 03:00 a Grok 4.7 high job projects named stays into durable `education/you@example.com/brain/places/` cards. If markdown is behind the live fix, say the history may be a few hours stale.

## Do not

Do **not** scrape Find My, do **not** run Mac Shortcuts for location, and do **not** use Core Location on the Mac. Chat turns should not search Mail for receipts; that is the compose job.

The **iPhone** app posts `POST /api/education/location` while Yan is signed in (When In Use, and Always if he allows background). Always: significant-change (~500m) plus visit monitoring, and a 5-minute heartbeat tagged `source: "periodic"` (raw `.location.json` + JSONL only; does not start compose/enrichment). The heartbeat also sends a `device` bundle (battery, charging, wifi/cellular, audio route, SSID when iOS allows) and `idiom: "phone"`. The 5-minute timer only fires while the iPhone app process is actually running. Sitting still does not wake it. iOS wakes the app again on a significant move (~500m) or a visit. Force-quit also stops the timer until the app is opened again; significant-change and visits still relaunch the app and post. Chat maps on iPhone and iPad may use on-device GPS for the blue dot. The **iPad app must not** start that timer, post to this ingest, send `phoneLocation` in agent uiContext, or send a `device` bundle. The Mac rejects `idiom: "pad"` so an iPad pin cannot overwrite the iPhone. Chat from iPad still uses this iPhone feed on the Mac. An iPhone Shortcut can post the same URL with `Authorization: Bearer` + `LOCATION_INGEST_TOKEN` from `server/.env` if the app is not running.

For maps / nearby, use this lat/lng then Read `.cursor/skills/chat-widgets/SKILL.md` before emitting a map widget. Suggested places (nearby, restaurants, hangouts) need **at least 5 pins**. Every pin needs a **1–2 sentence `description`** (one full sentence at least) for the location card. Never one-word card copy like `"Italian"` or `"Cafe"`. Hours for a nearby place: official website first, then Google Maps. Never Apple Maps hours alone.
