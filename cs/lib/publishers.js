/* cs/lib/publishers.js — post a finished card to a brand's channels, server-side
 *
 * The Newscast relay shares straight from its Telegram group (📣 Share), with no
 * browser in the loop, so it needs the four senders as plain functions:
 *
 *   postFacebook / postTelegram / postViber / postX
 *     ({ brand, caption, url, jpeg: Buffer }) → { ok: true, … }   or throws
 *
 * Every sender resolves its destination through lib/share-targets.js, the same
 * per-brand variables the Creative Studio buttons use, so a channel is either
 * set up for both paths or for neither. The browser routes (routes/telegram.js,
 * viber.js, x.js) keep their own request handling; routes/facebook.js is a thin
 * wrapper over postFacebook here.
 *
 * The API quirks, each learned the hard way (see the route files):
 *   • Facebook — Graph errors carry { error:{code} }; commenting as the Page is
 *     a separate permission (pages_manage_engagement) from posting.
 *   • Viber — no uploads: `media` is a public URL ending .jpeg, JPEG only, ≤1MB,
 *     served from cs_media; failures arrive as HTTP 200 with status ≠ 0.
 *   • X — via IFTTT; the key IS the account, so no cross-brand fallback.
 *     IFTTT answers 200 even with no credits left, so the monthly allowance
 *     is counted here (lib/x-budget.js). Once it is spent postX throws an
 *     error with .manual and .intentUrl — tap-to-post — and sends nothing.
 */

const crypto = require('crypto');
const db = require('../db');
const { facebookTarget, telegramTarget, viberTarget, xTarget } = require('./share-targets');
const xBudget = require('./x-budget');

const fullUrl = u => (!u ? '' : (String(u).startsWith('http') ? String(u) : 'https://' + u));
const fail = (msg, status) => { const e = new Error(msg); e.status = status || 502; return e; };

// ─── Facebook ────────────────────────────────────────────────────────────────
const GRAPH = () => `https://graph.facebook.com/${(process.env.FB_GRAPH_VERSION || 'v21.0').trim()}`;

async function graph(path, { method = 'GET', token, form, json, needs = 'pages_manage_posts' } = {}) {
  const url = new URL(`${GRAPH()}/${path.replace(/^\//, '')}`);
  let body;
  if (form) { form.append('access_token', token); body = form; }
  else if (json) { body = new URLSearchParams({ ...json, access_token: token }); }
  else url.searchParams.set('access_token', token);
  const r = await fetch(url, { method, body, signal: AbortSignal.timeout(60000) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = data.error || {};
    const hint = e.code === 190 ? ' — token expired or revoked; generate a new Page token'
               : e.code === 200 || e.code === 10 ? ` — the Page token lacks ${needs} (or is a user token, not a Page token)`
               : e.code === 368 ? ' — Facebook temporarily blocked posting (spam limit)' : '';
    throw fail((e.message || `Graph HTTP ${r.status}`) + hint);
  }
  return data;
}

async function checkFacebook(brand) {
  const t = facebookTarget(brand);
  if (!t.ready) throw fail(`FB_PAGE_ID_${String(brand).toUpperCase()} / FB_PAGE_TOKEN_${String(brand).toUpperCase()} not set`, 400);
  const page = await graph(t.pageId, { token: t.token });
  return { ok: true, page: { id: page.id, name: page.name }, linkIn: t.linkIn };
}

/** Photo post; link as the first comment or in the caption, per FB_LINK_IN_<BRAND>.
 *  image: Buffer, mime: 'image/jpeg' | 'image/png'. A failed link comment does
 *  not fail the post — it comes back as commentError. */
async function postFacebook({ brand, caption, url, image, mime = 'image/jpeg' }) {
  const t = facebookTarget(brand);
  if (!t.ready) throw fail(`Facebook Page not configured for ${brand}`, 400);
  if (!image) throw fail('No card image', 400);
  if (image.length > 10 * 1024 * 1024) throw fail('Card image over 10MB', 400);
  const link = fullUrl(url);
  const message = (t.linkIn === 'caption' && link) ? `${caption || ''}\n\n${link}`.trim() : (caption || '');

  const fd = new FormData();
  fd.append('message', message);
  fd.append('published', 'true');
  fd.append('source', new Blob([image], { type: mime }), `card.${/png/i.test(mime) ? 'png' : 'jpg'}`);
  const photo = await graph(`${t.pageId}/photos`, { method: 'POST', token: t.token, form: fd });
  const postId = photo.post_id || photo.id;
  console.log(`[facebook] ${brand}: posted ${postId} (${(image.length / 1024).toFixed(0)} KB)`);

  let commentId = null, commentError = null;
  if (t.linkIn === 'comment' && !link) {
    // Say so: a silent success here reads as "the comment is still coming".
    commentError = 'the card has no article link, so no link comment was posted. Load the story from the queue, or fill in its URL.';
  }
  if (t.linkIn === 'comment' && link) {
    try {
      const c = await graph(`${postId}/comments`, { method: 'POST', token: t.token, json: { message: link }, needs: 'pages_manage_engagement' });
      commentId = c.id;
    } catch (e) {
      commentError = 'the link comment failed: ' + e.message;
      console.error(`[facebook] ${brand}: link comment failed:`, e.message);
    }
  }
  return { ok: true, postId, commentId, commentError, linkIn: t.linkIn, link, url: `https://www.facebook.com/${postId}` };
}

// ─── Telegram channel ────────────────────────────────────────────────────────
async function postTelegram({ brand, caption, url, image }) {
  const t = telegramTarget(brand);
  if (!t.token) throw fail('No Telegram bot token configured', 400);
  if (!t.channel) throw fail(`Telegram channel not configured for ${brand}`, 400);
  const link = fullUrl(url);
  const text = [caption || '', link].filter(Boolean).join('\n\n').slice(0, 1024);
  const fd = new FormData();
  fd.append('chat_id', t.channel);
  fd.append('caption', text);
  fd.append('photo', new Blob([image], { type: 'image/jpeg' }), 'card.jpg');
  const r = await fetch(`https://api.telegram.org/bot${t.token}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw fail('Telegram: ' + (j.description || `HTTP ${r.status}`));
  return { ok: true, messageId: j.result?.message_id };
}

// ─── Viber channel ───────────────────────────────────────────────────────────
async function postViber({ brand, caption, url, image }) {
  const t = viberTarget(brand);
  if (!t.token) throw fail(`Viber token not configured for ${brand}`, 400);
  if (!t.sender) throw fail(`Viber sender id not configured for ${brand}`, 400);
  const base = (process.env.CS_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw fail('CS_BASE_URL must be set so Viber can fetch the image', 400);
  if (image.length > 1024 * 1024) throw fail('Card JPEG is over Viber\'s 1MB limit', 400);

  const id = crypto.randomUUID();
  await db.putMedia(id, 'image/jpeg', image);
  db.purgeMedia(60);
  const link = fullUrl(url);
  const text = [caption || '', link].filter(Boolean).join('\n\n');
  const r = await fetch('https://chatapi.viber.com/pa/post', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ auth_token: t.token, from: t.sender, type: 'picture', text: text.slice(0, 768), media: `${base}/media/${id}.jpeg` }),
    signal: AbortSignal.timeout(30000)
  });
  const data = await r.json().catch(() => ({}));
  if (data.status !== 0) {
    const hint = data.status === 10 ? ' — run /cs/api/viber/set-webhook for this brand first'
               : data.status === 2 ? ' — token invalid or not a Channel token'
               : data.status === 12 ? ' — rate limited, try again shortly' : '';
    throw fail('Viber: ' + (data.status_message || 'error') + hint);
  }
  return { ok: true, messageToken: data.message_token };
}

// ─── X (via IFTTT) ───────────────────────────────────────────────────────────
async function postX({ brand, caption, url }) {
  const t = xTarget(brand);
  if (!t.key) throw fail(`X/IFTTT not configured for ${brand}`, 400);
  const link = fullUrl(url);
  const text = caption ? caption + (link ? '\n\n' + link : '') : link;
  if (!text) throw fail('Nothing to post', 400);
  const s = await xBudget.status(brand);
  if (!s.auto) {
    const e = fail(`X auto-posting is paused for ${brand} until ${new Date(s.resets).toISOString().slice(0, 10)} — post it by hand`, 409);
    e.manual = true;
    e.intentUrl = xBudget.intent({ caption, url });
    throw e;
  }
  const r = await fetch(`https://maker.ifttt.com/trigger/${t.event}/with/key/${t.key}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value1: text }), signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw fail('IFTTT: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  await xBudget.record(brand);
  // "Handed to IFTTT", never "tweeted": IFTTT says 200 whatever happens next.
  console.log(`[x] ${brand}: handed to IFTTT` + (s.unlimited || s.used == null ? '' : ` — ${s.used + 1} of ${s.budget} this month`));
  return { ok: true };
}

const CHANNELS = {
  facebook: { label: 'Facebook', icon: '📘', post: postFacebook, ready: b => facebookTarget(b).ready },
  telegram: { label: 'Telegram', icon: '📢', post: postTelegram, ready: b => telegramTarget(b).ready },
  x:        { label: 'X',        icon: '🐦', post: postX,        ready: b => xTarget(b).ready },
  viber:    { label: 'Viber',    icon: '🟣', post: postViber,    ready: b => viberTarget(b).ready },
};

module.exports = { postFacebook, postTelegram, postViber, postX, checkFacebook, CHANNELS };
