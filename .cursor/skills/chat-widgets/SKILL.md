---
name: chat-widgets
description: >-
  Format Personal Agent chat widgets (map, html, image fences) for iOS Chat
  and /education web chat. Use when emitting maps, location cards, images,
  charts, or interactive viz under the markdown bubble.
disable-model-invocation: true
---

# Chat widgets

Read this skill before emitting any widget fence. Do **not** put widget recipes in the text bubble.

The text bubble is markdown only. Interactive cards sit in a swipeable carousel **under** that bubble. Append fences at the **end** of the reply. Express strips them from `content` and sends `widgets`.

**Never markdown images.** `![alt](url)` does not render on iOS. Use an image widget. **Never HTML in the markdown bubble** (tags show as raw text). HTML is allowed only inside `widget html` fences.

````
Short intro in the text bubble.

```widget map
{"pins":[{"id":"juanita","lat":47.705,"lng":-122.207,"title":"Cafe Juanita","subtitle":"Italian","description":"Quiet Kirkland Italian with a serious wine list and a patio that stays calm even on busy nights. A strong sit-down pick when you want a real dinner, not a downtown scene."}]}
```
````

- `map`: one per reply (multiple fences merge). Pins need `id`, `lat`, `lng`, `title`. Optional `subtitle` is one short line (cuisine, neighborhood, hours). **Always emit the full map + pins even on web** so iPhone can open the same thread. Web hides the map canvas and shows a small “View map on iOS” chip plus location cards; iOS shows the live map. Never skip maps because the prompt came from the browser. Hours in subtitle or description follow **Place hours** below.
- Each pin automatically becomes a following **glass location card** with that title, subtitle, and description as normal text. **Do not emit `widget html` for restaurants / places.** Do not set card background colors.
- `html`: only for custom charts or interactive viz that is not a location card. Optional `id=` + `theme=light` / `theme=dark` when colors matter. For colored custom viz, two fences with the same `id=`: `theme=light` and `theme=dark`.
- `image`: HTTPS URL only, one photo per card. JSON `{"url":"https://...","alt":"optional"}` or a bare https URL. Add more image widgets for a gallery.
- Keep the text bubble a short intro; pin title, subtitle, and description are the cards.

## Location card `description` (required)

Every map pin must include `description`: **1–2 full sentences** for that location card (one sentence at least, two preferred). That text is the card body. Write what the place is and why it fits this ask.

- **Never** a one-word label, fragment, cuisine name, or neighborhood alone (`"Italian"`, `"Cafe"`, `"Kirkland"`). Those belong in optional `subtitle`.
- Do not leave `description` empty. Do not copy `subtitle` into `description`. One word looks broken on the card.

Bad: `"description": "Italian"`
Good: `"description": "Quiet Kirkland Italian with a serious wine list and a patio that stays calm even on busy nights. A strong sit-down pick when you want a real dinner, not a downtown scene."`

Nearby / around-me answers should still use a map widget with pins (lat/lng + title + description). Read `.cursor/skills/phone-location/SKILL.md` for Yan’s lat/lng, then emit the map fence from this skill.

## Place hours

Do **not** trust Apple Maps opening times. Before stating hours in the bubble, subtitle, or description:

1. Fetch the place’s official website hours page if one exists (library, cafe, gym, store).
2. If there is no site, or the site does not list hours, use **Google Maps** hours.
3. If you cannot verify, say so. Never quote Apple Maps hours as the answer.
