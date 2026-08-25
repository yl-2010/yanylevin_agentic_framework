# Start everything (Mac Studio + yanylevin.com API)

Production site (**https://yanylevin.com**) will call **https://api.yanylevin.com** for the future chatbot. Your Mac exposes the Express API on port **3004** through a dedicated Cloudflare Tunnel.

---

## After a Mac restart

LaunchAgents auto-start the Yan Levin API + tunnel on login. You only need to start **LM Studio** yourself (GUI):

1. Open **LM Studio**.
2. Load **openai/gpt-oss-20b**.
3. **Developer** tab → turn **local server** **ON** (listening on **1234**).

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
| `com.personalagent.education-sync` | Auto push/pull education + fitness folders, ; optional OneDrive relaunch |

Plists live in `~/Library/LaunchAgents/`.

### Education / data folder sync (Mac Studio + MacBook)

Keeps these paths in sync with `origin/main`:

- `education/you@example.com`, `education/you@example.com`
- `fitness/you@example.com`, `fitness/you@example.com`
- 

Behavior:

- Local file changes → debounce → commit → pull `--rebase` → push
- Remote changes → poll (~20s) → pull `--rebase`. Git fetch/push die after 45s so a hung SSH cannot block later polls.
- Same poll: if fewer than two `OneDrive` GUI processes are running, optionally relaunch OneDrive. Waits 2 minutes between retries if launch fails.

Install / reload on each Mac (repo path `$HOME/yanylevin_agentic_framework`, Homebrew node):

```bash
bash $HOME/yanylevin_agentic_framework/deploy/launchagents/install-education-sync.sh
```

Logs: `/tmp/yanylevin-education-sync.log`. Those user-data commits never deploy the site. Git auto-deploy is off. Agents run `npm run deploy:web` for homepage, `/education` `/fitness` `/dashboard` UI, and `api/`, not for `education/<email>/` sync.

---

## Manual start (only if LaunchAgents are not installed)

### Terminal 1 — LM Studio (GUI)

1. Open **LM Studio**.
2. Load **openai/gpt-oss-20b**.
3. **Developer** tab → local server **ON** on **1234**.

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
