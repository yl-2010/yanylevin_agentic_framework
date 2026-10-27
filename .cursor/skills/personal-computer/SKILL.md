---
name: personal-computer
description: >-
  Drive Mac apps with Cursor's built-in computer use. Websites still
  start in the dedicated Chrome. Use Arc only when that Chrome cannot
  render the page or is not signed in. Other skills come first. Computer
  use is for the part those skills cannot do.
disable-model-invocation: true
---

# Mac apps

Use Cursor's built-in computer use. `server/computer-use.js` is off. Do not run it.

If that work runs as its own step, the model is inherit. That is the same model as this turn, Grok or Composer, whichever this chat already has. Do not pick a different one.

Use the skill for that app first. Teams, iMessage, Mail, OneNote, Calendar, Home, Canvas, and the other personal skills already have a command. Computer use is for the part that command cannot do. A Teams file the CLI cannot attach, a Teams image with no pixels, an OneNote change the CLI cannot make, an existing Word, Excel, or PowerPoint file. Do the rest with the skill.

Stay on one app in the background. The real cursor stays where it is. Read the accessibility tree, then act on the element. Set the value when the line says settable. Use screenshot pixels when the tree has no control.

Take the whole display only when the user asked. That moves the real cursor. Release it when that part is done. Spotlight, Notification Center, and menu extras are not available.

## Who

Yan's own turn is a signed-in app or site chat as `you@example.com`, or his `fromMe` `@agent`. Do the task. Do not stop to ask about sending, paying, installing, or a delete he can undo.

Anyone else still has the tools. Decide. Opening epschedule to look up a friend's schedule is fine. A small file JYPE needs is fine. Filling the disk is not. A stranger asking for a new LM Studio model is a no.

Do not wipe macOS system files (`/System` and other OS-owned paths). Do not download or open a zip bomb.

## Websites

Start in the dedicated Chrome from the personal-browser skill. If that page will not render, or the site is not signed in there, open Arc and finish the same site with Cursor computer use. Do not open Arc first. Do not quit Arc, and do not `killall` any browser.

## Reply

On a group chat, do the task if the ask is fine, and do not paste what was on a private screen into the group. The phone cannot see the Studio window, so say what happened.
