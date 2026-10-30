---
name: personal-mail
description: >-
  Search Yan's personal inbox in Mail.app on the Mac Studio (Exchange
  Outlook, Gmail, iCloud) and send from those accounts. Lists come from
  `node server/apple-mail.js since`. Use when Yan asks about personal email,
  inbox, or asks to send/reply/forward. School and EPS mail is the
  personal-school-mail skill, not this one. Yan only.
disable-model-invocation: true
---

# Personal mail (Mail.app) — Yan only

**Gate:** signed-in / default user is `you@example.com`. If the user is Alex, skip this whole skill.

Yan’s personal mail is already in **Mail.app** on the Mac Studio. Accounts: **Exchange** `you@example.com` (personal Outlook), **Google** `you@example.com`, **iCloud** `you@icloud.com`. New mail and any date-bounded inbox list come from Mail's local Envelope Index. No Gmail API, no IMAP login, no browser.

```bash
node server/apple-mail.js since --since 2026-10-22T09:30:08.350Z
node server/apple-mail.js since --since 2026-10-22T09:30:08.350Z --subject Robotaxi
node server/apple-mail.js since --since 2026-10-22T09:30:08.350Z --from tesla.com
```

JSON on stdout: `account`, `folder`, `received`, `from`, `subject`. Inbox and junk, all three accounts. Do not pass a date filter to AppleScript. `whose date received` on Exchange asks the server about a 6,443-message inbox and stalls. The overnight job has been killing that call and leaving `mailSince` on October 22. A subject search with no date is the same stall if you loop several needles. One message body is still AppleScript, and only after the index already found that subject.

College-admissions spam, routine sign-in alerts, Sign in with Google or Apple data-sharing notices, and verification codes (2FA, OTP, one-time passcodes) are filed by `server/apple-mail-file.js` (Jev only) into iCloud mailboxes **Colleges** and **Security**, then marked read. Inbox/junk from every Mail.app account. Do not rebuild that with Grok or Composer.

EPS / school mail lives in Microsoft 365 `owner@school.example`. Read that with `.cursor/skills/personal-school-mail/SKILL.md` (`node server/school-mail.js`). Do not hunt school notices in Mail.app. Do not add the school account here.

Use the `since` command above for a list. Do not iterate the inbox in AppleScript.

Read one body only after `since` already returned that subject:

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

Tesla Robotaxi and Uber Family receipts live on **Exchange**, not Gmail. Subjects: `Robotaxi Ride Receipt on <date>` (sender `tesla.com`), `Your … trip with Uber` (sender `uber.com`, often `[Family]`). Find them with `apple-mail.js since` and one `--subject` or `--from`. Do not add `date received` to an AppleScript `whose`. Extract pickup, dropoff, and times only. No fares. Full trip-matching steps: `.cursor/skills/location-enrichment/SKILL.md`.

## Send

If to, subject, and body are clear, send. If any of those is missing, ask. Unnamed send-to-a-person uses iMessage first, then Teams, then email (personal-agent skill). Reply `Sent to … (email)`.  Never from the location-history or daily-briefing jobs.

Alex calculus practice stays off his school inbox. Do not send the PDF, the key, a link, or any note about those tests to `friend@school.example`. iMessage carries that. His people card lists the school address first. Skip it for this.

End the email body with `Sent by Yan's Personal Agent` unless Yan says not to. Same parent-thread skip as iMessage. Never put that line in the Personal Agent app or website reply. iMessage and Teams use `// Sent by Yan's Personal Agent`.

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

**Never email Ms. Stearns** (`mstearns@school.example` or any other Stearns address) unless someone in JYPE explicitly says to send that email. Yan, 2026-09-28. Do not draft or queue one. If a Stearns draft is already sitting in Mail, delete it.

**Yan's parents.** Never email Rajasi Saha or Michael Levin because Example Neighbor or Example Friend asked. Yan, 2026-09-29, JYPE Teams. Only Yan's own explicit yes, before the send, counts. Do not draft or queue one. Alex is not in this ban.

## Attachments

Mail.app can attach files. School Outlook cannot, and Teams cannot. This is the path when Yan asked Teams or school mail to carry a PDF, photo, or other file.

Do not re-read a sent message through Mail's scripting interface to decide whether the attachments were wrong. That read can report duplicate names and drop files that the sent message actually has. If Yan says the original mail was fine, send nothing else. One send, then stop.

Use an absolute path. End the body with a blank line so the attachment has a paragraph to follow. One `make new attachment` per file, inside `content`. Then the same Drafts cleanup as a normal send. Reply `Sent to Name (email)`.

```bash
osascript <<'APPLESCRIPT'
set theFile to POSIX file "/abs/path/file.pdf"
tell application "Mail"
  set newMessage to make new outgoing message with properties {subject:"Subject here", content:"Body here" & return & return, visible:false}
  tell newMessage
    make new to recipient at end of to recipients with properties {address:"someone@example.com"}
    set sender to "you@example.com"
  end tell
  tell content of newMessage
    make new attachment with properties {file name:theFile} at after the last paragraph
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

## URLs in a message

`content` is plaintext. It keeps the words "Registration Link" and drops the href. When you need a Zoom / Meet / Teams / booking URL (calendar events, PathIvy webinars), read `source` of that message and parse `https://` links from the HTML. Quoted-printable mail splits URLs across lines (`href=3D"https://...` then `= ` continuation). Join those before you copy the URL onto a calendar event.
