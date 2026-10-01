---
name: home-agent
description: >-
  Hourly home check. Turns off lights in Yan's Bedroom and Yan's Office
  when he is clearly away. Composer 2.5 decides Vacuum Yan. On a school
  day, while the house is awake, the script warns the family before
  Sunny or the master rooms, then Composer reads the replies. Someone
  being home is not a skip. A veto blocks the rest of the day. Every
  hour decides again. Yan only.
disable-model-invocation: true
---

# Home agent

Yan only (`you@example.com`). Local Cursor agent on the Mac Studio. Never a cloud agent. Model is Composer 2.5 with Fast off.

The hourly script in `server/home-agent.js` does the cheap checks, including the lights, and picks at most one vacuum zone. Yan's scene is a Composer decision after those checks. Sunny and the master rooms are not. When that zone is due, school is in session, and the house is awake, the script sends the family warning itself. Composer only comes back 15 minutes later to read the thread. Do not start the Roomba from a chat turn. When Yan says run the home agent, check the vacuum, or turn off my room lights if I'm away, run:

```bash
node --env-file=server/.env server/home-agent.js --force
```

`--force` skips the phone-pin gate. It still lets this decision stand. It does not force the scene on, and it does not force lights off. It does not skip one scene a day, an open family warning, a denial already sent today, the school-session window on the family zones, or family sleep hours.

An earlier hour's `nextCheckAt` does not pause this one. Every hour looks again. A skip is a note. A denial is the thing that blocks the rest of the day.

## Lights

Every hourly run checks lights before the vacuum gates. The script does this itself. Do not turn lights, switches, or outlets on or off from this decision.

Only two rooms: Yan's Bedroom and Yan's Office. Bathroom and closet lights live in the bedroom room in Home, so they are included. The rest of the house stays as it is. Guest bedroom, master, Sunny's room, kitchen, living room, outside.

Not lights, even in those two rooms: Bedroom Boolean, Bathroom Boolean, Office Boolean, Leaving Bath Bool, Bathroom Fan, Office TV, Desk Port.

Turn them off only when the phone pin is clearly outside the house. The accuracy circle has to sit fully outside the home radius, and the pin needs a real accuracy. A missing pin, a pin at the house, or a pin whose accuracy reaches the house means he is home.

A quiet pin is also home. The floor is 20 minutes. Farther away, the script allows the pin to be older only for as long as a fast drive (about 90 km/h) would need to reach the house. Older than that, he may have come back without a new dot. Leave the lights.

A life-state sample from the last 30 minutes with place `kirkland-home` also means he is home, even if the phone dot says otherwise.

Receipts go in `education/you@example.com/home/lights.json`. Names and rooms only.

## Zones

The script names the one zone for this pass. Do not pick a different one.

1. `yan`, scene `Vacuum Yan`. Due when the last start is missing or at least 72 hours old. No family text. Trigger it on this pass when the yes rules below hold.
2. `sunny`, scene `Roomba Sunny Boy Landing Laundry Room`. Only after Yan is not due, his last start is under 72 hours, and that start was not today. Sunny is due at 7 days. School has to be in session now and still in session 15 minutes from now. The script sends the warning. It does not start the Roomba, and it does not ask a model whether anyone is home.
3. `master`, scene `Roomba Master Rooms`. Only after Yan's last start is under 72 hours and not today, and Sunny's last start is under 7 days and not today. Master is due at 7 days. Same school window. Same script warning, no start on this pass.

At exactly 72 hours Yan is due again, so Sunny is not offered. At exactly 7 days Sunny is due again, so master is not offered.

One scene per Pacific day. A start today blocks the rest. An open warning, or a denial already recorded today, also blocks the rest of the day.

School in session means a school day on `education/you@example.com/schedule.json` and the Pacific clock is inside the bells, from the first bell through the last. The last bell minute is already out. A warning only goes out when the start 15 minutes later is still inside that window.

Never trigger `Vacuum Yan's Rooms`.

## Vacuum state

`education/you@example.com/home/vacuum.json`

`zones.yan.lastStartedAt`, `zones.sunny.lastStartedAt`, and `zones.master.lastStartedAt` are the per-zone starts. A file that only has a top-level `lastStartedAt` for `Vacuum Yan` is Yan's clock. The top-level `lastStartedAt` after a new start is whichever zone just ran.

A skip writes `lastSkippedAt`, `skipReason`, and `nextCheckAt`. It must leave every zone's `lastStartedAt` alone. Use the record commands. Do not hand-edit the JSON.

`pending` is the family warning waiting on the 15-minute confirm. `blockedDate` is the Pacific day a denial already used up.

## Before you decide

Read the vacuum file. Then:

- Apple Calendar for the next several hours: `node server/calendar-cli.js events --from <now ISO> --to <now plus 6 hours ISO>`
- Life state: `node server/life-state.js now` and `node server/life-state.js recent 6`
- On a school day, today's classes in `education/you@example.com/schedule.json`

The phone pin gates `Vacuum Yan` only. A pin at the house, a missing pin, or a pin that is not clearly away means his rooms wait. It does not block Sunny or the master rooms. Those get the warning either way.

Parents live in the Kirkland house. Them being home, or Adi being home, does not block Sunny or the master rooms. The warning is how they stop it. Sleep is the block, because a text they do not see is not a warning. On a weekday school day, inside the bells, they are awake even if they are in the house.

Yan's scene has no warning. It still needs him unlikely to walk into his rooms within 2 hours.

## Family sleep

No scene can run while the family is asleep. That includes `Vacuum Yan`. Sleep is 9:00 PM through 7:00 AM Pacific. 7:00 AM is awake.

The Roomba also needs two hours clear of that window, so the run is finished before anyone is in bed. The script will not start a scene from 7:00 PM to 7:00 AM. A family warning needs the start 15 minutes later to still have those two hours, so Sunny and master are not warned from 6:45 PM on.

`--force` does not override this. `trigger`, `record-warn`, and `record-start` refuse during the window. The confirm pass does not start the Roomba and does not text if the window has arrived. It drops the pending warning instead.

## Start only if both are true

For `yan`, both of these:

- He is unlikely to be home within 2 hours. Use the calendar, the school day, life-state, and the usual leave and return pattern. The run should be finished before he walks in. Two hours is that buffer.
- The house will not be asleep during those 2 hours. The script already blocked 9:00 PM to 7:00 AM. Still say no if people will be in bed earlier than that. A long absence does not override that.

For `sunny` and `master`, do not apply those rules to whoever uses that part of the house. The script already checked school and sleep, and it sends the warning itself. Someone being home is not a no. Do not record a skip because Michael, Rajasi, or Adi might be in the house.

## If yes, Yan

```bash
node server/home-agent.js trigger --zone yan --reason "<one line>"
```

That triggers `Vacuum Yan` and records the start. Never trigger `Vacuum Yan's Rooms`.

HomeClaw often lists `action_count` 0 for this scene. The Roomba still starts. Record the start unless the trigger command itself fails.

If HomeClaw is down or the trigger fails, do not record a start. Say what failed.

## If yes, Sunny or master

The hourly script already sends this text and records the warning. Do not send a second one from a chat turn. If a run does ask you to send it, send it. Do not skip because someone is home.

Send one iMessage to the existing group `Levin-Saha Family` through the local socket. The server appends `// Sent by Yan's Personal Agent`. Do not write that line yourself.

Say which part of the house, and that they have 15 minutes to stop it. Sunny's area is Sunny's room, the landing, and the laundry room. Master's area is the master rooms.

```text
The Roomba starts in 15 minutes in Sunny's room, the landing, and the laundry room. Reply no if it should wait.
```

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock \
  -H "Content-Type: application/json" \
  -d "{\"to\":\"Levin-Saha Family\",\"text\":\"The Roomba starts in 15 minutes in Sunny's room, the landing, and the laundry room. Reply no if it should wait.\"}" \
  http://localhost/imessage/send
```

Then:

```bash
node server/home-agent.js record-warn --zone sunny --reason "<one line>"
```

Use `--zone master` for the master rooms. If the send fails, do not record the warning.

## Confirm pass

Fifteen minutes later the script runs this skill again. `pending.warnedAt` is the warning. Read the group since then:

```bash
curl -sS --unix-socket /tmp/personal-agent-local.sock \
  "http://localhost/imessage/thread?person=Levin-Saha%20Family&limit=40"
```

Ignore the warning itself. Silence is a yes. Unrelated chatter is not a rejection. A no, or any other clear rejection, from Rajasi, Michael, Adi, or Yan means do not start. An unclear objection also means do not start.

If nobody rejected:

```bash
node server/home-agent.js trigger --zone sunny --reason "<one line>"
```

That starts the pending scene and records it. Send no iMessage. `action_count` 0 is normal. If the trigger fails, do not record a start.

If someone rejected, or the objection is unclear, send one short ack on the same socket, still without typing the footer.

```text
Holding off. The Roomba is not starting.
```

Then:

```bash
node server/home-agent.js record-deny --reason "<one line>" --next-check <ISO time>
```

That blocks every vacuum zone for the rest of today. A later hour does not get another scene. Sleep and an open warning also block. A plain skip does not.

If the thread cannot be read, do not start and do not send. Clear the warning, then record a skip.

```bash
node server/home-agent.js clear-pending
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

## If no

```bash
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

`next-check` is a note. It does not delay the next hour. The hourly script decides again on the hour, including when the last model said to wait until 10:30 or 3:00. Do not use a skip to hold the Roomba for the rest of the morning. A veto is `record-deny`, and that one does hold the rest of the day.

Do not git commit. Do not edit any other file.
