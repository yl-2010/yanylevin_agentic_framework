---
name: personal-contacts
description: >-
  Search (and rarely create) Yan's Apple Contacts on the Mac Studio via
  AddressBook sqlite. Use to look up emails and phones before Mail or
  iMessage. Yan only — never for Alex. Never open Contacts.app.
disable-model-invocation: true
---

# Contacts — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

Read-only dumps from `~/Library/Application Support/AddressBook` (sqlite). **Never** `tell application "Contacts"` / `osascript` for lookup. That launches Contacts.app and leaves it in the Dock.

Cursor agent shells usually cannot open the AddressBook DBs (TCC). The Express LaunchAgent (`node`, Full Disk Access) can. Prefer the local Unix socket (not on the public API):

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/contacts/search?q=Rajasi"
curl -sS --unix-socket /tmp/personal-agent-local.sock "http://localhost/contacts/list"
```

CLI from Terminal.app or the LaunchAgent (often fails inside Cursor):

```bash
node server/contacts-read.js search "Rajasi"
node server/contacts-read.js list
```

Keep everyday lookups as `search` (name, email, or phone). Do not dump `/contacts/list` into a chat turn. The full dump is for people-brain compile only.

Needs **Full Disk Access** for `node` (same grant as Messages). Do not copy AddressBook files into this repo.

## Write

Create or update a card **only when Yan asks**. Writes still need Contacts.app; quit it afterward if it was not already running, so it does not stay in the Dock. Never `activate`.

```bash
osascript <<'APPLESCRIPT'
set wasRunning to false
tell application "System Events"
  if exists process "Contacts" then set wasRunning to true
end tell
tell application "Contacts"
  set p to make new person with properties {first name:"Ada", last name:"Lovelace"}
  make new email at end of emails of p with properties {label:"home", value:"ada@example.com"}
  save
  set personName to name of p
end tell
if wasRunning is false then tell application "Contacts" to quit
return personName
APPLESCRIPT
```

Use search (sqlite) before Mail send or iMessage search when Yan names a person without an address.
