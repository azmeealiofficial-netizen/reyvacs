/* routes/viber.js — post cards to a Viber Channel
 *
 * Viber's Channels Post API differs from the Telegram bot API in three ways that
 * each cost you an hour if you assume otherwise:
 *
 *  1. auth_token goes in the JSON BODY, not in a header. The Viber *bot* API uses
 *     an X-Viber-Auth-Token header; this one does not.
 *  2. Images cannot be uploaded. `media` must be a public URL that Viber fetches
 *     itself, it must be JPEG, the URL must end in `.jpeg`, and it is capped at
 *     1MB. Hence the /media round-trip through Postgres.
 *  3. A webhook must be set on the Channel before it will accept posts at all —
 *     even though, per Viber's own docs, posting never triggers a callback. The
 *     /webhook handler below exists purely to answer 200.
 *
 * Failure is reported in the BODY as { status: <non-zero> }, with HTTP 200. Reading
 * only r.ok here would swallow every error — the same trap as reading content[0]
 * from the Anthropic SDK.
 */

const express = require('express');
const crypto = require('crypto');
const router = require('../../lib/async-router')();
const db = require('../db');
const { viberTarget } = require('../lib/share-targets');

const VIBER_POST = 'https://chatapi.viber.com/pa/post';
const VIBER_ACCOUNT = 'https://chatapi.viber.com/pa/get_account_info';
const VIBER_WEBHOOK = 'https://chatapi.viber.com/pa/set_webhook';

// Must include the mount prefix — https://sa.vxd.news/cs — because the media
// URL below is built from it and Viber fetches that URL literally.
const BASE_URL = (process.env.CS_BASE_URL || '').replace(/\/+$/, '');

/* Viber requires a webhook to exist. It never calls it for posts, so this just
 * needs to answer 200 for set_webhook's availability probe to pass. */
router.get('/webhook', (req, res) => res.sendStatus(200));
router.post('/webhook', (req, res) => res.sendStatus(200));

/* One-time setup helper: point a Channel's webhook at this server.
 * POST { brand } — uses the token already in the env for that brand. */
router.post('/set-webhook', async (req, res) => {
  try {
    const { brand } = req.body;
    const target = viberTarget(brand);
    if (!target.token) return res.status(400).json({ error: `No VIBER_TOKEN_${String(brand).toUpperCase()} set` });
    if (!BASE_URL) return res.status(400).json({ error: 'CS_BASE_URL not configured' });

    const r = await fetch(VIBER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: `${BASE_URL}/api/viber/webhook`, auth_token: target.token }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json();
    if (data.status !== 0) {
      console.error('[viber] set_webhook failed:', data);
      return res.status(500).json({ error: data.status_message || 'set_webhook failed', status: data.status });
    }
    res.json({ ok: true, webhook: `${BASE_URL}/api/viber/webhook` });
  } catch (e) {
    console.error('[viber] set-webhook error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Look up the Channel's super admin id — the only valid `from` value.
 * Saves hand-copying it; the result goes into VIBER_SENDER_<BRAND>. */
router.post('/account-info', async (req, res) => {
  try {
    const { brand } = req.body;
    const target = viberTarget(brand);
    if (!target.token) return res.status(400).json({ error: `No VIBER_TOKEN_${String(brand).toUpperCase()} set` });

    const r = await fetch(VIBER_ACCOUNT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auth_token: target.token }),
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json();
    if (data.status !== 0) return res.status(500).json({ error: data.status_message || 'get_account_info failed', status: data.status });

    const members = data.members || [];
    const supers = members.filter(m => String(m.role || '').toLowerCase() === 'superadmin');
    res.json({
      ok: true,
      channel: data.chat_hostname || data.name || '',
      superadmins: supers.map(m => ({ id: m.id, name: m.name })),
      allMembers: members.map(m => ({ id: m.id, name: m.name, role: m.role })),
      note: supers.length ? 'Use a superadmin id as VIBER_SENDER_<BRAND>'
                          : 'No superadmin found — only a superadmin id is accepted as sender'
    });
  } catch (e) {
    console.error('[viber] account-info error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/* Post a card to the brand's Channel. */
router.post('/share', async (req, res) => {
  try {
    const { caption, articleUrl, imageBase64, brand } = req.body;
    if (!brand) return res.status(400).json({ error: 'Missing brand' });

    const target = viberTarget(brand);
    if (!target.token)  return res.status(400).json({ error: `Viber token not configured for ${brand}` });
    if (!target.sender) return res.status(400).json({ error: `Viber sender id not configured for ${brand}` });
    if (!caption && !articleUrl && !imageBase64) return res.status(400).json({ error: 'Nothing to share' });

    let text = caption || '';
    if (articleUrl) {
      const fullUrl = articleUrl.startsWith('http') ? articleUrl : 'https://' + articleUrl;
      text = text ? text + '\n\n' + fullUrl : fullUrl;
    }

    let payload;

    if (imageBase64) {
      if (!BASE_URL) return res.status(400).json({ error: 'CS_BASE_URL must be set so Viber can fetch the image' });
      if (!/^data:image\/jpe?g;base64,/i.test(imageBase64)) {
        // Viber accepts JPEG only and matches on the URL extension, so a PNG would
        // be rejected after we had already stored it.
        return res.status(400).json({ error: 'Viber requires JPEG. Export the card as JPEG before sharing.' });
      }
      const buffer = Buffer.from(imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
      if (buffer.length > 1024 * 1024) {
        return res.status(400).json({ error: `Image is ${(buffer.length / 1024 / 1024).toFixed(2)}MB — Viber's limit is 1MB. Lower the export resolution.` });
      }

      const id = crypto.randomUUID();
      await db.putMedia(id, 'image/jpeg', buffer);
      db.purgeMedia(60);                       // opportunistic, not awaited
      const mediaUrl = `${BASE_URL}/media/${id}.jpeg`;

      // Caption rides along on the picture message; Viber caps it at 768 chars.
      payload = {
        auth_token: target.token,
        from: target.sender,
        type: 'picture',
        text: text.slice(0, 768),
        media: mediaUrl
      };
      console.log(`[viber] Posting picture (${(buffer.length / 1024).toFixed(0)} KB) to ${brand} channel via ${mediaUrl}`);
    } else {
      payload = { auth_token: target.token, from: target.sender, type: 'text', text: text.slice(0, 7000) };
      console.log(`[viber] Posting text to ${brand} channel`);
    }

    const r = await fetch(VIBER_POST, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000)
    });
    const data = await r.json();

    // Viber answers HTTP 200 even on failure; the real result is data.status.
    if (data.status !== 0) {
      console.error('[viber] Post failed:', data);
      const hint = data.status === 10 ? ' — run /api/viber/set-webhook for this brand first'
                 : data.status === 2  ? ' — token invalid or not a Channel token'
                 : data.status === 12 ? ' — rate limited, try again shortly' : '';
      return res.status(500).json({ error: (data.status_message || 'Viber error') + hint, status: data.status });
    }

    console.log(`[viber] Posted to ${brand} channel: ${text.substring(0, 60)}...`);
    res.json({ ok: true, message_token: data.message_token });
  } catch (e) {
    console.error('[viber] Share error:', e.message);
    res.status(500).json({ error: 'Viber post failed: ' + e.message });
  }
});

module.exports = router;
