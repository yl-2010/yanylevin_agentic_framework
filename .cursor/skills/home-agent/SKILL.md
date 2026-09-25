---
name: home-agent
description: >-
  Hourly home vacuum check. Composer 2.5 decides whether to start the
  Vacuum Yan scene when Yan has been away and the last run is at least
  72 hours old. Yan only.
disable-model-invocation: true
---

# Home agent — vacuum

Yan only (`you@example.com`). Local Cursor agent on the Mac Studio. Never a cloud agent. Model is Composer 2.5 with Fast off.

The hourly script in `server/home-agent.js` does the cheap checks. This skill is the decision after those checks pass. Do not start the Roomba from a chat turn. When Yan says run the home agent or check the vacuum, run:

```bash
node --env-file=server/.env server/home-agent.js --force
```

`--force` skips the cheap gates and still lets this decision stand. It does not force the scene on.

## State

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

Trigger this scene and no other:

```bash
node server/home-cli.js trigger "Vacuum Yan"
```

Never trigger `Vacuum Yan's Rooms`.

Only after that command succeeds:

```bash
node server/home-agent.js record-start --reason "<one line>"
```

If HomeClaw is down or the trigger fails, do not record a start. Say what failed.

## If no

```bash
node server/home-agent.js record-skip --reason "<one line>" --next-check <ISO time>
```

`next-check` is when it is worth asking again. Next morning, or just after the calendar block that would put him home. The hourly script still runs, and it will not spend another Composer call until then.

Do not git commit. Do not edit any other file.
