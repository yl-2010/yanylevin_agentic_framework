---
name: passwords
description: >-
  Yan's local password vault on this Mac. List accounts, log a reason, and
  fill a login in Ardia or Chrome. Never print a password or send one.
disable-model-invocation: true
---

# Passwords

A password from this vault is for typing into a login form on this Mac. That is the only use.

Never put a password, the Mac login password, or a one-time code in the reply, in `send_chat_message`, or in Teams, iMessage, email, WhatsApp, or any other outgoing message. Do not ask Yan before using a password. Do not read a secret with `cat`, `security`, or by printing it. There is no command that prints a site password.

This is Yan only. Alex, JYPE guests, and anyone else do not get this vault.

## Pick, then fill

List first. The list is the site name, URL, username, and id. It has no secrets.

```bash
node server/passwords.js list
node server/passwords.js list --query github
```

Choose the one id that matches the site and the username. If two rows match, pick the id. Do not guess.

The reason is one sentence about why this login is happening. It goes on the same command that fills the field. An empty reason does nothing and does not unlock the password.

Each fill, one-time code, and Mac dialog unlock shows up on the dashboard Actions row. The card says Personal agent unless you pass `--via` with another agent id, such as `--via nightly-actions`.

Ardia, on a Yan turn. The ref is the snapshot ref, such as `e11`.

```bash
node server/passwords.js fill --id ID --reason "Sign in to GitHub to read the repo" --browser ardia --ref e11
```

Dedicated Chrome, when the browser skill says to use it. The ref is the snapshot number.

```bash
node server/passwords.js fill --id ID --reason "Sign in to the family portal" --browser chrome --ref 4
```

Stdout is `filled`. If that fails, say the login failed. Do not retry by finding a way to print the password.

The reply can name the site and the username. Signed in to GitHub as yan is enough.

## One-time codes

A code that was in the export:

```bash
node server/passwords.js otp --id ID --reason "GitHub 2FA" --browser ardia --ref e12
```

Without a ref, stdout is the current 6-digit code so you can type it into the form. Do not send that code anywhere.

A code that arrives in Mail.app or iMessage uses those skills. Read the newest code and type it into the form. Do not forward it.

The Passwords app, when the code is not in the export and not in mail or messages. Bring the Passwords app or the macOS password dialog to the front, then:

```bash
node server/passwords.js unlock-dialog --reason "Read the GitHub code in Passwords"
```

That types the Mac login password. It refuses if another app is in front. Do not run it against a browser.

## Imports

A new Apple Passwords CSV goes in `~/.yanylevin/passwords/inbox/`. Then:

```bash
node server/passwords.js import ~/.yanylevin/passwords/inbox/Passwords.csv
```

The command prints counts and deletes the file. A later export adds new rows and updates changed ones. Rows missing from the new file stay. Do not commit the CSV. Do not put it in OneDrive or the repo. Do not read the file into the chat.

`set-mac` stores a new Mac login password from stdin. Do not pass it as an argument. Do not repeat it.
