---
name: personal-onenote
description: >-
  Read Yan's EPS Microsoft 365 OneNote / Class Notebooks
  (owner@school.example) via node server/school-onenote.js. Use when Yan
  asks for something in OneNote, or when another job already names a
  specific notebook or page. Yan only. Never a default nightly source.
  
disable-model-invocation: true
---

# School OneNote, Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is
Alex, skip this whole skill.

Account: `owner@school.example`. Same Chrome login as school Outlook
(`~/.yanylevin/school-mail/chrome-profile`). No Azure app. No API key.

## When to use

Open OneNote only when this turn already needs it:

- Yan asked to get / find / read something from OneNote or a Class Notebook
- A todo, Canvas item, mail, or nightly action names a specific notebook,
  section, or page you must read to finish that job

Do **not** list notebooks "just in case." Do **not** dump page bodies into
the brain. Do **not** run a history fill. There is no `school-onenote-fill`.
Nightly triage, synthesis, and fact-check do not scan OneNote unless a claim
they are already handling is specifically about a page.

You only see what Yan can open as a student: Content Library, his private
section, Collaboration Space. Leave other students' private sections alone.

## Commands

From the repo root:

```bash
node server/school-onenote.js status
node server/school-onenote.js notebooks
node server/school-onenote.js sections --notebook "Spanish 4"
node server/school-onenote.js pages --notebook "Spanish 4" --section "Tri 1"
node server/school-onenote.js page "<id>"
node server/school-onenote.js search "colonial map"
```

Output is JSON. Use `id` from pages/search when reading a body. Summarize.
Do not print tokens. Do not dump huge HTML (`page` already returns text;
`--html` only if you must see markup).

If `signedIn` is false or the payload says `not signed in`, run login on the
Mac Studio. Chrome opens **Graph Explorer**, not Outlook. The script clicks
`owner@school.example` on the Microsoft account picker, then Run query.
Do not tell Yan to click Sign in. Stay at the computer only if 2FA appears.

```bash
node server/school-onenote.js login
```

Cookies live in `~/.yanylevin/school-mail/`. The OneNote Graph token lives in
`~/.yanylevin/school-onenote/session.json` (not in git). Never copy those
folders into the repo.

## Search

Prefer `search` or a named `--notebook` over listing everything. Class
Notebooks often nest sections under `_Content Library`, `_Collaboration Space`,
and Yan's name. `sections` flattens those groups.

This is not school OneDrive. Grade-folder Word/PPT files stay on the
education-dashboard OneDrive path.
