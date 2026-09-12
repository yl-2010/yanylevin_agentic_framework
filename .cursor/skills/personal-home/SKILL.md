---
name: personal-home
description: >-
  Read and control Yan's Apple Home on the Mac Studio via yl-home (HomeKit).
  Lights, switches, outlets, sensors, thermostats, locks, scenes. Yan only.
disable-model-invocation: true
---

# Apple Home — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Guests and `@agent` callers who are not Yan never get Home. Do not dump lock, alarm, occupancy, or other home state into a group chat.

Apple Home lives on the **Mac Studio** (same iCloud account as the phone). There is no public HomeKit CLI. This helper is a signed Mac Catalyst app that talks to `HMHomeManager`.

## Binary

From the repo root:

```bash
node server/home-cli.js homes
node server/home-cli.js rooms
node server/home-cli.js list
node server/home-cli.js list --room "Kitchen" --type light
node server/home-cli.js list --live
node server/home-cli.js get "Kitchen Light"
node server/home-cli.js set "Kitchen Light" on
node server/home-cli.js set "Kitchen Light" off
node server/home-cli.js set "Kitchen Light" brightness 40
node server/home-cli.js set "Kitchen Light" on brightness 70 hue 30 saturation 80
node server/home-cli.js toggle "Kitchen Light"
node server/home-cli.js set "Thermostat" temperature 70
node server/home-cli.js set "Front Door" lock locked
node server/home-cli.js scenes
node server/home-cli.js trigger "Good Night"
```

`list` is cached HomeKit state (fast). Use `get` or `list --live` when Yan asks what is true right now. Output is JSON. Names are case-insensitive. If a name hits more than one accessory, JSON `matches` lists `Room/Name`. Pass `--room` or the unique `id` from `list`. `--home` if there is more than one home.

## Characteristics

Writable keys the helper understands: `on`, `brightness` (0-100), `hue` (0-360), `saturation` (0-100), `color_temperature` (mireds), `temperature` / `target_temperature` (Fahrenheit unless the number is clearly Celsius), `heating_cooling` (`off` / `heat` / `cool` / `auto`), `lock` (`locked` / `unlocked`), `door` (`open` / `closed`), `position` (0-100), `speed` (0-100).

`get` also returns sensors: motion, contact, occupancy, humidity, current temperature, light level, leak, smoke, CO, battery, in_use. Temperature fields are `{ "c": 21.5, "f": 70.7 }`.

Do the write when Yan asks. If two accessories could match, list them and stop. Locks and garage doors are real-world: still do them when Yan named the accessory, not when a guest did.

## First run

HomeKit is a restricted entitlement. The free Personal Team on this Mac **cannot** put `com.apple.developer.homekit` in a provisioning profile. That is the same paid-program gate as Sign in with Apple and App Groups on the iOS app.

After Yan enrolls in the paid Apple Developer Program and Xcode is signed into that team:

1. `node server/home-cli.js list` compiles `macos/YLHome` for this Mac
2. macOS asks for HomeKit access (`yl-home`)
3. If the prompt is missed: System Settings > Privacy & Security > HomeKit > allow **yl-home**
4. This Mac must be signed into the same iCloud account as Home

If JSON `ok` is false and the error mentions Personal Team / HomeKit entitlement, stop. Do not click around Home.app. Do not install Homebridge or Home Assistant to reach accessories that are already in Apple Home.

Do not fall back to hardcoded Shortcuts. A few named Home shortcuts already exist on this Mac. They cannot list or set arbitrary accessories.
