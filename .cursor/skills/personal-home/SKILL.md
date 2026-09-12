---
name: personal-home
description: >-
  Read and control Yan's Apple Home on the Mac Studio via HomeClaw
  (homeclaw-cli). Lights, switches, outlets, sensors, thermostats, locks,
  scenes. Yan only.
disable-model-invocation: true
---

# Apple Home — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill. Guests and `@agent` callers who are not Yan never get Home. Do not dump lock, alarm, occupancy, or other home state into a group chat.

## How it is wired

Apple Home lives on the **Mac Studio** (same iCloud account as the phone). There is no public HomeKit CLI, and this repo cannot sign `com.apple.developer.homekit` (Personal Team).

`HomeClaw.app` (Mac App Store, `/Applications/HomeClaw.app`) is the entitled process. It sits in the menu bar, talks to `HMHomeManager`, and listens on a local Unix socket. `homeclaw-cli` is a socket client with no HomeKit entitlement of its own. `node server/home-cli.js` finds that CLI and adds a few aliases (`on`/`off`, `lock`, `toggle`, `homes` → `status`).

The lobster icon has to stay running. Launch at Login from the menu bar icon. `macos/YLHome` is unused leftover. Do not compile it.

This home is named **New House**. HomePods and Apple TVs never appear. Apple does not put them on `HMHome.accessories`.

**Bedroom Boolean** (outlet in Yan's Bedroom) is not a lamp. On means motion was last detected in Yan's bedroom. Off means motion was last detected in the office. Fairly accurate for those two rooms. He can still be downstairs or in the bathroom. Do not treat it as a light. Do not dump its UUID.

## First action in a session

```bash
node server/home-cli.js device-map
```

or `list` / `search` if the map is huge. Match Yan's words to `display_name` and `room`. Check `type` and `controls` before writing. Duplicate names are common. `get` then `set` with the accessory `id` UUID, not the display name.

## Commands

From the repo root. Output is JSON. Pass `--json` is already added for reads.

```bash
node server/home-cli.js status
node server/home-cli.js list
node server/home-cli.js list --room "Yan’s Bedroom" --category lightbulb
node server/home-cli.js search "bedroom"
node server/home-cli.js get "Kitchen Light"
node server/home-cli.js set "<uuid-or-name>" on
node server/home-cli.js set "<uuid-or-name>" off
node server/home-cli.js set "<uuid-or-name>" brightness 40
node server/home-cli.js set "<uuid-or-name>" on brightness 70 hue 30 saturation 80
node server/home-cli.js toggle "<uuid-or-name>"
node server/home-cli.js set "<uuid-or-name>" temperature 70
node server/home-cli.js set "<uuid-or-name>" heating_cooling auto
node server/home-cli.js set "<uuid-or-name>" lock locked
node server/home-cli.js set "<uuid-or-name>" position 100
node server/home-cli.js scenes
node server/home-cli.js trigger "Good Night"
```

`set` aliases: `on`/`off` → `power true/false`, `lock` → `lock_target_state`, `temperature` → `target_temperature`, `heating_cooling` → `target_heating_cooling`, `position` → `target_position`. Native HomeClaw names also work (`power`, `brightness`, `hue`, `saturation`, `color_temperature`). One HomeClaw `set` is one characteristic. The wrapper splits `on brightness 70` into two calls.

`--type` on `list` becomes `--category`. HomeClaw categories include `lightbulb`, `switch`, `outlet`, `thermostat`, `lock`, `window_covering`, `fan`, `sensor`.

## What you can set

| `type` | Typical `controls` |
| --- | --- |
| `lighting` | `power`, `brightness` (0-100), sometimes `hue`, `saturation`, `color_temperature` |
| `power` | `power` only. A "light" with this type is a relay. Do not send `brightness`. |
| `climate` | `target_temperature`, `target_heating_cooling` (`off` / `heat` / `cool` / `auto`) |
| `door_lock` | `lock_target_state` (`locked` / `unlocked`) |
| `window_covering` | `target_position` (0 closed, 100 open) |
| `sensor` | read-only |

If `set` says `power` is ambiguous (multi-gang switch), retry with `--service-name`, `--service-index`, or `--service-id` from that error. Do not guess.

Do the write when Yan asks. If two accessories could match, list `Room/Name` plus `id` and stop. Locks and garage doors are real-world: still do them when Yan named the accessory, not when a guest did.

## If it fails

HomeClaw is not in this repo. Yan already installed it from the Mac App Store (https://apps.apple.com/us/app/homeclaw/id6759682551?mt=12). TestFlight fallback: https://testflight.apple.com/join/zjSnz8eK.

- Not installed → tell Yan to install from that App Store link, then retry.
- Not running / socket → tell Yan to open HomeClaw, click Allow for HomeKit, leave the menu bar icon up, then retry.
- Missed the HomeKit prompt: System Settings → Privacy & Security → HomeKit → HomeClaw on.

Do not click around Home.app. Do not install Homebridge or Home Assistant. Do not fall back to hardcoded Shortcuts. A few named Home shortcuts already exist on this Mac. They cannot list or set arbitrary accessories.
