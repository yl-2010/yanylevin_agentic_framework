# Start everything (Mac Studio + yanylevin.com API)

Production site (**https://yanylevin.com**) will call **https://api.yanylevin.com** for the future chatbot. Your Mac exposes the Express API on port **3004** through a dedicated Cloudflare Tunnel.

---

## After a Mac restart

LaunchAgents auto-start the Yan Levin API, the tunnel, and LM Studio on login. `com.yanylevin.lmstudio-gpt-oss` opens LM Studio, starts the local server on **1234**, and loads **openai/gpt-oss-20b** at context 131072 with 4 slots and no idle timeout. That is the same load that is resident now. Orpheus is not part of this. another local API voice loads it per request.

Then check:

```bash
curl -sS http://127.0.0.1:3004/health
curl -sS https://api.yanylevin.com/health
```

### LaunchAgents on this Mac

| Label | What |
|-------|------|
| `com.personalagent.server` | Yan Levin Express `:3004` (`node --env-file=.env index.js`) |
| `com.personalagent.cloudflared` | Tunnel → `api.yanylevin.com` |
| `com.personalagent.education-sync` | Auto push/pull education + fitness folders, JYPE workspace, `tmp/`; optional OneDrive relaunch |
| `com.yanylevin.cursor-usage` | Read this Mac's Cursor chats and post them to `/api/usage/ingest`. Studio also pulls the billing feed. Person is Yan unless `data/usage/machine.json` says otherwise |
| `com.yanylevin.lmstudio-gpt-oss` | Open LM Studio at login and load `openai/gpt-oss-20b`. It stays loaded |

Plists live in `~/Library/LaunchAgents/`.

```bash
bash $HOME/yanylevin_agentic_framework/deploy/launchagents/install-lmstudio-gpt-oss.sh
```

Logs: `/tmp/yanylevin-lmstudio-gpt-oss.log`. This agent only loads gpt-oss. Orpheus stays unloaded until another local API voice asks for it.

### Education / data folder sync (Mac Studio + MacBook)

Keeps `tmp/` in sync with `origin/main`. Education, JYPE, fitness, and the chat and login logs live on OneDrive.

Behavior:

- Local file changes → debounce → commit → pull → push
- Remote changes → poll (~20s on the Studio, ~5s on the MacBook) → fast-forward when this Mac has no extra commits, otherwise rebase onto `origin/main` (do not `git pull --rebase origin main`; Apple Git 2.54 errors with "Cannot rebase onto multiple branches"). Fetch uses IPv4 SSH to `ssh.github.com:443`, then retries `github.com:22` with ssh config ignored on DNS or timeout. A fetch left open across sleep is killed on wake. A hung git+ssh group is killed so leftover ref locks cannot freeze the next poll. Catch-up rebases get 5 minutes. Unheld `.git/*.lock` files (index, HEAD, `origin/main`) are deleted.
- Same poll: if fewer than two `OneDrive` GUI processes are running, optionally relaunch OneDrive. Waits 2 minutes between retries if launch fails.

Install / reload on each Mac (repo path `$HOME/yanylevin_agentic_framework`, Homebrew node):

```bash
bash $HOME/yanylevin_agentic_framework/deploy/launchagents/install-education-sync.sh
```

Logs: `/tmp/yanylevin-education-sync.log`. Those user-data commits never deploy the site. Git auto-deploy is off. Agents run `npm run deploy:web` for homepage, `/education` `/fitness` `/dashboard` UI, and `api/`, not for `education/<email>/` or `education/projects/jype/` sync.

### Cursor usage collector (Mac Studio + MacBook)

Reads Cursor's local chat database and posts prompts to the Studio API. The Studio copy also pulls token totals from Cursor's billing feed. Logs stay in `data/usage/` on the Studio and are not committed.

```bash
bash $HOME/yanylevin_agentic_framework/deploy/launchagents/install-cursor-usage.sh
```

`USAGE_INGEST_TOKEN` lives in `server/.env` on both Macs (same value). The MacBook posts to `https://api.yanylevin.com`. Person is Yan. A one-line `data/usage/machine.json` (`{"person":"Yan"}`) overrides that. Logs: `/tmp/yanylevin-cursor-usage.log`.

---

## Manual start (only if LaunchAgents are not installed)

### Terminal 1 — LM Studio

`com.yanylevin.lmstudio-gpt-oss` does this at login. By hand:

```bash
open -g -a "LM Studio"
lms server start
lms load openai/gpt-oss-20b --context-length 131072 --parallel 4 --identifier openai/gpt-oss-20b -y
```

### Terminal 2 — API

```bash
cd $HOME/yanylevin_agentic_framework
npm run server
```

### Terminal 3 — Tunnel

```bash
cloudflared tunnel --config ~/.cloudflared/config-yanylevin.yml run
```

First-time tunnel setup: [`deploy/cloudflared/README.md`](../deploy/cloudflared/README.md).

---

## Ports (this Mac)

| Port | Service | Public? |
|------|---------|---------|
| 3000 | ExampleCo Express | via `api.example.com` |
| 3002 | another local API Express | via `api.example.com` |
| 3004 | Yan Levin Express | via `api.yanylevin.com` |
| 1234 | LM Studio | **never** (localhost only) |
