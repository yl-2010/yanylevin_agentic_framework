---
name: home-agent
description: >-
  Hourly home check. Turns off lights in Yan's Bedroom and Yan's Office
  when he is clearly away, then Composer 2.5 decides whether to start
  the Vacuum Yan scene. Yan only.
disable-model-invocation: true
---

# Home agent

Yan only (`you@example.com`). Local Cursor agent on the Mac Studio. Never a cloud agent. Model is Composer 2.5 with Fast off.

The hourly script in `server/home-agent.js` does the cheap checks, including the lights. This skill is the vacuum decision after those checks pass. Do not start the Roomba from a chat turn. When Yan says run the home agent, check the vacuum, or turn off my room lights if I'm away, run:

```bash
node --env-file=server/.env server/home-agent.js --force
```

`--force` skips the vacuum gates and still lets this decision stand. It does not force the scene on, and it does not force lights off.

## Lights

Every hourly run checks lights before the vacuum gates. The script does this itself. Do not turn lights, switches, or outlets on or off from this decision.

Only two rooms: Yan's Bedroom and Yan's Office. Bathroom and closet lights live in the bedroom room in Home, so they are included. The rest of the house stays as it is. Guest bedroom, master, Sunny's room, kitchen, living room, outside.

Not lights, even in those two rooms: Bedroom Boolean, Bathroom Boolean, Office Boolean, Leaving Bath Bool, Bathroom Fan, Office TV, Desk Port.

Turn them off only when the phone pin is clearly outside the house. The accuracy circle has to sit fully outside the home radius, and the pin needs a real accuracy. A missing pin, a pin at the house, or a pin whose accuracy reaches the house means he is home.

A quiet pin is also home. The floor is 20 minutes. Farther away, the script allows the pin to be older only for as long as a fast drive (about 90 km/h) would need to reach the house. Older than that, he may have come back without a new dot. Leave the lights.

A life-state sample from the last 30 minutes with place `kirkland-home` also means he is home, even if the phone dot says otherwise.

Receipts go in `education/you@example.com/home/lights.json`. Names and rooms only.

## Vacuum state

`education/you@example.com/home/vacuum.json`

`lastStartedAt` is the last time the scene actually started. The hourly script treats a start under 72 hours old as not due. At exactly 72 hours it is due again.

A skip writes `lastSkippedAt`, `skipReason`, and `nextCheckAt`. It must leave `lastStartedAt` alone. Use the record commands. Do not hand-edit the JSON.

## Before you decide

Read the vacuum file. Then:

- Apple Calendar for the next several hours: `node server/calendar-cli.js events --from <now ISO> --to <now plus 6 hours ISO>`
- Life state: `node server/life-state.js now` and `node server/life-state.js recent 6`
- On a school day, today's classes in `education/you@example.com/schedule.json`

The phone pin in the prompt is last-known GPS. A stale home pin means he is still home. Missing GPS is not a reason to vacuum. The script already stopped those cases unless this run was `--force`.

Parents live in the Kirkland house. Yan being out does not mean the house is empty.

## Start only if both are true

- He is unlikely to be home within 2 hours. Use the calendar, the school day, life-state, and the usual leave and return pattern. The run should be finished before he walks in. Two hours is that buffer.
- The house will not be asleep during those 2 hours. Early morning is no. An evening where people will be in bed within 2 hours is no. A long absence does not override that.

## If yes

```bash
node server/home-agent.js trigger --reason "<one line>"
```

That triggers `Vacuum Yan` and records the start. Never trigger `Vacuum Yan's Rooms`.

HomeClaw often lists `action_count` 0 for this scene. The Roomba still starts. Record the start unless the trigger command itself fails.

If HomeClaw is down or the trigger fails, do not record a start. Say what failed.

## If no

```bash
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

`next-check` is when it is worth asking again. Next morning, or just after the calendar block that would put him home. The hourly script still runs, and it will not spend another Composer call until then.

Do not git commit. Do not edit any other file.
