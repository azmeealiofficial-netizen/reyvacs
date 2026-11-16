/* routes/telegram.js — Telegram bot: webhook + channel posting.
 *
 * There used to be a dhuvas.mv poller here that fetched the homepage every 60
 * seconds looking for new article ids. It is gone: the webhook is the actual
 * feed, the poller only duplicated it for one of the three mastheads, and the
 * super app already reaches those domains on four other schedules from this
 * one address. Adding a fifth was volume spent to learn nothing. */
const express = require('express');
const router = require('../../lib/async-router')();
const db = require('../db');

// CS_-prefixed throughout. Creative Studio's bot (8988730556) is not the super
// app's bot (8486349896), and the unprefixed TELEGRAM_BOT_TOKEN is what the
// host app falls back to when its database row is missing.
const BOT_TOKEN = process.env.CS_TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.CS_TELEGRAM_CHANNEL_ID || ''; // dhuvas legacy; webhook only

// Telegram echoes this back in the X-Telegram-Bot-Api-Secret-Token header on
// every webhook delivery. The webhook cannot sit behind the session gate —
// Telegram has no session — so without this, anything on the internet can POST
// fabricated articles straight into the queue.
const WEBHOOK_SECRET = (process.env.CS_WEBHOOK_SECRET || '').trim();
const { telegramTarget } = require('../lib/share-targets');

// ─── Shared helpers ──────────────────────────────────────────────────────────
/* Single source of truth for the supported outlets — now in lib/share-targets.js,
 * so index.js's URL gate and this module's brand detector cannot drift apart. */
const { BRAND_SITES } = require('../lib/share-targets');
const SITE_ALT = Object.values(BRAND_SITES).map(s => s.replace(/\./g, '\\.')).join('|');

function extractArticleUrl(text) {
  if (!text) return null;
  // Reyva links are /article/<id> or /news/<id>; VxD's were bare /<id>.
  const m = text.match(new RegExp('https?://(www\\.)?(' + SITE_ALT + ')/(?:(?:article|news)/)?\\d+', 'i'));
  return m ? m[0] : null;
}

function detectBrand(url) {
  const host = ((String(url || '').match(/^https?:\/\/(?:www\.)?([^/?#]+)/i)) || [])[1] || '';
  const h = host.toLowerCase();
  return Object.keys(BRAND_SITES).find(k => h === BRAND_SITES[k] || h.endsWith('.' + BRAND_SITES[k])) || 'unknown';
}

function extractArticleId(url) {
  const m = url.match(/\/([\d]+)\/?$/);
  return m ? m[1] : null;
}

// Article extraction moved to lib/fanvaiy-article.js so the Newscast relay
// reads pages exactly the way this webhook does.
const { fetchArticle } = require('../../lib/reyva-article');   // VxD: fanvaiy-article

// ─── Webhook handler (still works — channel posts also feed queue) ─────────
router.post('/webhook', async (req, res) => {
  if (WEBHOOK_SECRET && req.get('x-telegram-bot-api-secret-token') !== WEBHOOK_SECRET) {
    console.warn('[telegram] webhook rejected: bad or missing secret token');
    return res.sendStatus(401);
  }
  res.json({ ok: true });
  try {
    const msg = req.body.message || req.body.channel_post;
    if (!msg) return;
    const text = msg.text || msg.caption || '';
    const url = extractArticleUrl(text);
    if (!url) return;
    const brand = detectBrand(url);
    const msgId = String(msg.message_id);
    console.log(`[telegram] Webhook article detected: ${url} (${brand})`);
    const article = await fetchArticle(url);
    if (!article) { console.log('[telegram] Could not fetch article'); return; }
    const id = await db.addArticle(url, brand, article.title, article.text, article.imageUrl, msgId, article.section);
    if (id) console.log(`[telegram] Article saved: #${id} — ${article.title}`);
    else console.log('[telegram] Article already exists, skipping');
  } catch (e) { console.error('[telegram] Webhook error:', e.message); }
});

// ─── Post to Telegram channel (image + caption + link) ─────────────────────
router.post('/share', async (req, res) => {
  try {
    const { caption, articleUrl, imageBase64, brand } = req.body;
    // Destination is resolved per brand. No brand means no destination — never fall
    // back to the dhuvas channel, or a VOICE card lands in @dhuvas looking official.
    if (!brand) return res.status(400).json({ error: 'Missing brand' });
    const target = telegramTarget(brand);
    if (!target.token) return res.status(400).json({ error: 'No Telegram bot token configured' });
    if (!target.channel) return res.status(400).json({ error: `Telegram channel not configured for ${brand}` });
    if (!caption && !articleUrl) return res.status(400).json({ error: 'Nothing to share' });

    // Build the message text: caption + article link
    let text = caption || '';
    if (articleUrl) {
      const fullUrl = articleUrl.startsWith('http') ? articleUrl : 'https://' + articleUrl;
      text = text ? text + '\n\n' + fullUrl : fullUrl;
    }

    let result;

    if (imageBase64) {
      // Convert base64 data URL to buffer
      const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');
      console.log(`[telegram] Sharing image (${(buffer.length / 1024).toFixed(0)} KB) to ${target.channel} [${brand}]`);

      // Telegram has 10MB photo limit — check size
      if (buffer.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image too large (>10MB). Try lower export resolution.' });
      }

      // Use multipart form to send photo — 60s timeout for large images
      const fd = new FormData();
      fd.append('chat_id', target.channel);
      fd.append('caption', text);
      fd.append('parse_mode', 'HTML');
      const isJpeg = imageBase64.startsWith('data:image/jpeg');
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png';
      const ext = isJpeg ? 'jpg' : 'png';
      const blob = new Blob([buffer], { type: mimeType });
      fd.append('photo', blob, `post.${ext}`);

      const r = await fetch(`https://api.telegram.org/bot${target.token}/sendPhoto`, {
        method: 'POST',
        body: fd,
        signal: AbortSignal.timeout(60000)
      });
      result = await r.json();
    } else {
      // Text-only post
      const r = await fetch(`https://api.telegram.org/bot${target.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: target.channel, text, parse_mode: 'HTML' }),
        signal: AbortSignal.timeout(15000)
      });
      result = await r.json();
    }

    if (!result.ok) {
      console.error('[telegram] Share failed:', result.description);
      return res.status(500).json({ error: result.description || 'Telegram API error' });
    }

    console.log(`[telegram] Shared to ${target.channel} [${brand}]: ${text.substring(0, 60)}...`);
    res.json({ ok: true, message_id: result.result?.message_id });

  } catch (err) {
    console.error('[telegram] Share error:', err.message);
    res.status(500).json({ error: 'Share failed: ' + err.message });
  }
});

// Setup webhook URL
async function setupWebhook(baseUrl) {
  if (!BOT_TOKEN) { console.log('[telegram] No CS_TELEGRAM_BOT_TOKEN, bot disabled'); return; }
  const webhookUrl = `${baseUrl}/api/telegram/webhook`;
  try {
    if (!WEBHOOK_SECRET) console.warn('[telegram] CS_WEBHOOK_SECRET unset — the webhook will accept unauthenticated POSTs');
    const body = { url: webhookUrl, allowed_updates: ['message', 'channel_post'] };
    if (WEBHOOK_SECRET) body.secret_token = WEBHOOK_SECRET;
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    console.log('[telegram] Webhook set:', data.ok ? webhookUrl : data.description);
  } catch (e) { console.error('[telegram] Webhook setup failed:', e.message); }
}

router.setupWebhook = setupWebhook;
module.exports = router;
