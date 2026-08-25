# Yan Health Sync

One iPhone Shortcut. It reads Apple Health and POSTs a JSON dump to the Mac Personal Agent. No paid Apple Developer account. No automation. Tap it when you want.

Workouts come from the Actions app, Find Workout. Sleep and the other vitals use Find Health Samples.

iOS 27 picker labels: Exercise Time (not Exercise Minutes), Stand Time (not Stand Hours), Sleep Wrist Temperature, Mindful Session. The "is in the last 2" row must use days, calendar unit 16.

Each Health query is capped at 120 samples so Active Calories cannot blow up the run.

## Add it (once)

1. Actions must already be installed.
2. Delete older Yan Health Sync copies in Shortcuts, including 2 and 3.
3. Files → iCloud Drive → YanHealth → Yan Health Sync → Add Shortcut.
4. Open Actions → Permissions → Grant Health Access.
5. Run it. Allow Health for each Find Health Samples type it asks about.
6. Settings → Shortcuts → Advanced → turn on Allow Sharing Large Amounts of Data.

Health permissions live at Health → profile photo → Apps → Actions and Shortcuts. Not under Browse → Sleep.

Run it again whenever. Several times a day is fine. The Mac overlaps dumps and keeps history. A successful POST is silent. You only get a notification if the dump did not reach the Mac. A dead network still shows Shortcuts' own error.

The 1am Composer job on the Mac picks up whatever arrived since the last takeaways pass.

## What it sends

- Workouts from Actions Find Workout, latest 20 (about 2 days; the action has no date filter)
- Sleep, steps, distance, calories, exercise/stand, resting HR, HRV, and the other vitals it can see, last 2 days, at most 120 samples each
- Walking gait, running form, hearing, Heart Rate Recovery, swimming: last 2 days
- Every Find Health Samples window is 2 days. Nothing at 14.
- Not queried: UV Index, State of Mind, cycling speed/cadence, Time in Daylight, Physical Effort, Workout Effort Score. Cycling Distance stays.

Raw heart-rate beats are skipped on purpose. History already on the Mac stays.
