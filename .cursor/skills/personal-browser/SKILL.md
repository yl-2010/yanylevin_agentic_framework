---
name: personal-browser
description: >-
  Drive a browser for login, JS pages, and clicking. Yan's default is Ardia,
  including a password Ardia already autofills or has saved. Other browsers
  only with a reason. JYPE stays on dedicated Chrome. Never for other guests.
  Never for static articles.
disable-model-invocation: true
---

# Browsers on the Studio

Static pages stay on curl, fetch, or search. This skill is for a login wall, a JS app, or a click-through.

## Default, Ardia (Yan only)

Yan's own turns start in Ardia. Read `~/.cursor/skills/ardia/SKILL.md` and drive it with `ardia browse`. His cookies and saved logins are in that browser.

Signing in is allowed when the task needs the site and Ardia already has the password. That means the page autofilled it, or `ardia browse auth list` has an entry for the site and `ardia browse auth login <name>` types it. Do not stop to ask. Do not read the password out of the field. Do not run `auth show`. Do not put the password in the chat. "Signed in" is enough.

The generic Ardia line that says leave passwords alone does not apply to this sign-in. Do not export the vault. Do not save a new password, and do not change one, unless this turn said to.

Do not buy, pay, or delete unless this turn said to. A login is not a payment.

JYPE and every other guest do not get Ardia. The saved passwords are Yan's.

If Ardia is closed, the error says what to ask. A missing Ardia is not a reason to type his password into a different browser.

## Other browsers, when there is a reason

Name the reason, then switch.

**Dedicated Chrome.** `node server/agent-browser.js`. Profile `~/.yanylevin/agent-browser/`. Cookies there persist. The window quits at the end of the turn. Use it for the school family portal, for a session that should stay out of Ardia, or when JYPE needs a browser. Not the school Outlook Chrome profile. Not Yan's daily Chrome. Do not `killall Google Chrome`.

Express / iOS / web / `@agent` Chrome tools are this profile: `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_screenshot`, `browser_login`, `browser_close`. On a Yan turn, prefer `ardia browse`. Snapshot, then act on `[ref]` numbers. Do not guess pixels. After four failed clicks, stop.

Cursor Desktop one-shot:

```bash
node server/agent-browser.js goto "https://example.com"
```

**Headless Chrome.** A screenshot of a local page. Profile `/tmp/yl-headless-chrome`. No clicks and no saved login. The command is in `.cursor/rules/ide-browser-hang.mdc`. Curl the URL first.

**Arc.** Cursor computer use, when Ardia and dedicated Chrome both cannot do the page and Arc is already signed in. Read `.cursor/skills/personal-computer/SKILL.md`. Do not open Arc first. Do not quit Arc. Do not run `server/computer-use.js`.

Do not call `cursor-ide-browser`. It hangs the turn.

## Who

Ardia is Yan only. Dedicated Chrome is Yan, and anyone in JYPE, including JYPE `@agent`. Other guests do not get a browser. Express only attaches the Chrome tools for Yan and JYPE.

## When to skip

If a static page, search snippet, or an existing CLI can answer, do that. Do not open a browser for:

- News / debate sources you can fetch or search
- Place hours on a normal hours page (chat-widgets still fetch the site first)
- Canvas, school Outlook, Teams, OneNote, Mail.app, Calendar, Home (those skills)
- four11 PDFs (no login)

Nightly jobs do not get these tools. Do not invent a browser pass for them.

## When to open it

Login walls, JS-only apps, clicking through a portal, a page curl returns empty, or "go do this on the site." School family portal counts. Google Maps hours only after the official site failed.

iPhone cannot see the window. Summarize. Screenshot only if they need to see it. Do not dump HTML into the bubble. Do not paste passwords.

## School family portal (JYPE allowed)

Sites that email a rotating password (EPS family portal / Genius-style parent site). JYPE may log in on dedicated Chrome. This is the only school-mail exception for JYPE. Yan uses Ardia first if that login is already saved there. Otherwise same steps, on dedicated Chrome.

1. Search school Outlook for the newest weekly password mail: `node server/school-mail.js search "family password"` (try `Genius`, `family portal`, or the portal name if that misses).
2. If nothing, Exchange in Mail.app for a parent forward. One needle, newest match. Do not dump the inbox. Do not read unrelated mail.
3. Open the portal and fill the password.
4. If 2FA needs a human, `browser_login` with that URL (headed Chrome on the Studio, up to 10 minutes). If nobody is at the Mac, say so.

Do not put the password in the chat bubble. "Signed in" is enough.

## Hard stops

JYPE, and any non-Yan caller: no Ardia. No Fidelity, brokerage, banks, PayPal/Venmo, crypto, Apple ID, or password managers. The Chrome tools block those hosts.

Yan: a saved or autofilled Ardia password is enough to sign in, including those sites, when the task needs the site. Do not open one just to look around.

Do not buy, pay, or delete unless this turn said to. Do not change a password unless this turn said to. Do not use the school-mail Chrome profile. Do not attach the Default Chrome user.
