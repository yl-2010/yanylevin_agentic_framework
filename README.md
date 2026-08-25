# yanylevin_agentic_framework

Single-operator personal agent that runs on your Mac.

Yan Levin in this repo is a **placeholder** for the person who built the reference implementation. Live site: [yanylevin.com](https://yanylevin.com). Fork it, set `OWNER_EMAIL`, and put your own facts in `education/you@example.com/` (rename the folder to match your email).

## What you get

- Express API on `:3004` (Cursor SDK Personal Agent + optional local gpt-oss visitor chatbot)
- `/education`, `/fitness`, `/dashboard` static UIs
- File-tree brain (`education/<email>/brain/`) plus nightly jobs
- Optional Apple Mail, Messages, Calendar, Contacts, Screen Time, Health, location
- Optional Canvas LMS sync
- iOS SwiftUI app as a reference (rename before you sign it)

Mac-first. Messages, Mail, and TCC do not pretend to be Linux-portable.

## First run

1. Copy `server/.env.example` to `server/.env`.
2. Set `OWNER_EMAIL` (and optional `OWNER_EMAIL_ALIASES`).
3. Rename `education/you@example.com` and `fitness/you@example.com` to those addresses if they differ.
4. Set `CURSOR_API_KEY`. Optional: `AUTH_SECRET`, Google OAuth client, LM Studio on `127.0.0.1:1234`.
5. `npm install --prefix server` then `npm run server` from the repo root.
6. Preview the site with `python3 -m http.server 8080`.

Google OAuth is optional on localhost. The allowlist is one email.

## iOS

The Xcode target is still named YanLevin. That is the reference app. Change the bundle ID (`com.example.personalagent`), App Group, URL scheme, team (`YOUR_TEAM_ID` in `project.yml`), and display name before signing. See `docs/IOS_APP.md`.

## Layout

```
Browser
├─ static site (Vercel or local)
└─ api.example.com → Cloudflare Tunnel (optional)
     └─ http://127.0.0.1:3004 → Express
          ├─ Cursor SDK (signed-in operator)
          └─ LM Studio localhost only (visitor chat; never tunnel :1234)
```

## License

MIT
