// REYVA FORK (2026-11-16): from VxD Super App's relay/telegram.js. Only the
// share-group calls are used here; the Newscast draft layouts are inert.
// ─────────────────────────────────────────────────────────────────────────────
// relay/telegram.js — the relay bot's own Telegram calls and message layouts
// ─────────────────────────────────────────────────────────────────────────────
// A dedicated bot (RELAY_TELEGRAM_BOT_TOKEN), not the super app's or Creative
// Studio's. setWebhook is last-writer-wins per bot, and both of those bots
// already own a webhook; sharing one would mean one of them silently stops
// receiving updates on the next deploy.
// ─────────────────────────────────────────────────────────────────────────────

const env = k => (process.env[k] || '').trim();
const token = () => env('RELAY_TELEGRAM_BOT_TOKEN');
const chatId = () => env('RELAY_CHAT_ID');
/** A masthead's share-only group (relay/share.js), e.g. RELAY_SHARE_CHAT_DHUVAS. */
const shareChatId = brand => env('RELAY_SHARE_CHAT_' + String(brand || '').toUpperCase());

// VxD's Newscast sections — the rewrite flow isn't part of Reyva's desk.
const SECTIONS = {}; const chosenSection = () => null;

const BRAND_LABEL = { reyva: '🔴 REYVA', dhuvas: '🟠 DHUVAS', voice: '🔴 VOICE', voice_en: '🔴 MALDIVES VOICE' };

// Telegram limits: 4096 chars per message, 1024 per photo caption.
const MSG_LIMIT = 3900;       // headroom for the header line and HTML entities
const CAPTION_LIMIT = 1000;

const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function call(method, body) {
  const t = token();
  if (!t) throw new Error('RELAY_TELEGRAM_BOT_TOKEN is not set');
  const r = await fetch(`https://api.telegram.org/bot${t}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) {
    // "message is not modified" is Telegram telling us the edit was a no-op —
    // e.g. a double tap re-rendering the same state. Not an error.
    if (/message is not modified/i.test(j.description || '')) return null;
    throw new Error(`Telegram ${method}: ${j.description}`);
  }
  return j.result;
}

const btn = (text, data) => ({ text, callback_data: data });
const kb = rows => ({ inline_keyboard: rows });

// ─── source card ─────────────────────────────────────────────────────────────
function cardText(item, footer) {
  const sec = SECTIONS[item.source_section] ? ` · ${SECTIONS[item.source_section]}` : '';
  const head = `${BRAND_LABEL[item.brand] || item.brand}${sec} · #${item.id}`;
  const title = `<b>${esc(item.source_title)}</b>`;
  const link = esc(item.source_url);
  const tail = footer ? `\n\n${footer}` : '';
  const room = CAPTION_LIMIT - head.length - title.length - link.length - tail.length - 12;
  let lead = String(item.source_text || '').split('\n').find(l => l.trim()) || '';
  if (!lead) lead = '⚠️ ލިޔުމެއް ނުފެނުނު — ޚަބަރުގައި ހުރީ ފޮޓޯ/ވީޑިއޯ އެކަނި ކަމަށް ވެދާނެ';
  if (lead.length > room) lead = lead.slice(0, Math.max(0, room - 1)) + '…';
  return `${head}\n${title}\n\n${esc(lead)}\n\n${link}${tail}`;
}

const cardButtons = id => kb([[btn('✍️ Rewrite for Newscast', `rl:w:${id}`), btn('✖️ Skip', `rl:s:${id}`)]]);

async function sendCard(item) {
  const text = cardText(item);
  const markup = cardButtons(item.id);
  if (item.source_image) {
    try {
      const m = await call('sendPhoto', { chat_id: chatId(), photo: item.source_image, caption: text, parse_mode: 'HTML', reply_markup: markup });
      return { messageId: m.message_id, isPhoto: true };
    } catch (e) {
      // A bad or too-large image URL must not cost us the story — fall back to text.
      console.warn('[relay] sendPhoto failed, sending text card:', e.message);
    }
  }
  // Text card. Let Telegram's link preview show the story's photo from its page
  // — covers the case where sendPhoto rejects the image format (the mastheads
  // serve .webp, which Telegram doesn't always take as a photo by URL).
  const m = await call('sendMessage', {
    chat_id: chatId(), text, parse_mode: 'HTML', reply_markup: markup,
    link_preview_options: { url: item.source_url, prefer_large_media: true, show_above_text: true }
  });
  return { messageId: m.message_id, isPhoto: false };
}

/** Re-render the source card with a status footer and (optionally) new buttons. */
async function updateCard(item, footer, markup) {
  if (!item.card_msg_id) return;
  const text = cardText(item, footer);
  const common = { chat_id: chatId(), message_id: Number(item.card_msg_id), parse_mode: 'HTML', reply_markup: markup || kb([]) };
  try {
    if (item.card_is_photo) await call('editMessageCaption', { ...common, caption: text });
    else await call('editMessageText', { ...common, text, link_preview_options: { url: item.source_url, prefer_large_media: true, show_above_text: true } });
  } catch (e) { console.warn('[relay] card edit failed:', e.message); }
}

// ─── draft ───────────────────────────────────────────────────────────────────
/** Draft buttons. Takes the item (not just its id) so the section button can say where it's going. */
const draftButtons = item => kb([
  [btn('✅ Publish to Newscast', `rl:p:${item.id}`)],
  [btn(`📂 ${SECTIONS[chosenSection(item)]} ▾`, `rl:c:${item.id}`)],
  [btn('📰 Headline', `rl:eh:${item.id}`), btn('✏️ Text', `rl:et:${item.id}`), btn('🔤 Latin', `rl:el:${item.id}`)],
  [btn('🔁 Redo', `rl:r:${item.id}`), btn('🗑 Drop', `rl:d:${item.id}`)]
]);

// ─── amend one part of a draft ───────────────────────────────────────────────
// 📰 / ✏️ / 🔤 on a draft post a force-reply prompt; the reply to that prompt
// changes only that part (relay/index.js amend()). The prompt's first line —
// "🔤 Latin heading · #123" — is how the reply is matched back to the story,
// so it survives a restart with nothing stored.
const EDIT_FIELDS = {
  h: { icon: '📰', label: 'Headline' },
  t: { icon: '✏️', label: 'Text' },
  l: { icon: '🔤', label: 'Latin heading' },
};

/** Post the prompt for one field, as a reply to the draft, forcing a reply from the tapper. */
async function askEdit(item, field, user) {
  const f = EDIT_FIELDS[field];
  if (!f) return;
  const { headline } = draftBody(item);
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || 'you';
  const fix = '<code>މިރޭގައި → ރޭގައި</code>';
  const how = {
    l: `Now: <code>${esc(item.draft_latin || '—')}</code>\n\nReply with the new Latin heading, in English letters.`,
    h: `Now: <code>${esc(headline)}</code>\n\nReply with the new headline, or just the fix: ${fix}`,
    t: `Reply with the full corrected text (paragraphs only — the headline stays), or just the fix, one per line: ${fix}\nOld word first, then the new one.`,
  }[field];
  const ids = Array.isArray(item.draft_msg_ids) ? item.draft_msg_ids : [];
  const last = ids[ids.length - 1];
  return call('sendMessage', {
    chat_id: chatId(), parse_mode: 'HTML',
    text: `${f.icon} ${f.label} · #${item.id}\n<a href="tg://user?id=${Number(user?.id) || 0}">${esc(name)}</a>\n\n${how}`,
    reply_parameters: last ? { message_id: Number(last), allow_sending_without_reply: true } : undefined,
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: f.label },
    link_preview_options: { is_disabled: true }
  });
}

/** A prompt's plain text → { id, field }, or null if it isn't one of ours. */
function parseEditPrompt(text) {
  const m = /^(?:📰|✏️|🔤)\s*(Headline|Text|Latin heading) · #(\d+)/u.exec(String(text || ''));
  if (!m) return null;
  const field = Object.keys(EDIT_FIELDS).find(k => EDIT_FIELDS[k].label === m[1]);
  return field ? { id: Number(m[2]), field, label: m[1] } : null;
}

/** The section picker that replaces the draft buttons after 📂. */
const sectionPicker = item => {
  const current = chosenSection(item);
  const slugs = Object.keys(SECTIONS);
  const rows = [];
  for (let i = 0; i < slugs.length; i += 2) {
    rows.push(slugs.slice(i, i + 2).map(s => btn(`${s === current ? '● ' : ''}${SECTIONS[s]}`, `rl:cs:${item.id}:${s}`)));
  }
  rows.push([btn('↩️ Back', `rl:cb:${item.id}`)]);
  return kb(rows);
};

/** Swap the buttons on the draft's last message (draft buttons or the picker). */
async function setDraftMarkup(item, markup) {
  const ids = Array.isArray(item.draft_msg_ids) ? item.draft_msg_ids : [];
  const last = ids[ids.length - 1];
  if (!last) return;
  try { await call('editMessageReplyMarkup', { chat_id: chatId(), message_id: last, reply_markup: markup }); }
  catch (e) { console.warn('[relay] draft markup:', e.message); }
}

/** Split a long draft on paragraph boundaries into Telegram-sized chunks. */
function chunk(text, limit = MSG_LIMIT) {
  const paras = String(text).split(/\n+/);
  const out = []; let cur = '';
  for (const p of paras) {
    const piece = p.length > limit ? p.match(new RegExp(`[\\s\\S]{1,${limit}}`, 'g')) : [p];
    for (const q of piece) {
      if ((cur + '\n\n' + q).length > limit && cur) { out.push(cur); cur = q; }
      else cur = cur ? cur + '\n\n' + q : q;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function draftBody(item) {
  const lines = String(item.draft_text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const [headline, ...paras] = lines;
  return { headline: headline || '', paras };
}

/** Send the draft as one or more messages, buttons on the last. Returns message ids. */
async function sendDraft(item) {
  const { headline, paras } = draftBody(item);
  const meta = [`📝 <b>Newscast draft</b> · #${item.id}`,
    item.draft_latin ? `<i>${esc(item.draft_latin)}</i>` : null].filter(Boolean).join('\n');
  const full = `${meta}\n\n<b>${esc(headline)}</b>\n\n${esc(paras.join('\n\n'))}`;
  const parts = chunk(full);
  const ids = [];
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const text = last
      ? `${parts[i]}\n\n<i>📰 ✏️ 🔤 change one part · ↩️ or reply here with a full corrected version to replace the whole draft.</i>`
      : parts[i];
    const m = await call('sendMessage', {
      chat_id: chatId(), text, parse_mode: 'HTML',
      reply_parameters: i === 0 && item.card_msg_id ? { message_id: Number(item.card_msg_id), allow_sending_without_reply: true } : undefined,
      reply_markup: last ? draftButtons(item) : undefined,
      link_preview_options: { is_disabled: true }
    });
    ids.push(m.message_id);
  }
  return ids;
}

/** Mark a draft's button message with an outcome and drop its buttons. */
async function closeDraft(item, note) {
  const ids = Array.isArray(item.draft_msg_ids) ? item.draft_msg_ids : [];
  const last = ids[ids.length - 1];
  if (!last) return;
  try {
    await call('editMessageReplyMarkup', { chat_id: chatId(), message_id: last, reply_markup: kb([]) });
  } catch (e) { console.warn('[relay] closeDraft markup:', e.message); }
  if (note) await say(note, last);
}

/** Restore the draft's buttons after a failed publish. */
async function reopenDraft(item) {
  return setDraftMarkup(item, draftButtons(item));
}

/** Photo from a Buffer (multipart), with HTML caption and buttons. */
async function sendPhotoBuffer({ buffer, caption, markup, replyTo, chat }) {
  const t = token();
  if (!t) throw new Error('RELAY_TELEGRAM_BOT_TOKEN is not set');
  const fd = new FormData();
  fd.append('chat_id', chat || chatId());
  fd.append('caption', caption || '');
  fd.append('parse_mode', 'HTML');
  if (markup) fd.append('reply_markup', JSON.stringify(markup));
  if (replyTo) fd.append('reply_parameters', JSON.stringify({ message_id: Number(replyTo), allow_sending_without_reply: true }));
  fd.append('photo', new Blob([buffer], { type: 'image/jpeg' }), 'card.jpg');
  const r = await fetch(`https://api.telegram.org/bot${t}/sendPhoto`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(`Telegram sendPhoto: ${j.description}`);
  return j.result;
}

/** REYVA: swap a sent photo for a new one (🎨 colour switch), keeping caption + buttons. */
async function editPhotoBuffer({ chat, messageId, buffer, caption, markup }) {
  const t = token();
  if (!t) throw new Error('RELAY_TELEGRAM_BOT_TOKEN is not set');
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('message_id', String(messageId));
  fd.append('media', JSON.stringify({ type: 'photo', media: 'attach://card', caption: caption || '', parse_mode: 'HTML' }));
  if (markup) fd.append('reply_markup', JSON.stringify(markup));
  fd.append('card', new Blob([buffer], { type: 'image/jpeg' }), 'card.jpg');
  const r = await fetch(`https://api.telegram.org/bot${t}/editMessageMedia`, { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const j = await r.json().catch(() => ({ ok: false, description: `HTTP ${r.status}` }));
  if (!j.ok && !/message is not modified/i.test(j.description || '')) throw new Error(`Telegram editMessageMedia: ${j.description}`);
  return j.result;
}

async function say(text, replyTo, chat) {
  return call('sendMessage', {
    chat_id: chat || chatId(), text, parse_mode: 'HTML',
    reply_parameters: replyTo ? { message_id: Number(replyTo), allow_sending_without_reply: true } : undefined,
    link_preview_options: { is_disabled: true }
  });
}

async function answer(callbackId, text, alert = false) {
  try { await call('answerCallbackQuery', { callback_query_id: callbackId, text: text || '', show_alert: alert }); }
  catch (e) { /* the query may already be too old to answer — harmless */ }
}

async function setWebhook(url, secret) {
  return call('setWebhook', {
    url, secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: false
  });
}

module.exports = {
  editPhotoBuffer,
  call, esc, chatId, shareChatId, token, BRAND_LABEL,
  sendCard, updateCard, cardButtons,
  sendDraft, closeDraft, reopenDraft, draftButtons, sectionPicker, setDraftMarkup,
  draftBody, askEdit, parseEditPrompt, EDIT_FIELDS,
  say, answer, setWebhook, chunk, sendPhotoBuffer
};
