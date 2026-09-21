---
name: typesafe-ai
description: >-
  Call TypeSafe Jev from this repo for typed classify, route, score, and
  yes/no decisions. Use when adding Jev, TypeSafe, system-one, or replacing
  an LLM prompt-and-parse step with a structured judgment. Not for chat,
  code, titles, or summaries.
---

# TypeSafe / Jev (this repo)

Jev is a system-one model. State in, typed answers out. Code owns the
workflow. Do not ask it to write prose.

Official TypeSafe skill (read it, then the live docs it names):
`.agents/skills/typesafe-ai/SKILL.md`

Docs index: https://docs.typesafe.ai/llms.txt
JS SDK: https://docs.typesafe.ai/sdk/javascript.md
HTTP: https://docs.typesafe.ai/api.md

## Wiring

- Key: `TYPESAFE_API_KEY` in `server/.env`. Never commit it. Never send it to a browser.
- Client: `server/typesafe.js`. Re-exports `choice`, `noul`, `score`, `TypeSafeClient`.
- Call: `systemOne({ state, questions })` from that file.
- Smoke: `node --env-file=server/.env server/typesafe.js ping` (repo root) or `npm run typesafe`
- Default model: `jev-latest`

```js
import { systemOne, choice, noul } from "./typesafe.js";

const { answers } = await systemOne({
  state: { subject: "Re: invoice", snippet: "charged twice" },
  questions: {
    is_billing: noul("Is this about billing or payments?"),
    bucket: choice("Which bucket?", {
      billing: "Payments, invoices, refunds",
      other: "Anything else",
    }),
  },
});
```

Ask independent questions in one request. They run in parallel and cannot see each other.

Choice and Score include `confidence`. Noul is only the 0–1 yes probability. Thresholds belong in this repo's code, not in the prompt.

If the live docs and this file disagree, the docs win for API shape. This file wins for where the key and client live.
