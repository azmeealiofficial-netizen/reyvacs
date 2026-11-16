# Reyva Creative Studio

Branded social content for **Reyva Online** (reyvaonline.com): paste an
article link and get Reyva's news card (red or blue) ready to post, plus the
reel and video studios.

A standalone copy of VxD Super App's Creative Studio (`cs/`). The `cs/` and
`lib/` layout matches VxD on purpose, so a fix there can be carried here by
diff. Everything Reyva-specific is marked `REYVA` in the code; the main pieces:

| File | What |
|---|---|
| `cs/public/reyva-card.js` | Reyva's card layouts (news; quote is built but not offered yet) |
| `lib/reyva-article.js` | Reads articles from reyvaonline.com's JSON API |
| `cs/lib/share-targets.js` | `reyva` is the only masthead |
| `auth-core.js` | Stand-in for VxD login — **open access for now** |

## Run on the home server

```bash
cp .env.example .env      # set POSTGRES_PASSWORD, CS_ANTHROPIC_API_KEY, COOKIE_SECRET, CS_LOCK_CODE
docker compose up -d --build
```

Point `reyva.azmee.dev` at port 3000 on the reverse proxy. Health check: `/health`.

## Run locally

```bash
npm install
DATABASE_URL=postgres://user:pass@localhost:5432/reyva npm start
```
