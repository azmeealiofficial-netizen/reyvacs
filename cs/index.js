// ─────────────────────────────────────────────────────────────────────────────
// cs/index.js — Reyva Creative Studio (from VxD Creative Studio's cs/index.js)
// ─────────────────────────────────────────────────────────────────────────────
// REYVA FORK (2026-11-16). Lifted out of VxD Super App with the cs/ + lib/
// layout kept as-is so fixes can be diffed across. What differs from VxD:
//   • Served at the site root by ../server.js, not mounted at /cs.
//   • ../auth-core is a stand-in: open access, one user, one masthead.
//   • The "tick the relay share card" middleware is gone — VxD's Telegram
//     relay groups (relay/share.js) do not exist here.
//   • /api/fetch-article reads reyvaonline.com's JSON API (lib/reyva-article)
//     — the site renders client-side, so the Fanvaiy scraper below finds no
//     text there. The scraper is left in place, unreachable for Reyva.
//   • lib/local-fetcher is a plain-fetch shim; no office Dell, no /api/fetcher.
// The VxD notes below are kept: they explain code that is still here.
// ─────────────────────────────────────────────────────────────────────────────
//
// ── original header ──
// Was a standalone Express 4 app (server.js) at cs.vxd.news. It is now a Router
// on the super app. What changed, and why:
//
//   • Facebook publishing (routes/facebook.js, routes/fb-reels.js) and the
//     /api/articles/published metrics view did not come across. Nothing called
//     them — no client code, no cron, no internal caller — and Azmee confirmed
//     the Facebook API work is no longer in use. They are still in the VxdCs
//     repo and under the pre-cs-merge tag if that ever changes.
//   • Everything under /api is behind the host app's session now. Creative
//     Studio had no accounts at all — /api/ai/* spent Anthropic credit for
//     anyone who found the URL. Three paths stay open by necessity and are
//     listed in PUBLIC_API below.
//   • The three tables are prefixed cs_. `settings` in particular was close
//     enough in shape to VSA's that CREATE TABLE IF NOT EXISTS would silently
//     have no-opped and this app would have been writing into VSA's settings.
//   • The SPA fallback was app.get('/{*splat}'), path-to-regexp v8 syntax, on
//     Express 4 — where the braces are literal characters, so it compiled fine
//     and never matched. Masked all this time by express.static serving
//     index.html at /, which is why nobody noticed that deep links 404'd. It is
//     router.get('*') now.
//   • The 100mb body limit lives in server.js, mounted ABOVE the global 50mb
//     parser. A parser mounted here cannot help: the global one runs first and
//     413s a base64 reel before this router is ever reached.
//   • setupWebhook() no longer runs unconditionally at boot. The old service
//     shares this bot token, so whichever container restarted last owned the
//     webhook — and Railway restarts on its own. It is opt-in via
//     CS_SET_WEBHOOK=1, flipped once at cutover.
//   • Anthropic and Telegram env vars are CS_-prefixed. ANTHROPIC_API_KEY is
//     deliberately absent from this service's environment so that /studio's
//     Settings UI keeps ownership of it; TELEGRAM_BOT_TOKEN is VSA's own
//     fallback and a different bot entirely.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const asyncRouter = require('../lib/async-router');
const db = require('./db');
const aiRoutes = require('./routes/ai');
const telegramRoutes = require('./routes/telegram');
const fbCaptionRoutes = require('./routes/fb-caption');
const xRoutes = require('./routes/x');
const viberRoutes = require('./routes/viber');
const { firstAttrValue, metaContent } = require('./lib/html-extract');
const shareTargets = require('./lib/share-targets');
const { BRAND_SITES, langOf } = require('./lib/share-targets');
const { articleFetchOpts } = require('../lib/article-fetch');
const localFetcher = require('../lib/local-fetcher');
const reyvaArticle = require('../lib/reyva-article');
const { parseSection } = reyvaArticle;
const { attachUser, requireAuth, requireBrand, brandsOf } = require('./middleware/auth');
const auth = require('../auth-core');

// asyncRouter, not express.Router: on Express 4 a rejected promise from an async
// handler escapes, the response is never written and the request hangs with
// nothing logged. Fourteen handlers here await outside a try.
const router = asyncRouter();

// Creative Studio's own assets, served from inside the router so /cs is
// self-contained. Dropping them into the host app's public/ would serve
// card-studio.js and img/ from the root, where they shadow VxD files.
router.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The SPA's HTML and JS must never be cached: a stale copy runs last week's
    // client against this week's API, and the symptom is a deploy that looks
    // like it did not happen.
    if (/\.(html|js|json)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=86400');
  }
}));

// No cookie-parser anywhere in this app: VSA is Bearer-first and auth-core reads
// the one cookie it needs straight off the header. Creative Studio's Settings
// lock code is the only other cookie, so it does the same rather than pulling in
// a dependency for one read.

router.use(attachUser);

// Three paths cannot be behind a session and are not oversights:
//   /api/telegram/webhook — Telegram POSTs it. Guarded by the secret_token
//                           header instead (see routes/telegram.js).
//   /api/viber/webhook    — exists only to answer 200; Viber refuses to accept
//                           posts on a Channel with no webhook registered.
//   /media/:id.jpeg       — Viber fetches the image from its own servers,
//                           unauthenticated. Random ids, purged after an hour.
//                           Not under /api, so the gate below skips it anyway.
//   /api/fetcher/next, /api/fetcher/result
//                         — the office Dell's local fetcher (lib/local-fetcher.js).
//                           Guarded by the CS_FETCHER_KEY bearer instead.
const PUBLIC_API = new Set(['/api/telegram/webhook', '/api/viber/webhook', ...localFetcher.PUBLIC_PATHS]);

router.use((req, res, next) => {
  const p = (req.path || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (!p.startsWith('/api')) return next();     // static, /media and the SPA shell
  if (PUBLIC_API.has(p)) return next();
  return requireAuth(req, res, next);
});

// Every request that names a brand is checked against the grant here rather than
// in each handler, so a route added later cannot forget to do it. Four take one
// today: telegram/share, x/publish, viber/share and fb-caption/generate.
router.use((req, res, next) => {
  if (!req.vsaUser) return next();                       // the two public webhooks
  if (!req.body || typeof req.body.brand === 'undefined') return next();
  return requireBrand(req, res, req.body.brand) ? next() : undefined;
});

// The SPA had no 401 handling — it assumed it was always allowed in. It calls
// this on boot, sends the browser to the super app's login page on a 401, and
// uses `brands` to hide the mastheads this person may not work on.
router.get('/api/me', (req, res) => {
  res.json({ ok: true, user: {
    id: req.vsaUser.id, name: req.vsaUser.name, username: req.vsaUser.username,
    brands: brandsOf(req)
  } });
});

/* ─── Auth (lock code protects Settings only, not the app) ─── */
const SECRET = process.env.COOKIE_SECRET || crypto.randomBytes(32).toString('hex');
const COOKIE = 'vxd_settings_auth';

function makeToken(code) {
  return crypto.createHmac('sha256', SECRET).update('vxd:' + code).digest('hex');
}

async function isSettingsAuthed(req) {
  const code = await db.getLockCode();
  if (!code) return true;
  return auth.readCookie(req, COOKIE) === makeToken(code);
}

// Settings lock code login
router.post('/api/settings/login', async (req, res) => {
  try {
    const code = await db.getLockCode();
    if (!code) return res.json({ ok: true, open: true });
    const given = (req.body && req.body.code) || '';
    if (given !== code) return res.status(401).json({ error: 'Wrong code' });
    res.cookie(COOKIE, makeToken(code), {
      httpOnly: true, sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 90 * 24 * 3600 * 1000
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/settings/check', async (req, res) => {
  res.json({ authed: await isSettingsAuthed(req) });
});

/* ─── Settings API ─── */
// GET is open — guidelines needed by all users for AI calls
router.get('/api/settings', async (req, res) => {
  try {
    const all = await db.getAll();
    res.json({ ok: true, guidelines: all.guidelines || '' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST requires settings lock code
router.post('/api/settings', async (req, res) => {
  try {
    if (!(await isSettingsAuthed(req))) return res.status(401).json({ error: 'Unauthorized — enter lock code first' });
    const { key, value } = req.body;
    const allowed = ['guidelines', 'lock_code'];
    if (!allowed.includes(key)) return res.status(400).json({ error: 'Invalid setting' });
    if (key === 'lock_code') {
      if (!value || value.length < 4) return res.status(400).json({ error: 'Code must be at least 4 characters' });
      await db.set(key, value);
      res.cookie(COOKIE, makeToken(value), {
        httpOnly: true, sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 90 * 24 * 3600 * 1000
      });
    } else {
      await db.set(key, value);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* (VxD's relay share-card tick middleware removed — no relay in this app.) */

/* ─── AI extraction ─── */
router.use('/api/ai', aiRoutes);

/* ─── Telegram bot webhook ─── */
router.use('/api/telegram', telegramRoutes);

/* ─── AI caption generation ─── */
router.use('/api/fb-caption', fbCaptionRoutes);

/* ─── X (Twitter) publishing ─── */
router.use('/api/x', xRoutes);

/* ─── Viber Channel publishing ─── */
router.use('/api/viber', viberRoutes);

/* ─── Facebook Page publishing ─── */
router.use('/api/facebook', require('./routes/facebook'));
localFetcher.mount(router);

/* ─── Short-lived public media (Viber fetches the image itself) ───
 * The .jpeg extension is load-bearing: Viber validates that the URL's last path
 * segment ends in .jpeg and rejects the post otherwise. */
router.get('/media/:id.jpeg', async (req, res) => {
  try {
    const row = await db.getMedia(req.params.id);
    if (!row) return res.status(404).send('Not found');
    res.set('Content-Type', row.mime || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(row.bytes);
  } catch (e) {
    console.error('[media] serve error:', e.message);
    res.status(500).send('Error');
  }
});

/* ─── Which brands have social destinations configured ───
 * Readiness flags only — never the tokens themselves. The client uses this to hide
 * share buttons for brands that would fail, rather than offering a button that
 * always errors. */
router.get('/api/share/targets', (req, res) => {
  // Narrowed to the caller's brands, so the client cannot render a share button
  // for a masthead it would be refused on anyway.
  const all = shareTargets.summary();
  const mine = {};
  for (const b of brandsOf(req)) if (all[b]) mine[b] = all[b];
  res.json({ ok: true, targets: mine });
});

/* ─── Articles queue (from Telegram) ─── */
router.get('/api/articles/pending', async (req, res) => {
  try {
    const articles = await db.getPendingArticles(brandsOf(req));
    res.json({ ok: true, articles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/api/articles/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['done', 'skipped', 'pending'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    // The queue is filtered on read, but the id is guessable — check the article's
    // own brand rather than trusting that it was ever displayed to this person.
    const owner = await db.getArticleBrand(req.params.id);
    if (!owner) return res.status(404).json({ error: 'Article not found' });
    if (!requireBrand(req, res, owner)) return;
    await db.markArticle(req.params.id, status);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ─── Article fetch proxy ─── */
router.post('/api/fetch-article', async (req, res) => {
  try {
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'No URL provided' });
    // Resolve the masthead from the host and check it against the grant. Pulling
    // an article is where a card starts, so letting someone fetch a masthead they
    // cannot publish to would only produce work they are refused on at the end.
    // It also keeps this from being a general-purpose fetch proxy.
    const host = ((String(url).match(/^https?:\/\/(?:www\.)?([^/?#]+)/i)) || [])[1] || '';
    const h = host.toLowerCase();
    const urlBrand = Object.keys(BRAND_SITES).find(b => h === BRAND_SITES[b] || h.endsWith('.' + BRAND_SITES[b]));
    if (!urlBrand)
      // Derived from BRAND_SITES rather than spelled out, so adding a masthead
      // cannot leave this message quietly naming three of four.
      return res.status(400).json({ error: 'Only ' + Object.values(BRAND_SITES).join(', ') + ' URLs are supported' });
    if (!requireBrand(req, res, urlBrand)) return;
    const lang = langOf(urlBrand);

    /* Reyva: the JSON API, not the HTML. Same response shape the SPA expects —
     * image as a data URL (the canvas must not be tainted by a cross-origin
     * draw), section = the Dhivehi category name, plus the card-style link. */
    if (urlBrand === 'reyva') {
      const { article, why } = await reyvaArticle.readArticle(url);
      if (!article) return res.status(502).json({ error: 'Could not read the article: ' + why });
      let imageDataUrl = '';
      for (const imgUrl of article.imageUrls) {
        try {
          const ir = await localFetcher.mastheadFetch(imgUrl, 15000, { Accept: 'image/*' });
          if (!ir.ok) continue;
          const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
          imageDataUrl = 'data:' + ct + ';base64,' + Buffer.from(await ir.arrayBuffer()).toString('base64');
          break;
        } catch {}
      }
      if (!article.text) console.warn('[fetch-article] reyva: no body text for', url);
      return res.json({ ok: true, title: article.title, text: article.text, image: imageDataUrl,
        section: article.section, url: article.url });
    }

    // Railway first; on a Cloudflare refusal, the office Dell (lib/local-fetcher.js).
    const r = await localFetcher.mastheadFetch(url, 15000);
    if (!r.ok) {
      /* A non-2xx here is the MASTHEAD refusing this container, not a bug in the
       * extractor below. 'HTTP 403' on its own is unactionable — it cannot tell a
       * WAF block from a rate limit from an origin error, which cost a whole
       * debugging session on 2026-08-30. Cloudflare states the reason in the body
       * and identifies the decision in cf-ray, so capture both. */
      let body = '';
      try {
        body = (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
      } catch {}
      const ray = r.headers.get('cf-ray') || '-';
      console.error('[fetch-article] upstream refused ' + JSON.stringify({
        url,
        status: r.status,
        server: r.headers.get('server') || '-',
        cfRay: ray,
        cfMitigated: r.headers.get('cf-mitigated') || '-',
        rateLimitLimit: r.headers.get('x-ratelimit-limit') || '-',
        rateLimitRemaining: r.headers.get('x-ratelimit-remaining') || '-',
        retryAfter: r.headers.get('retry-after') || '-',
        body
      }));
      throw new Error('HTTP ' + r.status
        + (ray !== '-' ? ' (cf-ray ' + ray + ')' : '')
        + (r.relayNote ? ' \u2014 ' + r.relayNote : '')
        + (body ? ' \u2014 ' + body.slice(0, 140) : ''));
    }
    const html = await r.text();

    const ent = s => (s || '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
      .replace(/&quot;/g,'"').replace(/&#039;/g,"'").replace(/&#x27;/g,"'").replace(/&nbsp;/g,' ')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n));
    const hasThaana = s => /[\u0780-\u07BF]/.test(s);

    /* The script gate is what separates article prose from navigation, share
     * widgets and boilerplate on a Fanvaiy page: chrome is Latin, the story is
     * Thaana. On an ENGLISH masthead that same test rejects every paragraph of the
     * article, and this route answers `{ ok: true, text: '' }` \u2014 no error, no log,
     * the SPA just fills nothing. So the gate is chosen by the masthead's language.
     *
     * The English test cannot simply be "contains a letter", or the Thaana gate's
     * whole job is undone and the nav comes back as paragraph one. Requiring two
     * consecutive real words plus a dozen letters is what makes it a prose test
     * rather than a character test \u2014 "Home", "Share", "Terms & Conditions" and
     * timestamps all fail it, while any genuine sentence passes.
     * Anything not 'en' keeps the exact original behaviour. */
    const hasLatinProse = s => /[A-Za-z]{3,}\s+[A-Za-z]{3,}/.test(s)
      && (String(s).match(/[A-Za-z]/g) || []).length >= 12;
    const hasScript = lang === 'en' ? hasLatinProse : hasThaana;

    // Boilerplate markers that end the article body. Hoisted out of the old
    // whole-document fallback because the single-share-block branch below needs
    // the same list.
    const STOPS = ['\u0786\u07AE\u0789\u07AC\u0782\u07B0\u0793\u07B0','\u0787\u07AC\u0782\u07B0\u0789\u07AC \u078A\u07A6\u0790\u07B0','Terms & Conditions','Copyright'];
    const firstStopAfter = (from) => {
      let cut = html.length;
      for (const s of STOPS) { const i = html.indexOf(s, from); if (i > from && i < cut) cut = i; }
      return cut;
    };

    /* Paragraph scraping.
     * `<p[^>]*>` also matches <path>, <picture>, <pre>, <param>. An inline SVG icon
     * before the first real </p> opens a "paragraph" that never closes until the
     * next </p>, swallowing everything between \u2014 on newscast.mv that dragged the
     * whole category nav in as paragraph one. The lookahead pins the tag name to
     * exactly "p".
     * Dedupe because newer Fanvaiy repeats the standfirst verbatim as the first
     * body paragraph, which would otherwise be fed to the caption model twice. */
    const paragraphs = (src, min) => {
      const out = [], seen = new Set();
      const re = /<p(?=[\s>])[^>]*>([\s\S]*?)<\/p\s*>/gi;
      let m;
      while ((m = re.exec(src)) !== null) {
        const c = ent(m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
        if (c.length > min && hasScript(c) && !seen.has(c)) { seen.add(c); out.push(c); }
      }
      return out.join('\n\n');
    };

    // og:image — then upgrade to original full-res version
    let image = '';
    const ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogImg) image = ent(ogImg[1]);

    // Fanvaiy CDN pattern: ogimage_TIMESTAMP_ID.webp → original_ID.webp (full res)
    // Also handles: large_thumb_ID.webp → original_ID.webp
    let fullResImage = '';
    if (image) {
      // Try to find the original image directly in the article HTML
      const origMatch = html.match(/src=["'](https?:\/\/[^"']*?\/images\/original_[^"']+)["']/i);
      if (origMatch) {
        fullResImage = ent(origMatch[1]);
      } else {
        // Derive from og:image URL: ogimage_TIMESTAMP_ID.ext → original_ID.ext
        const ogPattern = image.match(/(.*\/images\/)(?:ogimage_\d+_|large_thumb_)(\d+\.\w+)/);
        if (ogPattern) {
          fullResImage = ogPattern[1] + 'original_' + ogPattern[2];
        }
      }
    }

    // Headline, in the masthead's own script
    let title = '';
    // Quote-tolerant: Fanvaiy leaves headline quotes unescaped inside title="\u2026"
    const shareTitle = firstAttrValue(html, 'title', hasScript);
    if (shareTitle) title = ent(shareTitle).trim();
    // h1/h2 BEFORE og:description. Newer Fanvaiy (newscast.mv, /story/<uuid>) emits
    // no Thaana share-link title, a Romanized og:title, and an og:description that is
    // a summary truncated mid-word. The h1 is the only place the real headline lives.
    // Reading description first silently produced a cut-off summary on the card with
    // no error \u2014 the tell is a headline ending on a connective like \u0787\u07A6\u078B\u07A8 or a part word.
    // Safe for dhuvas/voice: their share-link title matches first, so this never runs.
    if (!title) {
      // Scan all h1/h2 rather than taking the first, and tolerate nested tags \u2014
      // the old [^<]* pattern failed on any <h1><span>\u2026</span></h1>.
      for (const hm of html.matchAll(/<h([12])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
        const t = ent(hm[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim();
        if (hasScript(t) && t.length > 10 && t.length < 300) { title = t; break; }
      }
    }
    if (!title) {
      const ogDesc = metaContent(html, 'og:description');
      if (ogDesc) { const d = ent(ogDesc).trim(); if (hasScript(d)) { const s = d.split(/[.\u060C]/)[0].trim(); title = (s.length > 10 && s.length < 200) ? s : d.substring(0, 150); } }
    }
    // 'Maldives Voice' must precede 'Voice' in the alternation \u2014 regex alternation
    // is first-match-wins, so the shorter one would strip only half the suffix and
    // leave "MMA Governor \u2026 - Maldives" on the card.
    if (!title) { const o = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i); if (o) title = ent(o[1]).replace(/\s*[-|]\s*(Maldives Voice|Dhuvas|Voice|Newscast).*$/i, '').trim(); }

    // Article body (zone between share-link blocks)
    const waPos = []; let sf = 0;
    while (true) { const i = html.indexOf('wa.me/', sf); if (i === -1) break; waPos.push(i); sf = i + 6; }
    let text = '';
    if (waPos.length >= 2) {
      let zs = waPos[0]; const ae = html.indexOf('</ul>', zs);
      if (ae > 0 && ae < waPos[1]) zs = ae + 5; else zs += 50;
      let ze = waPos[1]; const bs2 = html.lastIndexOf('<ul', ze);
      if (bs2 > zs) ze = bs2;
      const zone = html.substring(zs, ze);
      text = paragraphs(zone, 20);
    } else if (waPos.length === 1) {
      /* maldivesvoice.mv renders the share row ABOVE the article only, so the
       * two-marker zone never forms and this used to drop straight through to the
       * whole-document scan below \u2014 which starts at byte 0 and therefore reads the
       * header and nav before it reads the story. One marker still tells us where
       * the body begins; the boilerplate markers tell us where it ends.
       * Unreachable for the three Dhivehi mastheads, which emit two. */
      let zs = waPos[0]; const ae = html.indexOf('</ul>', zs);
      zs = (ae > 0 && ae - zs < 4000) ? ae + 5 : zs + 50;
      text = paragraphs(html.substring(zs, firstStopAfter(zs)), 20);
    }
    if (!text || text.length < 50) {
      let js2 = html.length; STOPS.forEach(s => { const i = html.indexOf(s); if (i > 0 && i < js2) js2 = i; });
      text = paragraphs(html.substring(0, js2), 30);
    }
    // Silent-empty is this route's house failure mode \u2014 it answers ok:true with an
    // empty body and the SPA shows nothing filled in. Say so in the log at least.
    if (!text) console.warn('[fetch-article] no body extracted:', urlBrand, lang, url);

    // Proxy image as base64 — try full-res original first, fall back to og:image
    let imageDataUrl = '';
    const imagesToTry = [fullResImage, image].filter(Boolean);
    for (const imgUrl of imagesToTry) {
      try {
        const ir = await localFetcher.mastheadFetch(imgUrl, 15000, { Accept: 'image/*' });
        if (ir.ok) {
          const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
          const buf = Buffer.from(await ir.arrayBuffer());
          console.log('[fetch-article] Image fetched:', imgUrl.split('/').pop(), buf.length, 'bytes');
          imageDataUrl = 'data:' + ct + ';base64,' + buf.toString('base64');
          break; // got it, stop trying
        }
      } catch {}
    }

    // section picks the Voice Sports card in the studio; null when the page doesn't say.
    res.json({ ok: true, title, text: text.substring(0, 8000), image: imageDataUrl, section: parseSection(html) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch article: ' + (err.message || err) });
  }
});

/* ─── Image proxy (for queue articles with CDN URLs) ─── */
router.post('/api/proxy-image', async (req, res) => {
  try {
    const url = (req.body.url || '').trim();
    if (!url) return res.status(400).json({ error: 'No URL' });
    const ir = await fetch(url, { ...articleFetchOpts(15000, { Accept: 'image/*' }), redirect: 'follow' });
    if (!ir.ok) return res.json({ image: '' });
    const ct = (ir.headers.get('content-type') || 'image/jpeg').split(';')[0];
    const buf = Buffer.from(await ir.arrayBuffer());
    res.json({ image: 'data:' + ct + ';base64,' + buf.toString('base64') });
  } catch { res.json({ image: '' }); }
});

/* ─── SPA fallback ─── */
// req.path is mount-relative inside a Router (VxD mounts this at /cs; Reyva
// at the root, where /api is simply /api). A missing asset must 404 rather than fall through: without the
// extension test a typo'd font path returns 200 with the whole SPA in the body,
// the browser reports nothing, and the only symptom is Thaana in the wrong
// typeface. That is exactly how it was found during the last merge.
router.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  if (path.extname(req.path)) return res.status(404).send('Not found');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ─── Error handler ─── */
// asyncRouter forwards a rejected promise to next(err); without a handler here
// that lands on Express 4's default one, which answers an XHR with an HTML stack
// trace and a 500 — the SPA then fails on `Unexpected token <` and reports
// nothing useful. Several handlers reach out over the network with 15–60s
// AbortSignal timeouts, so this is a routine path, not a theoretical one.
router.use((err, req, res, next) => {
  console.error('[cs]', req.method, req.originalUrl, '→', err?.stack || err?.message || err);
  if (res.headersSent) { try { res.end(); } catch { /* socket already gone */ } return; }
  res.status(500).json({ error: err?.message || 'Server error' });
});

/* ─── Schema + boot checks ─── */
async function init() {
  await db.init();

  if (!process.env.CS_ANTHROPIC_API_KEY) {
    console.warn('cs: WARNING — CS_ANTHROPIC_API_KEY unset. Card and reel generation and captions will fail with 500.');
  }
  // Unset, SECRET is randomBytes() per boot, which silently invalidates every
  // Settings lock-code cookie on every deploy. Cheap to set, invisible to debug.
  if (!process.env.COOKIE_SECRET) {
    console.warn('cs: WARNING — COOKIE_SECRET unset. The Settings lock-code cookie will not survive a deploy.');
  }

  const targets = shareTargets.summary();
  const line = Object.entries(targets)
    .map(([brand, t]) => `${brand}[${['telegram', 'x', 'viber'].filter(k => t[k]).join(',') || 'none'}]`)
    .join(' ');
  console.log('cs: share destinations —', line);
}

/* ─── Jobs ─── */
// Only one job left: claiming the Telegram webhook. The dhuvas.mv poller that
// used to run here was removed — the webhook is the real feed and the poll was
// both redundant and the heaviest thing this app did to the mastheads.
function startJobs() {
  // Deliberately opt-in. The old cs.vxd.news service uses the same bot, and
  // setWebhook is last-writer-wins: with both running, whichever container
  // restarted most recently owns the queue. Flip this only at cutover, after the
  // old service is stopped.
  if (process.env.CS_SET_WEBHOOK !== '1') {
    console.log('cs: Telegram webhook registration disabled (set CS_SET_WEBHOOK=1 at cutover)');
    return;
  }
  const base = (process.env.CS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) {
    console.warn('cs: CS_SET_WEBHOOK=1 but CS_BASE_URL is unset — webhook NOT registered');
    return;
  }
  telegramRoutes.setupWebhook(base);
}

module.exports = { router, init, startJobs };
