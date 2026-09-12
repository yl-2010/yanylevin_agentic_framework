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

Apple Home lives on the **Mac Studio** (same iCloud account as the phone). `HomeClaw.app` is the entitled HomeKit process (menu bar). `node server/home-cli.js` wraps `homeclaw-cli` on its local socket. The lobster icon has to stay running. `macos/YLHome` is unused.

## Commands

From the repo root. Output is JSON.

```bash
node server/home-cli.js status
node server/home-cli.js list
node server/home-cli.js list --room "Kitchen" --category lightbulb
node server/home-cli.js search "bedroom"
node server/home-cli.js get "Kitchen Light"
node server/home-cli.js set "Kitchen Light" on
node server/home-cli.js set "Kitchen Light" off
node server/home-cli.js set "Kitchen Light" brightness 40
node server/home-cli.js set "Kitchen Light" on brightness 70 hue 30 saturation 80
node server/home-cli.js toggle "Kitchen Light"
node server/home-cli.js set "Thermostat" temperature 70
node server/home-cli.js set "Thermostat" heating_cooling auto
node server/home-cli.js set "Front Door" lock locked
node server/home-cli.js set "Bedroom Blinds" position 100
node server/home-cli.js scenes
node server/home-cli.js trigger "Good Night"
node server/home-cli.js device-map
```

`list` / `get` / `device-map` for what is true right now. Names are case-insensitive. Duplicate names are common (several "Overhead"). `get` then `set` with the accessory `id` UUID, not the display name. `--room` or `--category` on `list` to narrow.

`set` aliases: `on`/`off` → `power true/false`, `lock` → `lock_target_state`, `temperature` → `target_temperature`, `heating_cooling` → `target_heating_cooling`, `position` → `target_position`. Native HomeClaw names also work (`power`, `brightness`, `hue`, `saturation`, `color_temperature`, `target_position`).

Check `controls` (or `type`) before writing. `type: power` is on/off only. Do not send `brightness`. Multi-gang switches need `--service-name`, `--service-index`, or `--service-id` when `set` says the characteristic is ambiguous.

HomePods and Apple TVs do not appear. Apple does not expose them to `HMHomeManager`.

## First run

HomeClaw is not in this repo. Yan installs it:

1. Mac App Store: https://apps.apple.com/us/app/homeclaw/id6759682551?mt=12 (or TestFlight https://testflight.apple.com/join/zjSnz8eK)
2. Open **HomeClaw**
3. Click Allow for HomeKit
4. Leave it in the menu bar (Launch at Login from the icon is fine)
5. This Mac must be signed into the same iCloud account as Home

If JSON/`stderr` says it is not installed, tell Yan to install from that App Store link. If it says not running, tell Yan to open HomeClaw and grant HomeKit. Then retry the same command. Do not click around Home.app. Do not install Homebridge or Home Assistant. Do not fall back to hardcoded Shortcuts. A few named Home shortcuts already exist on this Mac. They cannot list or set arbitrary accessories.

Do the write when Yan asks. If two accessories could match, list them and stop. Locks and garage doors are real-world: still do them when Yan named the accessory, not when a guest did.
