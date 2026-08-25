# Public API tunnel (`api.yanylevin.com`)

**`yanylevin.com` is a Cloudflare zone** (nameservers on Cloudflare). A dedicated tunnel exposes only the Mac Express API.

```
Browser
  → https://api.yanylevin.com
       → Cloudflare Tunnel (cloudflared, config-yanylevin.yml)
            → Express :3004
                 → LM Studio http://127.0.0.1:1234/v1  (never tunnelled)
```

## Live setup (this Mac)

| Item | Value |
|------|--------|
| Cloudflare account | your Cloudflare account |
| Zone | `yanylevin.com` |
| Nameservers | `ns1.cloudflare.com`, `ns2.cloudflare.com` |
| Tunnel | `yanylevin-api` → `TUNNEL_UUID` |
| Config | `~/.cloudflared/config-yanylevin.yml` |
| DNS | Proxied CNAME `api` → `<tunnel-uuid>.cfargotunnel.com` |
| Apex / www | Point at Vercel (A records) so the static site stays on Vercel |

Do **not** attach `api.yanylevin.com` as a Vercel project domain.

Run one tunnel for this API. Do not merge it with unrelated products.

## Runtime

LaunchAgents `com.personalagent.server` + `com.personalagent.cloudflared`, or manually:

```bash
npm run server
cloudflared tunnel --config ~/.cloudflared/config-yanylevin.yml run
```

## Verify

```bash
npm run verify:public-api
# or
curl -sS https://api.yanylevin.com/health
```

Details: [`deploy/cloudflared/README.md`](../deploy/cloudflared/README.md).
