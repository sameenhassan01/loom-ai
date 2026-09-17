# Loom AI — case intake (backend + frontend)

This is a small Express server that holds your Anthropic API key server-side
and exposes it to the browser through three endpoints, plus the frontend
that calls them. Nothing touches your API key except this server.

## Run it

```bash
cd loom-ai-backend
npm install
cp .env.example .env
```

Open `.env` and paste in a key from the Claude Console
(https://console.anthropic.com/settings/keys):

```
ANTHROPIC_API_KEY=sk-ant-...
```

Then:

```bash
npm start
```

Open **http://localhost:3000** — that's the app. Uploads go to `/api/extract`
(image or PDF), pasted text goes to `/api/extract-text`, and the case brief
comes from `/api/brief`. All three run on the server, so the key never
reaches the browser.

## What changed from the artifact version

- The frontend no longer uses `window.claude.use('sample')` — it calls
  `fetch('/api/...')` on this server instead.
- PDF support is real now: PDFs are sent to Claude as a `document` content
  block, images as an `image` block — both handled in `server.js`.
- No viewer permission gating: since this isn't running inside a Claude
  artifact, there's no "images unavailable for this account" banner. If a
  request fails, it's a real error (bad file type, missing key, network) and
  you'll see the actual message.

## Before you show this to anyone else

- **CORS is wide open** (`app.use(cors())`) for local dev convenience.
  If you deploy this somewhere reachable by other people, restrict it to
  your actual frontend origin — otherwise anyone can call your endpoints
  and spend your API credits.
- **Rate-limit or gate the endpoints** if this goes anywhere public. Right
  now anyone who can reach `/api/extract` can run up your bill.
- Consider a max-requests-per-minute guard or a simple shared secret header
  if you deploy this before the hackathon judging — even a basic
  `x-demo-key` check beats leaving it wide open.

## Deploying (optional)

Any Node host works — Render, Railway, Fly.io, a VPS. Set
`ANTHROPIC_API_KEY` as an environment variable on the host (never commit
`.env`), and the `public/` folder is served automatically by `server.js`.
