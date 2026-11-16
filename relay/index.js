// ─────────────────────────────────────────────────────────────────────────────
// relay/index.js — Reyva's Telegram share desk, at /relay
// ─────────────────────────────────────────────────────────────────────────────
// REYVA FORK of VxD Super App's relay/index.js, keeping only its share-group
// flow (VxD: "Share-only groups: Dhuvas and Voice"). No Newscast rewrite, no
// newsroom desk — Azmee, 2026-11-16: "writing part no need".
//
//   new story on reyvaonline.com           (watcher.js, every few minutes)
//         ▼
//   Reyva Desk group: share card
//   [ the studio's red news card, drawn on the server — card.js ]
//   🔴 REYVA · 📣 Share · #id
//   AI caption (Creative Studio's generator) + link
//   ☑ 📘 Facebook  ☑ 📢 Telegram  ☑ 🐦 X  ☑ 🟣 Viber
//   🔁 New caption   ✏️ Edit caption   📣 Share (n)
//
// Buttons and caption editing are VxD's share.js, unchanged. In the group:
// /pull <link>, /share <id>, /status, /id; reply to a card to replace its
// caption. Posting from Creative Studio ticks the matching card (cs/index.js).
//
// Off unless RELAY_ENABLED=1. Variables: see README.md (Telegram desk).
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cron = require('node-cron');
const db = require('./db');
const tg = require('./telegram');
const watcher = require('./watcher');
const share = require('./share');

const env = k => (process.env[k] || '').trim();
const enabled = () => env('RELAY_ENABLED') === '1';
const idList = k => env(k).split(/[\s,]+/).filter(Boolean);
const BRAND = 'reyva';
const groupId = () => tg.shareChatId(BRAND);           // RELAY_SHARE_CHAT_REYVA

const router = express.Router();

const nameOf = u => [u?.first_name, u?.last_name].filter(Boolean).join(' ') || u?.username || String(u?.id || 'someone');
const errText = e => tg.esc(String(e?.message || e).slice(0, 300));

/** Is this the Reyva desk group, and may this person act there? */
function allowed(from, chat) {
  const id = String(chat?.id ?? '');
  if (!id || !groupId() || id !== groupId()) return false;
  let list = idList('RELAY_SHARE_APPROVERS_REYVA');
  if (!list.length) list = idList('RELAY_APPROVER_IDS');
  return list.length === 0 || list.includes(String(from?.id));
}

// ─── button taps ─────────────────────────────────────────────────────────────
async function onCallback(cb) {
  const m = /^rl:(t|sh|nc|ec|mp|xd):(\d+)(?::([a-z]+))?$/.exec(cb.data || '');
  if (!m) return tg.answer(cb.id);
  if (!allowed(cb.from, cb.message?.chat)) return tg.answer(cb.id, 'You are not an approver in this group.', true);
  const [, action, idStr, arg] = m;
  const id = Number(idStr);
  const who = nameOf(cb.from);

  const item = await db.get(id);
  if (!share.isLive(item) || share.chatOf(item) !== String(cb.message.chat.id)) {
    return tg.answer(cb.id, 'This share card is no longer active.', true);
  }
  if (action === 't') { const r = await share.toggle(item, arg); return tg.answer(cb.id, r.answer); }
  if (action === 'nc') { await tg.answer(cb.id, 'Writing a new caption…'); return share.newCaption(item); }
  if (action === 'ec') { await tg.answer(cb.id, 'Reply to the message below'); return share.askCaptionEdit(item, cb.from); }
  if (action === 'mp') { const r = await share.markPosted(item, who, arg); return tg.answer(cb.id, r.answer); }
  if (action === 'xd') { const r = await share.xPosted(item, who); return tg.answer(cb.id, r.answer); }
  await tg.answer(cb.id, 'Sharing…');
  const r = await share.share(item, who);
  if (r && r.answer && !r.notified) await tg.say(tg.esc(r.answer), item.share_msg_id, share.chatOf(item));
}

// ─── ✏️ Edit caption: "old → new" lines patch it, anything else replaces it ──
const FIX_LINE = /^(.+?)\s*(?:→|←|=>|->|<-|\|)\s*(.+)$/;
function parseFixes(text) {
  const lines = String(text).split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return null;
  const pairs = lines.map(l => FIX_LINE.exec(l));
  return pairs.every(Boolean) ? pairs.map(m => [m[1].trim(), m[2].trim()]) : null;
}
function applyFixes(text, fixes) {
  let out = text, count = 0;
  const missed = fixes.filter(([a]) => !out.includes(a)).map(([a]) => a);
  if (missed.length) return { missed };
  for (const [a, b] of fixes) { count += out.split(a).length - 1; out = out.split(a).join(b); }
  return { out, count };
}
async function editCaption(id, text, who, msg) {
  const chat = msg.chat.id;
  const item = await db.get(id);
  if (!share.isLive(item) || share.chatOf(item) !== String(chat)) {
    return tg.say(`#${id}'s share card is no longer active — nothing changed.`, msg.message_id, chat);
  }
  const fixes = parseFixes(text);
  if (!fixes) return share.replaceCaption(item, text, who);
  const r = applyFixes(String(item.share_caption || ''), fixes);
  if (r.missed) return tg.say(`⚠️ Not found in the caption: ${r.missed.map(tg.esc).join(', ')}. Nothing changed — tap ✏️ Edit caption to retry.`, msg.message_id, chat);
  return share.replaceCaption(item, r.out, who, `Caption fixed (${r.count} ${r.count === 1 ? 'place' : 'places'}) by`);
}

// ─── messages ────────────────────────────────────────────────────────────────
async function onMessage(msg) {
  const text = String(msg.text || '').trim();
  const chat = msg.chat.id;

  // /id works anywhere, so the group and user ids can be read off during setup.
  if (/^\/id(@\w+)?$/.test(text)) {
    const hint = String(chat) === groupId() ? '' : '\n\n(not set up yet — put this chat id in RELAY_SHARE_CHAT_REYVA)';
    return tg.call('sendMessage', { chat_id: chat, text: `chat id: ${chat}\nyour user id: ${msg.from?.id}${hint}` });
  }
  if (String(chat) !== groupId()) return;
  if (!allowed(msg.from, msg.chat)) {
    if (/^\/\w+/.test(text) && msg.from && !msg.from.is_bot) {
      return tg.say(`🔒 ${tg.esc(nameOf(msg.from))}, you're not on the desk list yet. Ask an admin to add your id <code>${msg.from.id}</code> to RELAY_SHARE_APPROVERS_REYVA.`, msg.message_id, chat);
    }
    return;
  }

  // /pull <link> — a share card for any Reyva story, now.
  const pull = /^\/pull(?:@\w+)?\s+(\S+)/.exec(text);
  if (pull) {
    try {
      const { item, existing } = await watcher.pullUrl(pull[1]);
      if (existing && item.share_msg_id) return tg.say(`Already here as #${item.id}. Send /share ${item.id} for a fresh card.`, item.share_msg_id, chat);
      await share.fromSource(item);
    } catch (e) { await tg.say(`⚠️ ${errText(e)}`, msg.message_id, chat); }
    return;
  }

  // /share <id> — a fresh card with a new caption; channels already posted stay ✅.
  const sh = /^\/share(?:@\w+)?\s+#?(\d+)/.exec(text);
  if (sh) {
    const item = await db.get(Number(sh[1]));
    if (!item || item.mode !== 'share' || item.brand !== BRAND) return tg.say(`#${sh[1]} isn't one of this group's stories.`, msg.message_id, chat);
    try { await share.fromSource(item); } catch (e) { await tg.say(`⚠️ ${errText(e)}`, msg.message_id, chat); }
    return;
  }

  if (/^\/status(@\w+)?$/.test(text)) {
    const s = await db.stats(24, 'share', BRAND);
    const { CHANNELS } = require('../cs/lib/publishers');
    const ch = Object.keys(CHANNELS).map(k => `${CHANNELS[k].ready(BRAND) ? '✅' : '✖️'} ${CHANNELS[k].label}`).join('\n');
    return tg.say(`<b>Share cards, last 24h</b>\ncards: ${s.share || 0}\nnot sent: ${s.new || 0}\n\n<b>Channels</b>\n${ch}`, null, chat);
  }

  const replyTo = msg.reply_to_message?.message_id;
  // A reply to a ✏️ Edit caption prompt.
  if (replyTo && text && msg.reply_to_message?.from?.is_bot) {
    const cid = share.parseCaptionPrompt(msg.reply_to_message.text);
    if (cid) return editCaption(cid, text, nameOf(msg.from), msg);
  }
  // A reply to a share card replaces its caption.
  if (replyTo && text) {
    const item = await db.findByShareMessage(replyTo, chat);
    if (share.isLive(item)) return share.replaceCaption(item, text, nameOf(msg.from));
  }
}

router.post('/telegram/webhook', express.json({ limit: '1mb' }), (req, res) => {
  const secret = env('RELAY_WEBHOOK_SECRET');
  if (!secret || req.get('x-telegram-bot-api-secret-token') !== secret) return res.sendStatus(401);
  res.sendStatus(200);                              // ack first; Telegram retries slow webhooks
  const u = req.body || {};
  const job = u.callback_query ? onCallback(u.callback_query) : u.message ? onMessage(u.message) : null;
  if (job) job.catch(e => console.error('[relay] update failed:', e.message));
});

// ─── housekeeping: cards that didn't reach the group (three tries each) ──────
async function recover() {
  if (!groupId()) return;
  for (const item of await db.unsentShares(3)) {
    if (item.brand !== BRAND) continue;
    try { await share.fromSource(item); } catch (e) { console.warn(`[relay] share card #${item.id} retry:`, e.message); }
  }
}

async function onNewShareStory(item) {
  try { await share.fromSource(item); }
  catch (e) { console.warn(`[relay] share card #${item.id}:`, e.message); }   // recover() retries it
}

async function init() { await db.init(); }

function startJobs() {
  if (!enabled()) { console.log('relay: disabled (set RELAY_ENABLED=1)'); return; }
  const missing = ['RELAY_TELEGRAM_BOT_TOKEN', 'RELAY_WEBHOOK_SECRET'].filter(k => !env(k));
  if (missing.length) { console.warn('relay: NOT started — missing', missing.join(', ')); return; }

  const host = env('RELAY_BASE_URL') || env('CS_BASE_URL');
  if (host) {
    tg.setWebhook(`${host.replace(/\/+$/, '')}/relay/telegram/webhook`, env('RELAY_WEBHOOK_SECRET'))
      .then(() => console.log('relay: webhook set'))
      .catch(e => console.error('relay: webhook failed —', e.message));
  } else {
    console.warn('relay: no RELAY_BASE_URL — the bot cannot receive taps or commands');
  }

  // Setup mode: the bot answers /id so the group id can be read off, but
  // nothing is watched or posted until RELAY_SHARE_CHAT_REYVA says where.
  if (!groupId()) {
    console.log('relay: SETUP MODE — bot online; send /id in the desk group, then set RELAY_SHARE_CHAT_REYVA');
    return;
  }
  const watchers = [{ mode: 'share', onNew: onNewShareStory }];
  const every = Math.min(Math.max(parseInt(env('RELAY_POLL_MINUTES'), 10) || 3, 1), 30);
  const run = label => watcher.tick(watchers)
    .then(r => { if (!/0 new/.test(r)) console.log('[relay]', r); })
    .then(recover)
    .catch(e => console.error(`[relay] ${label}:`, e.message));
  cron.schedule(`*/${every} * * * *`, () => run('tick'), { timezone: 'Indian/Maldives' });
  setTimeout(() => run('first tick'), 15000);
  console.log(`relay: Reyva desk on — checking reyvaonline.com every ${every} min`);
}

module.exports = { router, init, startJobs, recover };
