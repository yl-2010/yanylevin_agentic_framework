# Local LLM backend

Express API in [`server/`](../server/) proxies chat to **LM Studio** on the Mac (`http://127.0.0.1:1234/v1`, model `openai/gpt-oss-20b`).

## Endpoints

| Method | Path | Auth | Notes |
|--------|------|------|-------|
| `GET` | `/health` | none | Service + LM Studio probe |
| `POST` | `/api/chat` | Bearer JWT | Body: `{ messages: [{role, content}, ...] }` |

JWT claims: issuer `yanylevin-next`, audience `yanylevin-mac-api`. Secret is `AUTH_SECRET` in `server/.env` (must match Vercel `NEXTAUTH_SECRET` when Auth.js is added).

## Env

Copy [`server/.env.example`](../server/.env.example) → `server/.env`. Defaults:

- `PORT=3004`
- `LM_STUDIO_BASE_URL=http://127.0.0.1:1234/v1`
- `LM_STUDIO_MODEL=openai/gpt-oss-20b`

## Run

```bash
cd $HOME/yanylevin_agentic_framework
npm install --prefix server
npm run server
```

See also [`STARTUP.md`](./STARTUP.md) and [`PUBLIC_TUNNEL.md`](./PUBLIC_TUNNEL.md).
