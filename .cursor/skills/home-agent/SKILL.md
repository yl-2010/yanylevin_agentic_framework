---
name: home-agent
description: >-
  Hourly home check. Turns off lights in Yan's Bedroom and Yan's Office
  when he is clearly away, then Composer 2.5 decides whether to start
  Vacuum Yan, or a school-day family zone after a 15-minute warning.
  Yan only.
disable-model-invocation: true
---

# Home agent

Yan only (`you@example.com`). Local Cursor agent on the Mac Studio. Never a cloud agent. Model is Composer 2.5 with Fast off.

The hourly script in `server/home-agent.js` does the cheap checks, including the lights, and picks at most one vacuum zone. This skill is the decision after those checks pass. Do not start the Roomba from a chat turn. When Yan says run the home agent, check the vacuum, or turn off my room lights if I'm away, run:

```bash
node --env-file=server/.env server/home-agent.js --force
```

`--force` skips the phone-pin gate and an open `nextCheckAt`. It still lets this decision stand. It does not force the scene on, and it does not force lights off. It does not skip one scene a day, an open family warning, a denial already sent today, the school-session window on the family zones, or family sleep hours.

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
2. `sunny`, scene `Roomba Sunny Boy Landing Laundry Room`. Only after Yan is not due, his last start is under 72 hours, and that start was not today. Sunny is due at 7 days. School has to be in session now and still in session 15 minutes from now. This pass sends a warning. It does not start the Roomba.
3. `master`, scene `Roomba Master Rooms`. Only after Yan's last start is under 72 hours and not today, and Sunny's last start is under 7 days and not today. Master is due at 7 days. Same school window. Same warning, no start on this pass.

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

The phone pin in the prompt is last-known GPS. A stale home pin means he is still home. Missing GPS is not a reason to vacuum. The script already stopped those cases unless this run was `--force`.

Parents live in the Kirkland house. Yan being out does not mean the house is empty.

## Family sleep

No scene can run while the family is asleep. That includes `Vacuum Yan`. Sleep is 9:00 PM through 7:00 AM Pacific. 7:00 AM is awake.

The Roomba also needs two hours clear of that window, so the run is finished before anyone is in bed. The script will not start a scene from 7:00 PM to 7:00 AM. A family warning needs the start 15 minutes later to still have those two hours, so Sunny and master are not warned from 6:45 PM on.

`--force` does not override this. `trigger`, `record-warn`, and `record-start` refuse during the window. The confirm pass does not start the Roomba and does not text if the window has arrived. It drops the pending warning instead.

## Start only if both are true

For `yan`, both of these:

- He is unlikely to be home within 2 hours. Use the calendar, the school day, life-state, and the usual leave and return pattern. The run should be finished before he walks in. Two hours is that buffer.
- The house will not be asleep during those 2 hours. The script already blocked 9:00 PM to 7:00 AM. Still say no if people will be in bed earlier than that. A long absence does not override that.

For `sunny` and `master`, the same two rules, applied to the people who use that part of the house, not only to Yan. The script already checked that school is in session across the 15-minute warning. If those two rules fail, record a skip and do not text.

## If yes, Yan

```bash
node server/home-agent.js trigger --zone yan --reason "<one line>"
```

That triggers `Vacuum Yan` and records the start. Never trigger `Vacuum Yan's Rooms`.

HomeClaw often lists `action_count` 0 for this scene. The Roomba still starts. Record the start unless the trigger command itself fails.

If HomeClaw is down or the trigger fails, do not record a start. Say what failed.

## If yes, Sunny or master

Do not trigger yet. Send one iMessage to the existing group `Levin-Saha Family` through the local socket. The server appends `// Sent by Yan's Personal Agent`. Do not write that line yourself.

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

That blocks the rest of today.

If the thread cannot be read, do not start and do not send. Clear the warning, then record a skip.

```bash
node server/home-agent.js clear-pending
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

## If no

```bash
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

`next-check` is when it is worth asking again. Next morning, the next time school is in session, or just after the calendar block that would put someone home. The hourly script still runs, and it will not spend another Composer call until then.

Do not git commit. Do not edit any other file.
