---
name: personal-computer
description: >-
  Drive Mac apps from the Personal Agent with the accessibility tree.
  Websites still start in the dedicated Chrome. Use Arc only when that
  Chrome cannot render the page or is not signed in. Yan's own chats have
  full permissions. Other people are a judgment call.
disable-model-invocation: true
---

# Mac apps

The helper is `server/computer-use.js`. It reads an app's accessibility tree and posts clicks and keystrokes to that app. The real cursor stays put. The user's Space stays put. An app on another desktop stays on that desktop.

Do not `open -a` without `-gj`. Do not `tell application "…" to activate`. Do not send keystrokes through System Events. Those switch desktops. If the app is not running, `open -gj -a AppName`, then use this helper.

Express, iOS, web, and `@agent` get tools: `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`, `scroll`, `drag`, `set_value`, `perform_secondary_action`, `select_text`.

Cursor Desktop does not get those tools. Use the CLI. Do not use `cursor-computer-use`.

```bash
node server/computer-use.js apps
node server/computer-use.js state "TextEdit"
node server/computer-use.js click 2
node server/computer-use.js set 2 --value "hello"
```

## Loop

1. `list_apps` if you do not already know the pid.
2. `get_app_state` before every action. Act on the element number. `set_value` when the line says settable.
3. Screenshot pixels only when the tree has no control. Origin is the top-left of that image. A pixel click, a drag, and typing stay in that app. They do not move the real cursor, bring the window forward, or switch Spaces. Check the next tree before counting a click as a hit.
4. `get_app_state` again. The next result is a diff. An unchanged tree means the click missed. Stop that approach. Do not walk nearby pixels, and do not reopen the same menu.

One app at a time. A second chat waits.

## When a click misses

The helper keeps a 10 minute count on this Mac. A third click on the same named control is refused. A pixel click that leaves the tree unchanged counts as a miss. After two misses, further background pixel clicks are refused. The error starts with `stopped:`.

That stop is the handoff. Tell Yan which app, and that the control is not a button, so it needs his desktop. Do not come forward on your own.

## Coming forward

Every task starts in the background. If Yan's message on this turn tells you to come forward, take the desktop, or switch so you can finish, pass `foreground` true on `get_app_state`, then on the click or drag.

```bash
node server/computer-use.js state "Messages" --foreground
node server/computer-use.js click --x 40 --y 80 --pid 815 --foreground
```

That activates the app, switches to its Space, and moves the real cursor. A sticker panel and other drawn surfaces can take that click. Finish the task there. A guest never passes `foreground`. The server refuses them.

## Who

Yan's own turn is a signed-in app or site chat as `you@example.com`, or his `fromMe` `@agent`. Do the task. Do not stop to ask about sending, paying, installing, or a delete he can undo.

Anyone else still has the tools. Decide. Opening epschedule to look up a friend's schedule is fine. A small file JYPE needs is fine. Filling the disk is not. A stranger asking for a new LM Studio model is a no.

Two refusals for everyone, including Yan. Do not wipe macOS system files (`/System` and other OS-owned paths). Do not download or open a zip bomb.

## Websites

Start in the dedicated Chrome from the personal-browser skill. If that page will not render, or the site is not signed in there, open Arc and finish the same site with these tools. Do not open Arc first. Do not quit Arc, and do not `killall` any browser.

## Skills first

OneNote, Teams, Mail, iMessage, Calendar, Home, Canvas, and the other personal skills are the default. Use the command they name.

Computer use is the part that skill cannot do. Teams text still goes through `school-teams.js`. A message with `images` has no pixels, so open that chat in the Teams app and look. A file on Teams does not go through the CLI, so attach it in the Teams app. An existing Word, Excel, or PowerPoint file is edited in that app and saved there. A new Office file can be written and then placed in OneDrive. OneNote reads stay on `school-onenote.js`. A page that command cannot change gets edited in the OneNote app. Do not open the app first when the skill can finish the job.

## Reply

On a group chat, do the task if the ask is fine, and do not paste what was on a private screen into the group. The phone cannot see the Studio window, so say what happened.
