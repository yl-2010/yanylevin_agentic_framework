---
name: grade-watch
description: >-
  Watch one Canvas assignment until a grade is posted, then send the iMessage
  and Teams texts written when the watch was created. Use when Yan or Alex
  asks to be told the moment a specific assignment is graded.
---

# Grade watch

A grade watch polls one Canvas assignment. The texts are chosen in the turn that creates the watch. When Canvas shows a posted grade, those texts go out. No model runs at send time.

Nothing is watched unless Yan or Alex asks for that assignment.

## Who can start one

Only Yan and Alex. A normal chat, Cursor Desktop, and `@agent` or `@agentg` on iMessage or Teams all count.

Look at who actually spoke. A guest `@agent` turn still runs as Yan's session, so the signed-in email is not the check. The bubble starts with `From Name on iMessage` or `From Name on Teams`, and Live context names the caller. If that person is not Yan or Alex, say no and do not call the tool. Example Friend, Example Neighbor, and anyone else are a no.

The same rule covers cancel.

## What to do

Call `start_grade_watch` in this turn. Write the messages in that call. Leave `schedule_future_agent` for reminders and later sends.

Pass the assignment as a name, a Canvas URL, or a numeric id. Pass `course` when the name could match more than one class. Do not open Yan's Canvas snapshot to find the id. The tool resolves it, and it only accepts a course Yan is taking.

Each message needs `channel` (`imessage` or `teams`) and `text`. iMessage uses `to` (a name, phone, email, or chat). Teams uses `chat` (a name or id). Any chat on either app is allowed.

The usual ask is a text to Yan on iMessage and a message to Alex on Teams. Do not put a score in a chat Example Friend, Example Neighbor, or the JYPE group can see, unless Yan explicitly names that chat. Alex cannot override that.

These tokens are filled in when the grade posts. A text with none of them goes out word for word. Put `{grade}` in the sentence when they want the number.

- `{score}` and `{points}`
- `{percent}`
- `{grade}` the same label as the home page, such as `8/10`, `92%`, or `exc`
- `{assignment}` and `{course}`

Do not write the `// Sent by Yan's Personal Agent` footer. The send adds it.

If the tool returns `matches`, ask which assignment. If it returns `existing`, that watch is already running. If `alreadySent` is true, it already went out. If `sent` is true, the grade was already posted and the texts went out in this turn. If `watching` is true, say you are watching that assignment.

Cancel with `cancel_grade_watch` and the id, or the assignment name. A sent watch stays sent.

On Cursor Desktop there is no tool. From the repo root:

```bash
node server/grade-watch.js start --assignment "Quiz 3" --course "advanced calculus" --messages '[{"channel":"imessage","to":"Yan Levin","text":"Quiz 3 is graded: {grade}"},{"channel":"teams","chat":"Alex Rivera","text":"Quiz 3 posted. {grade}"}]'
node server/grade-watch.js list
node server/grade-watch.js cancel --id <id>
```

The poller checks that one submission and sends as soon as Canvas shows a score, a grade string, or excused. A graded row with an empty score stays quiet.
