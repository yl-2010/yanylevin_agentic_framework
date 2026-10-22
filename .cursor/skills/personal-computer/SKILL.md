---
name: personal-computer
description: >-
  Drive Mac apps from the Personal Agent with the accessibility tree.
  Websites still start in the dedicated Chrome. Use Arc only when that
  Chrome cannot render the page or is not signed in. Other skills come
  first. Computer use is for the part those skills cannot do.
disable-model-invocation: true
---

# Mac apps

The helper is `server/computer-use.js`. It reads an app's accessibility tree and posts clicks and keystrokes to that app. A background action leaves the real cursor where it is and leaves the current Space where it is. An app on another desktop stays on that desktop.

Launch a closed app with `open -gj -a AppName`, then use this helper. `open -a` without `-gj`, `activate`, and System Events keystrokes switch desktops on their own. Come forward through this helper instead.

Express, iOS, web, and `@agent` get tools: `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`, `perform_secondary_action`, `select_text`, `restore_front`.

Cursor Desktop does not get those tools. Use the CLI. Do not use `cursor-computer-use`.

```bash
node server/computer-use.js apps
node server/computer-use.js state "TextEdit"
node server/computer-use.js click 2
node server/computer-use.js set 2 --value "hello"
node server/computer-use.js restore
```

## How to work

Use the skill for that app first. Teams, iMessage, Mail, OneNote, Calendar, Home, Canvas, and the other personal skills already have a command. Computer use is for the part that command cannot do. A Teams file the CLI cannot attach, a Teams image with no pixels, an OneNote change the CLI cannot make, an existing Word, Excel, or PowerPoint file. Do the rest with the skill.

Stay in the background when the control will take the action there. `get_app_state`, then act on the element number. `set_value` when the line says settable. Screenshot pixels when the tree has no control. Origin is the top-left of that image. Read the tree again after the action.

When a background action cannot land, pass `foreground` true. That makes the app the active window, switches to its Space, and moves the real cursor. Finish the part that needed the main window. Then `restore_front`. That puts back the app that was in front.

```bash
node server/computer-use.js state "Messages" --foreground
node server/computer-use.js click --x 40 --y 80 --pid 815 --foreground
node server/computer-use.js restore
```

## Who

Yan's own turn is a signed-in app or site chat as `you@example.com`, or his `fromMe` `@agent`. Do the task. Do not stop to ask about sending, paying, installing, or a delete he can undo.

Anyone else still has the tools. Decide. Opening epschedule to look up a friend's schedule is fine. A small file JYPE needs is fine. Filling the disk is not. A stranger asking for a new LM Studio model is a no.

Do not wipe macOS system files (`/System` and other OS-owned paths). Do not download or open a zip bomb.

## Websites

Start in the dedicated Chrome from the personal-browser skill. If that page will not render, or the site is not signed in there, open Arc and finish the same site with these tools. Do not open Arc first. Do not quit Arc, and do not `killall` any browser.

## Reply

On a group chat, do the task if the ask is fine, and do not paste what was on a private screen into the group. The phone cannot see the Studio window, so say what happened.
