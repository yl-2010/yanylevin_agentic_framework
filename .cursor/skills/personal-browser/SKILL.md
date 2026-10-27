---
name: personal-browser
description: >-
  Drive Google Chrome on the Mac Studio for login, JS pages, and clicking.
  Use only when curl, fetch, or web search cannot do the page. Yan and JYPE.
  Never for other guests. Never for static articles.
disable-model-invocation: true
---

# Chrome on the Studio

Playwright is the remote control. The browser is **Google Chrome.app**, dedicated
profile `~/.yanylevin/agent-browser/`. Not the school Outlook Chrome profile.
Not Yan's daily tabs. Chrome **quits when the turn ends**. Cookies stay
on disk so the next login can reuse them.

This Chrome is the default. If the page will not render, or the site is not
signed in here, switch to Arc with Cursor computer use. Arc is the browser Yan
actually uses, so the login is usually already there. Read
`.cursor/skills/personal-computer/SKILL.md`. That step uses this turn's model.
Do not run `server/computer-use.js`. Do not open Arc first. Do not
quit Arc.

**Who:** Yan, and anyone in JYPE, including JYPE `@agent`. Other guests: do not
use this. Express only attaches the tools for Yan/JYPE.

## When to skip (default)

If a static page, search snippet, or an existing CLI can answer, **do that**.
Do not open Chrome for:

- News / debate sources you can fetch or search
- Place hours on a normal hours page (chat-widgets still fetch the site first)
- Canvas, school Outlook, Teams, OneNote, Mail.app, Calendar, Home (those skills)
- four11 PDFs (no login)

Nightly jobs do not get these tools. Do not invent a Chrome pass for them.

## When to open it

Login walls, JS-only apps, clicking through a portal, a page curl returns empty,
or "go do this on the site." School family portal counts. Google Maps hours only
after the official site failed.

## How

Express / iOS / web / `@agent`: `browser_navigate`, `browser_snapshot`,
`browser_click`, `browser_fill`, `browser_type`, `browser_press`,
`browser_screenshot`, `browser_login`, `browser_close`. Snapshot, then act on
`[ref]` numbers. Do not guess pixels. After four failed clicks, stop.

Cursor Desktop: `cursor-ide-browser` is fine for public pages. For a logged-in
Chrome profile, use the `browser_*` tools in this chat (Express attaches them).
One-shot CLI (opens Chrome, prints a snapshot, quits Chrome):

```bash
node server/agent-browser.js goto "https://example.com"
```

Do not `killall Google Chrome`. That would hit a Chrome Yan opened himself.

iPhone cannot see the window. Summarize. Screenshot only if they need to see it.
Do not dump HTML into the bubble. Do not paste passwords.

## School family portal (JYPE allowed)

Sites that email a rotating password (EPS family portal / Genius-style parent
site). JYPE may log in. This is the **only** school-mail exception for JYPE.

1. Search school Outlook for the newest weekly password mail:
   `node server/school-mail.js search "family password"`
   (try `Genius`, `family portal`, or the portal name if that misses).
2. If nothing, Exchange in Mail.app for a parent forward. One needle, newest
   match. Do not dump the inbox. Do not read unrelated mail.
3. `browser_navigate` the portal, `browser_fill` the password, continue.
4. If 2FA needs a human, `browser_login` with that URL (headed Chrome on the
   Studio, up to 10 minutes). If nobody is at the Mac, say so.

Do not put the password in the chat bubble. "Signed in" is enough.

## Hard stops

JYPE (and any non-Yan caller): no Fidelity, brokerage, banks, PayPal/Venmo,
crypto, Apple ID, or password managers. The tools block those hosts.

Yan: those sites only if this turn named them. Do not wander there.

Do not buy, pay, submit, delete, or change a password unless this turn said to.
Do not use the school-mail Chrome profile. Do not attach Arc or the Default
Chrome user.
