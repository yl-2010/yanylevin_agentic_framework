---
name: personal-mail
description: >-
  Search Yan's personal inbox in Mail.app on the Mac Studio via osascript
  (Exchange Outlook, Gmail, iCloud) and send from those accounts. Use when
  Yan asks about personal email, inbox, or asks to send/reply/forward. School
  and EPS mail is the personal-school-mail skill, not this one. Yan only.
disable-model-invocation: true
---

# Personal mail (Mail.app) — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

Yan’s personal mail is already in **Mail.app** on the Mac Studio. Accounts: **Exchange** `you@example.com` (personal Outlook), **Google** `you@example.com`, **iCloud** `you@icloud.com`. Read it with `osascript` talking to Mail. No Gmail API, no IMAP login, no browser.

EPS / school mail lives in Microsoft 365 `owner@school.example`. Read that with `.cursor/skills/personal-school-mail/SKILL.md` (`node server/school-mail.js`). Do not hunt school notices in Mail.app. Do not add the school account here.

Use `whose` filters. Do **not** iterate every inbox message (slow, burns tokens). Start with Exchange inbox; scanning every mailbox is a last resort.

Search subjects on the Exchange (Outlook) inbox (swap the string):

```bash
osascript <<'APPLESCRIPT'
tell application "Mail"
  set output to ""
  set inboxBox to mailbox "Inbox" of account "Exchange"
  repeat with m in (messages of inboxBox whose subject contains "Robotaxi")
    set output to output & (subject of m) & " | " & (sender of m) & " | " & (date received of m as string) & linefeed
  end repeat
  return output
end tell
APPLESCRIPT
```

Read one matching body:

```bash
osascript <<'APPLESCRIPT'
tell application "Mail"
  set inboxBox to mailbox "Inbox" of account "Exchange"
  set theMsg to first message of inboxBox whose subject contains "Robotaxi Ride Receipt"
  return content of theMsg
end tell
APPLESCRIPT
```

Inbox mailbox names are not the same across accounts. Exchange is `"Inbox"`. Google and iCloud are `"INBOX"` (all caps). `mailbox "Inbox" of account "Google"` and `mailbox "Inbox" of account "iCloud"` both fail (Mail.app: mailbox not found). Do not loop mailboxes to find them.

```applescript
mailbox "Inbox" of account "Exchange"
mailbox "INBOX" of account "Google"
mailbox "INBOX" of account "iCloud"
```

Prefer Exchange first; then Google; then iCloud. iCloud `you@icloud.com` is mostly newsletters, Apple Store, Strava. Tesla/Uber receipts are on Exchange. School mail is not.

## Ride receipts (location enrichment)

Tesla Robotaxi and Uber Family receipts live on **Exchange**, not Gmail. Subjects: `Robotaxi Ride Receipt on <date>` (sender `tesla.com`), `Your … trip with Uber` (sender `uber.com`, often `[Family]`). Use a date cutoff (`date received > (current date) - (14 * days)`) and **one needle per script**. Do not nest many subject loops; Exchange hangs. Extract pickup, dropoff, and times only. No fares. Full trip-matching steps: `.cursor/skills/location-enrichment/SKILL.md`.

## Send

If to, subject, and body are clear, send. If any of those is missing, ask. Reply `Sent to …`.  Never from the location-history or daily-briefing jobs.

Default From when Yan does not specify a sending address: Exchange `you@example.com`. Use Google `you@example.com` or iCloud `you@icloud.com` only if he names that account.

When mailing a named person, use the address on their people card (or Contacts). Do not keep a second address table here.

Keep the compose window hidden (`visible:false`) so Mail does not flash on the Studio. After `send`, Exchange still leaves a Drafts copy of that hidden message. Always delete the leftover Drafts message with the same subject and to-address (Google/iCloud Drafts if that was the From account). Do not skip the delete.

```bash
osascript <<'APPLESCRIPT'
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"Subject here", content:"Body here" & return, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"someone@example.com"}
    set sender to "you@example.com"
  end tell
  send newMessage
end tell
delay 2
tell application "Mail"
  set draftBox to mailbox "Drafts" of account "Exchange"
  set leftoverIds to {}
  repeat with m in messages of draftBox
    if (subject of m) is "Subject here" then
      set hit to false
      try
        repeat with r in to recipients of m
          if (address of r) is "someone@example.com" then set hit to true
        end repeat
      end try
      if hit then set end of leftoverIds to id of m
    end if
  end repeat
  repeat with mid in leftoverIds
    try
      delete (first message of draftBox whose id is mid)
    end try
  end repeat
end tell
APPLESCRIPT
```

Look up an address in Contacts (`.cursor/skills/personal-contacts/SKILL.md`) when Yan names a person without an email. Do not add the school Microsoft 365 account to Mail.app.
