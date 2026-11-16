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
| `relay/` | Telegram share desk — VxD's share-group flow, Reyva only |

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

## Telegram share desk

Every new reyvaonline.com story arrives in the desk group as a share card:
the studio's red card (drawn on the server by the studio's own
`reyva-card.js`), an AI caption, a tick per configured channel and
📣 Share. VxD Super App's share-group flow (`relay/share.js` unchanged);
no rewrite or newsroom desk.

Cards arrive **blue** (the normal card); 🎨 on a card switches it to red and
back, until anything has been shared. A fixed keyboard sits under the message
box (🔗 Share a link · 📰 Latest stories · 📊 Status · ❓ Help), and "/" lists
the commands: `/latest`, `/pull <link>`, `/share <id>`, `/status`, `/menu`,
`/help`, `/id`. Pasting a Reyva link on its own also makes a card. Reply to a card to replace its caption, or ✏️ Edit caption
with `old → new` lines to fix a word. Posting from the studio ticks the
story's card.

Setup: see the "Telegram share desk" block in `.env.example`. The first check
after switching on only records where the site is; cards start with the next
story.
