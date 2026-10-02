# struct-proxy

A transparent proxy for the [Blatent API](https://blatent.ai/docs/) (`blatent-struct`) that adds the analytics the API doesn't have yet: a request log, token counts, latency and error codes, broken down by demo. It runs as a single Vercel Function with a small dashboard.

```
demo  ──▶  https://<your-proxy>.vercel.app/<demo>/v1/resolve  ──▶  https://api.blatent.ai/v1/resolve
                         │
                         └─▶ Upstash Redis (after the response is sent) ──▶ dashboard at /
```

## What "transparent" means here

- Method, path, query string, headers (including `Authorization`) and body are forwarded as they are. Only hop-by-hop headers, Vercel's own routing headers and the optional `X-Proxy-Tag` are dropped.
- Status, headers and body come back unchanged. The one difference: compressed upstream bodies are passed on decompressed, without the `Content-Encoding` header.
- The proxy never retries. Blatent has no idempotency key and allows one resolve per account at a time, so `429 CONCURRENCY_LIMITED` passes straight through (and shows up under **Errors by code**).
- Analytics are written after the response has been sent, so storage never delays or breaks a request.

## Use it from a demo

Swap the base URL. Add a path segment to tag the demo:

| Base URL | Requests are tagged |
| --- | --- |
| `https://<your-proxy>.vercel.app` | `default` |
| `https://<your-proxy>.vercel.app/booking-demo` | `booking-demo` |

```python
client = httpx.Client(
    base_url="https://<your-proxy>.vercel.app/booking-demo",
    headers={"Authorization": f"Bearer {os.environ['BLATENT_API_KEY']}"},
    timeout=195,
)
client.post("/v1/resolve", json={"input": "...", "schema": schema})
```

```typescript
await fetch("https://<your-proxy>.vercel.app/booking-demo" + "/v1/resolve", { ... });
```

You can also keep the plain base URL and send an `X-Proxy-Tag: booking-demo` header. Tags may contain letters, digits, `.`, `_` and `-`.

## Deploy on Vercel

1. **Import the repo.** Vercel → Add New → Project → `clauderitter/struct-proxy`. No build settings are needed.
2. **Add storage.** In the project, open Storage → Marketplace → **Upstash for Redis**. Create a database on the free plan in a US East region and connect it to the project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
3. **Set `DASHBOARD_TOKEN`.** Settings → Environment Variables. Use a long random string, e.g. `openssl rand -hex 24`.
4. **Redeploy**, then open `https://<your-proxy>.vercel.app/#token=<DASHBOARD_TOKEN>`. The token is stored in your browser, and the `#fragment` never reaches the server.

Without storage the proxy still works. Each request is logged as one JSON line in the Vercel runtime logs (search for `struct-proxy`), and the dashboard shows a notice.

## Dashboard

- Totals for the range: requests, error rate, input and output tokens, average latency, p50/p90 latency
- Requests, input tokens and output tokens per hour (24 hours) or per day (7/30/90 days, UTC), each with a table view
- A per-demo breakdown. Click a row to filter everything by that demo.
- Errors grouped by Blatent error code
- Recent requests. Click a row to see the request ID, schema, policy, API-key fingerprint, `Server-Timing`, user agent, and the stored request and response bodies.
- Refreshes every 10 seconds while the tab is visible, so you can watch it during a live demo
- **Reset stats…** deletes everything stored (request log, counters and bodies for every demo) after a confirmation, e.g. to start a demo with a clean slate. Requests sent while a reset runs may survive it.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `DASHBOARD_TOKEN` | — | Required for the dashboard API. Without it, `/_proxy/stats` returns 503. |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | — | Upstash REST credentials. `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` also work. |
| `UPSTREAM_URL` | `https://api.blatent.ai` | Where requests are forwarded. |
| `UPSTREAM_TIMEOUT_MS` | `295000` | Kept below the function's 300 s limit. Blatent asks for client timeouts of at least 195 s. |
| `LOG_BODIES` | on | Set to `0` to store no request or response bodies. |
| `BODY_LIMIT` | `16384` | Bytes kept per body. |
| `BODY_TTL_DAYS` | `7` | How long bodies are kept. |
| `LOG_LIMIT` | `2000` | Request-log entries kept (newest first). |
| `REDIS_PREFIX` | `sp:` | Key prefix, if you share the database. |

## What gets stored

- **Request log** (`sp:log`, the newest `LOG_LIMIT` entries): timestamp, tag, method, path, status, Blatent error code, latency, `usage.input_tokens` / `usage.output_tokens`, request and response sizes, `schema_id` (or `inline`), `schema_digest`, `policy_id` (or `inline`), `Retry-After`, `Server-Timing`, user agent, and the `X-Blatent-Request-ID`.
- **Counters** (`sp:day:YYYY-MM-DD`, kept 120 days): requests, failures, input and output tokens, and total latency per demo per UTC hour.
- **Bodies** (`sp:body:<request-id>`, kept `BODY_TTL_DAYS`): request and response bodies, truncated to `BODY_LIMIT`. These can contain whatever your demos send in `input`, `state` and `user_context`. Turn them off with `LOG_BODIES=0`.
- **API keys are never stored.** Only the first 8 hex characters of their SHA-256 hash are kept, so you can tell keys apart.

Each proxied request costs about 9 Upstash commands. Loading a range costs one command per day plus one, and each 10-second live refresh costs 3. The free plan covers demo-scale traffic.

## Routes

| Route | |
| --- | --- |
| `/v1/*`, `/<tag>/v1/*` | Proxied to `UPSTREAM_URL` |
| `/` | Dashboard (static page) |
| `/_proxy/health` | Public. Upstream URL and whether storage and the dashboard are configured. |
| `/_proxy/stats?days=7&limit=500` | Counters and recent log entries. `Authorization: Bearer <DASHBOARD_TOKEN>` |
| `/_proxy/log/<request-id>` | Stored bodies for one request. Same auth. |
| `POST /_proxy/reset` | Deletes every key under `REDIS_PREFIX`. Same auth. Returns `{"deleted": <count>}`. |

## Deployment notes

- The function runs in `cle1` (Cleveland) because `api.blatent.ai` is hosted in AWS us-east-2 (Ohio), which keeps the extra hop to a few milliseconds. Change `regions` in `vercel.json` if that changes.
- `maxDuration` is 300 s with Fluid compute, the Hobby maximum. Some resolves take over a minute.
- On the Hobby plan, Vercel can block Git deployments when a commit's author or co-author isn't the account owner. This has been reported for `noreply@anthropic.com` AI co-author trailers. Keep commits authored by your own GitHub identity.

## Local development

```bash
npm install
npm run dev
```

This serves the proxy and dashboard at http://localhost:3000. Open http://localhost:3000/#token=dev. Analytics are kept in memory unless you put Upstash credentials in `.env.local`. Point it at another upstream with `UPSTREAM_URL=... npm run dev`. `npm run typecheck` runs TypeScript.
