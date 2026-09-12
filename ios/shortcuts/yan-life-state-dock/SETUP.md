# Life-state phone Shortcuts

Four Shortcuts. Import each from iCloud Drive → YanLifeState. You add the automations. The POSTs are already filled.

Delete older copies in Shortcuts first, then Add Shortcut.

Silent on success. A banner only if `received` is not `yes`.

## Yan Life State Dock

Automation: iPhone is connected to power.

Three Get Contents of URL actions:

1. Shower. `going_to_shower` + portrait. Portrait / Bedroom Boolean on branch.
2. Sleep. `going_to_sleep` + landscape. Landscape / Bedroom Boolean on branch.
3. Plugged in. `plugged_in`. Everything else (Bedroom Boolean off, or on but not the stand ritual).

Do not run all three.

## Yan Life State Unplug

Automation: iPhone is disconnected from power. One POST, `unplugged`. No Ifs.

## Yan Life State Driving Focus

Automation: Driving Focus turns on. One POST, `driving_focus`.

iOS also turns Driving Focus on in any car, including as a passenger. Tesla Bluetooth is how the Mac knows it is the Tesla. Flipping to Personal Focus and back is the same trip (15 minute resume). Do not treat that blip as a new drive.

## Yan Life State Tesla

Automation: Tesla Bluetooth connects. One POST, `tesla_bluetooth`. This is the Tesla, not any car. Brief Bluetooth drops are the same trip (10 minute resume).

The Mac writes `education/you@example.com/life-state/intent.json` and appends the send to `signals-YYYY-MM.jsonl`. That does not start a 5-minute guess. The scheduled tick still starts on the clock (:00, :05, :10, …) and reads those sends. Snapshot field `phoneSignals` is the agent datasource (`recent` plus by-kind keys).
