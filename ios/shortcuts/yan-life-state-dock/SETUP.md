# Yan Life State Dock

Stub iPhone Shortcut. It POSTs `intent` + `orientation` to the Mac 5-minute log. No automation baked in. You add Get Device Orientation, Bedroom Boolean, and the Ifs.

Portrait → `going_to_shower`. Landscape → `going_to_sleep`. Skip the POST when Bedroom Boolean is off.

## Add it (once)

1. Files → iCloud Drive → YanLifeState → Yan Life State Dock → Add Shortcut.
2. Open it. Replace the two Set Variable actions (Intent / Orientation) with your own Ifs, or wrap the Get Contents of URL block in those Ifs.
3. Hook it from the existing plug-in automation, or paste the POST actions into that Shortcut.
4. Run it once from Shortcuts to Allow network / confirm the POST.

Silent on success. You only get a notification if `received` is not `yes`. A dead network still shows Shortcuts' own error.

The Mac writes `education/you@example.com/life-state/intent.json` and kicks a life-state guess so the log does not wait five minutes.
