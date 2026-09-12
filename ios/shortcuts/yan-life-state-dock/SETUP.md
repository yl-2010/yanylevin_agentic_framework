# Life-state phone Shortcuts

Four Shortcuts. Import each from iCloud Drive → YanLifeState. You add the automations. The POSTs are already filled.

Delete older copies in Shortcuts first, then Add Shortcut.

Silent on success. A banner only if `received` is not `yes`.

## Yan Life State Dock

Automation: iPhone is connected to power.

Four Get Contents of URL blocks. The two leftover `plugged_in` copies are at the top so you can drop each into its own place in the If tree. Shower and sleep are below.

1. Plugged in (copy 1). `plugged_in`. One leftover branch (Bedroom Boolean off, or on but not the stand ritual).
2. Plugged in (copy 2). Same POST. The other leftover branch.
3. Shower. `going_to_shower` + portrait. Portrait / Bedroom Boolean on branch.
4. Sleep. `going_to_sleep` + landscape. Landscape / Bedroom Boolean on branch.

Do not run more than one.

## Yan Life State Unplug

Automation: iPhone is disconnected from power. One POST, `unplugged`. No Ifs.

## Yan Life State Driving Focus

Automation: Driving Focus turns on. One POST, `driving_focus`.

iOS also turns Driving Focus on in any car, including as a passenger. Tesla Bluetooth is how the Mac knows it is the Tesla. Flipping to Personal Focus and back is the same trip (15 minute resume). Do not treat that blip as a new drive.

## Yan Life State Tesla

Automation: Tesla Bluetooth connects. One POST, `tesla_bluetooth`. This is the Tesla, not any car. Brief Bluetooth drops are the same trip (10 minute resume).

The Mac writes `education/you@example.com/life-state/intent.json` and appends the send to `signals-YYYY-MM.jsonl`. That does not start a 5-minute guess. The scheduled tick still starts on the clock (:00, :05, :10, …) and reads those sends. Snapshot field `phoneSignals` is extra for the agent (`recent` plus by-kind keys). Automations often fail while the phone is locked, so a missing POST is expected.
