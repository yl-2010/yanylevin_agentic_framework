# Yan Levin iOS app

Native SwiftUI companion to [yanylevin.com](https://yanylevin.com). Universal for **iPhone and iPad** (`TARGETED_DEVICE_FAMILY: 1,2`) with adaptive layouts: wide canvas on iPad and landscape (2-column Home cards / Education matching the website; Timeline stays single-column).

## Requirements

- Xcode 26+ (for Liquid Glass APIs; app also runs on iOS 18+ with material fallback)
- Apple Developer Program (signing, Sign in with Apple, App Store)
- Google Cloud OAuth **iOS** client ID (bundle `com.example.personalagent`)
- Production site + Mac API (`api.yanylevin.com`) with LM Studio + Personal Agent for chat features

## Generate / open

```bash
cd ios/YanLevin
xcodegen generate
open YanLevin.xcodeproj
```

## Sign-in

- **Sign in with Apple** — native; exchanges identity token via `POST /api/auth/mobile`. Temporarily **disabled for Personal Team device installs** (free teams cannot provision the capability). Code + AuthStore path remain; restore by uncommenting `com.apple.developer.applesignin` in `YanLevin.entitlements` / `project.yml` and setting `AccountView.signInWithAppleEnabled = true` under a paid Apple Developer team.
- **Sign in with Google** — `ASWebAuthenticationSession` opens `/api/auth/google?mobile=1`, then the existing web OAuth callback redirects to `personalagent://oauth?token=…` with a mobile JWT (no separate Google iOS OAuth client required). Optional native Google SDK path still works if `GOOGLE_IOS_CLIENT_ID` is set.

## Features

| Audience | Tabs |
|----------|------|
| Guests | Home (portfolio), Chat (visitor → Mac gpt-oss), Account |
| Full access (`you@example.com` / `you@icloud.com`, `you@example.com` / `you@icloud.com`) | Opens on **Chat** (tab order is Account → Fitness → Education; Chat is the prominent slot on iPhone). Education (classes/todos) and Fitness are extra tabs. Chat defaults to Personal Agent, with a top-right circle toggle (person ↔ YL) for public chat. Guests still open on Home. While the Personal Agent is working, tap Send to queue (max 8). Hold Send for 2 seconds, then release, to interrupt the live turn and send immediately; already-queued bubbles wait until that turn ends. Same hold-to-interrupt on `/education` web chat. |

Yan’s **iPhone** session may send location to the Mac API (`POST /api/education/location`) so the Personal Agent (web and iPad included) knows where the phone is. Chat maps on iPhone and iPad still use on-device GPS for the blue dot and expanded map. The **iPad app does not upload location** or write stay/trip history; agent context uses the iPhone feed on the Mac. Each iPhone post overwrites that fix and appends a private history log. Location ingest is Yan-only. Allow **Always** in iPhone Settings if you want updates while the phone is in the pocket: significant-change (~500m), visits, and a raw 15-minute heartbeat (no extra agents). After a swipe-kill, heartbeats pause until the app is opened again; significant-change and visits can still relaunch on a move.

### Fitness

| Surface | Role |
|---------|------|
| **iPhone portrait** | Input — offset buttons, recent boxes, short chart, fitness-agent type bar (log sets) |
| **iPhone landscape** | Same input controls in a three-column layout (recent \| chart + type bar \| offsets) |
| **iPad** | Browse — mirrors `/fitness`: Overview multi-machine chart, machine sidebar, range chips (10/25/50/100/All), filter orbs, sets / all-time max, full session history. Liquid Glass chrome; no logging controls |
| **Web `/fitness`** | Same browse experience as iPad |

Apple/iCloud emails alias onto the same Gmail-backed account folders — Google and Apple sign-in are interchangeable for Yan and Alex.

### Education widgets (full-access only)

Home Screen widgets require a signed-in allowlisted account (session mirrored via App Group `group.com.example.personalagent`):

| Widget | Sizes | Behavior |
|--------|-------|----------|
| **Schedule** | 2×2, 2×4, 4×4 | Upcoming classes. Small/medium show 4; large shows up to 8 split by the same day groups as `/education`. |
| **Todos** | 2×2, 2×4, 4×4; iPad also 8×4 | Upcoming open todos (6 / 6 / 8; iPad extra-large: 16 in two columns). Small and medium are title-only (no due/class lines). Large keeps due + class. Widget settings: CW/HW/QA/MA/untagged filters plus optional class filter. Tap the circle to complete; tap the title to open that todo in the app. |

Enable App Groups for both the app and `com.example.personalagent.widgets` in the Apple Developer portal (**paid Apple Developer Program required** for a physical device). Without that, widgets cannot read your login session. The Simulator often still creates the App Group from the entitlements file alone.

### Lock Screen Chat control

iOS 18 Control (the two circles at the bottom of the Lock Screen, flashlight and camera by default). It also appears in Control Center. The app cannot assign the slot for you.

1. Lock Screen → hold → **Customize** → tap a bottom circle.
2. Search **Chat** / Yan Levin and pick it.

Tap opens a **new** Personal Agent chat (the previous thread stays in history). The phone must be unlocked first (iOS requirement). Deep link: `yanylevin://chat`.

The control uses the YL app mark. After installing an update, remove the old circle and add **Chat** again. iOS caches the previous icon and intent.

**Not included:** one-off personal pages. Dashboard is web-only.

## App Store Review notes (paste into Connect)

> Chat and the Personal Agent require Yan’s Mac Studio API (`api.yanylevin.com`) with LM Studio and the local Cursor personal agent online. If those services are down, the app shows an offline message. Sign-in: Google and Sign in with Apple. Full Education access is limited to allowlisted accounts; demo account: contact developer. Privacy Policy: https://yanylevin.com/privacy/

## TestFlight

1. Archive in Xcode → Distribute → App Store Connect  
2. Enable Sign in with Apple capability for the App ID  
3. Attach privacy nutrition labels without treating iPad map GPS as a second agent location source: email (auth) and product interaction (chat) on both; **precise location on both for in-app maps**; iPhone additionally posts location to the Mac.

## Liquid Glass

iOS 26+ uses native Liquid Glass via UIKit `UIGlassEffect` (panels/capsules) and SwiftUI `buttonStyle(.glass)`. Older iOS uses `.ultraThinMaterial` with the same layouts and networking — no feature gating.

SwiftUI’s `glassEffect(_:in:)` from the iOS 27 SDK does not resolve on iOS 26 runtimes (mangled symbol mismatch). Chrome therefore uses `UIGlassEffect`, with a runtime-safe initializer (`effectWithStyle:` when present, plain `init` on early iOS 26.0).
