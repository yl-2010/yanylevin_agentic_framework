---
name: personal-school-mail
description: >-
  Read Yan's EPS Microsoft 365 Outlook (owner@school.example) on the Mac
  Studio via node server/school-mail.js. Use when Yan asks about school email,
  teacher mail, EPS Outlook, orientations, or other school notices.
  Yan only. 
disable-model-invocation: true
---

# School Outlook — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is
Alex, skip this whole skill.

Account: `owner@school.example`. This is browser Microsoft 365, not
Mail.app. Do not add it to Mail.app. Personal Exchange / Gmail / iCloud stay
on `.cursor/skills/personal-mail/SKILL.md`.

## Commands

From the repo root:

```bash
node server/school-mail.js status
node server/school-mail.js inbox --limit 15
node server/school-mail.js search "Kirsten"
node server/school-mail.js read "<id>"
```

Output is JSON. Use `id` from inbox/search when reading a body. Do not print
tokens. Summarize. Do not dump huge HTML.

If `signedIn` is false or the payload says `not signed in`, Yan has to finish
login on the Mac Studio (visible Chrome, including 2FA):

```bash
node server/school-mail.js login
```

Cookies live in `~/.yanylevin/school-mail/` (not in git). Never copy that
folder into the repo.

## Search

Prefer `search` with a name or subject needle over paging the whole inbox.
Do not fall back to Mail.app or Rajasi forwards for school mail.

## History fill

Do not run the two-year Composer fill unless Yan asks. That job is
`node --env-file=server/.env server/school-mail-fill.js` and
`.cursor/skills/brain-school-mail/SKILL.md`.
