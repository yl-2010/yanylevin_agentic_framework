# AGENTS.md

How this repo operates. `SOUL.md` is persona. Do not put operator life facts in this file.

## Git

Work on `main`. Do not commit `server/.env`, tokens, Health dumps, chat history, or `education/*/brain/people/`.

## Open-source origin

This tree is a sanitized export of a private personal OS. If you are working in the **private** yanylevin repo, follow that repo's AGENTS.md instead, including the oss-mirror skill.

## Mac API

If you change `server/**` and this machine runs the LaunchAgent, restart it:

```bash
launchctl kickstart -k "gui/$(id -u)/com.personalagent.server"
curl -sS -f http://127.0.0.1:3004/health
```

Plist names in `deploy/launchagents/` are templates. Rename the label to match what you loaded.

## Operator identity

`OWNER_EMAIL` in `server/.env` is the one allowlisted account. Education and fitness data live under `education/<that email>/` and `fitness/<that email>/`.

## Unslop

Read `.cursor/skills/unslop/SKILL.md` on every turn. Apply it. Do not paste it into prompts.

## iOS

Reference app only. Fork and rename before signing. Placeholders: bundle ID, team, App Group, URL scheme.

## Do not

- Tunnel LM Studio
- Commit secrets
- Copy real GPS, Health, mail, or Messages dumps into git
