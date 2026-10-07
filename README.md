# mini-flytripvisa-template

Streaming AI chat (Fly Dragon 🐉) powered by the Muse API, integrated into the
Fly Trip Visa site and deployed on Cloudflare Workers.

## Architecture

```
Browser  --POST /api/ai-chat-->  Cloudflare Worker  -->  Muse API (SSE stream)
   ^                                      |
   |<-- text/event-stream (tokens) --------'
```

- The **Muse API key never reaches the browser**. It lives only in
  `env.MUSE_API_KEY` on the Cloudflare edge (set via `wrangler secret put`).
- The browser calls only `/api/ai-chat` (same origin).
- The AI answer is streamed token-by-token in real time (Server-Sent Events).
- Static assets (`index.html`, images, fonts, etc.) are served normally from `/`.

## Project structure

```
mini-flytripvisa-template/
├── index.html              # Frontend (chat UI + streaming aiSendMessage)
├── src/
│   └── index.ts            # Cloudflare Worker (Muse proxy + SSE)
├── wrangler.jsonc          # Cloudflare config + env bindings
├── package.json
└── README.md
```

## Quick start

```bash
npm install
wrangler login
wrangler secret put MUSE_API_KEY      # paste your key (never committed)
wrangler deploy
```

## Environment variables

| Variable        | Set via              | Description                                  |
|----------------|----------------------|----------------------------------------------|
| `MUSE_API_KEY` | `wrangler secret put`| Your Muse API key (**secret**, never in Git)  |
| `MUSE_API_URL` | `wrangler.jsonc`     | Muse endpoint (default: `https://api.meta.ai/v1/chat/completions`) |
| `MUSE_MODEL`   | `wrangler.jsonc`     | Model name (default: `muse-spark-1.3`)       |

Override `MUSE_API_URL` / `MUSE_MODEL` in `wrangler.jsonc` if your Muse
provider uses a different endpoint or model name.

## Changing the Muse API format

If your Muse API uses a non-standard request or stream format, edit **only**
these two functions in `src/index.ts`:

1. `buildMuseBody()`      — shapes the request sent to Muse
2. `parseMuseStreamChunk()` — parses one SSE line coming from Muse

Everything else (SSE framing, CORS, fallback, static-asset passthrough) is
independent.

## Manual GitHub setup

1. Create folder `src/` in `mini-flytripvisa-template`.
2. Add `src/index.ts` (this repo).
3. Add `wrangler.jsonc`, `package.json`, `README.md` (this repo).
4. Replace `index.html` with the streaming version (this repo).
5. Commit:

```bash
git add .
git commit -m "feat: add streaming AI chat via Cloudflare Worker"
git push
```

## Testing

### 1. Static site (root)

```bash
curl https://mini-flytripvisa-template.<your-subdomain>.workers.dev/
```

Expected: full HTML of the Fly Trip Visa homepage.

### 2. Streaming chat

```bash
curl -N -X POST https://mini-flytripvisa-template.<your-subdomain>.workers.dev/api/ai-chat \
  -H "Content-Type: application/json" \
  -d '{"message":"What visa do I need for Dubai?","context":null,"source":"hero-ai-search"}'
```

Expected (tokens arrive in real time):

```
data: {"token":"For"}
data: {"token":" Dubai"}
data: {"token":","}
...
data: [DONE]
```

### 3. Verify streaming in the browser

1. Open the site → open the Fly Dragon 🐉 chat popup.
2. Type a question and send.
3. Tokens should appear **progressively**, not all at once after a delay.
4. DevTools → Network → `/api/ai-chat` → Response tab: confirm chunked SSE frames.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `404` on `/api/ai-chat` | Route not matched | Confirm `routes` in `wrangler.jsonc` and that `src/index.ts` exports `fetch` |
| CORS error | Response headers stripped | Worker sends `Access-Control-Allow-Origin: *`; check any CDN/proxy in front |
| Muse auth failure (`401`/`403`) | Wrong/missing key | Re-run `wrangler secret put MUSE_API_KEY` and verify the key |
| Streaming not appearing (waits, then full answer) | Muse SSE format differs | Adjust `parseMuseStreamChunk()` in the Muse adapter |
| Static assets 404 | Assets not served | Confirm `"assets": { "directory": "./" }` in `wrangler.jsonc` |
| Deploy fails (TypeScript) | Type error | Run `npm run typecheck` locally |
| `MUSE_API_KEY` undefined in worker | Secret not set | `wrangler secret list` to confirm; re-add if missing |

## License

Internal use — Fly Trip Visa.
