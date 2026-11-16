// REYVA FORK (2026-11-16): from VxD Super App's relay/share.js, unchanged but
// for the brand name. Reyva only has share rows (mode 'share'), from its own
// stories; the Newscast relay-row paths below are never taken.
// ─────────────────────────────────────────────────────────────────────────────
// relay/share.js — share a story to social media from a Telegram group
// ─────────────────────────────────────────────────────────────────────────────
// Once a story is live and its newscast.mv link is known, the group gets a
// share card:
//
//   [ the Newscast card image — relay/card.js ]
//   AI caption (Creative Studio's generator) + link
//   ☑ 📘 Facebook   ☑ 📢 Telegram
//   ☑ 🐦 X          ☑ 🟣 Viber
//   🔁 New caption   ✏️ Edit caption
//   📣 Share (4)
//
// Every channel set up for Newscast starts ticked. Untick any, then tap Share
// once. A channel that posted turns ✅ and can't be posted again. A failed one
// shows ⚠️, stays ticked, and the next Share retries only that one. Replying to
// the card with text replaces the caption. ✏️ Edit caption posts a force-reply
// prompt (like 📰 / ✏️ on a Newscast draft) that takes either a whole new
// caption or just a fix — old → new — so one wrong word doesn't mean retyping
// the Thaana. Both caption buttons stay while anything is left to share.
//
// Channels and their variables are Creative Studio's (cs/lib/share-targets.js),
// and the senders are cs/lib/publishers.js.
//
// Two kinds of row get a share card:
//   • relay rows — a Dhuvas/Voice story rewritten and published on Newscast.
//     Brand newscast, the draft's headline, the newscast.mv link, the Newscast
//     group (RELAY_CHAT_ID).
//   • share rows (mode 'share') — a masthead's OWN story, straight from the
//     watcher with no rewrite. Brand = the masthead, its own headline and link,
//     its own group (RELAY_SHARE_CHAT_<BRAND>, e.g. the Dhuvas Desk group).
//
// The same story can also sit in Creative Studio's queue (its Telegram-channel
// webhook). Both stay: when the group shares, the queue item says so, and when
// the queue item was loaded into the studio, the share card says that — so
// nobody posts a story twice without seeing it was already done.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('./db');
const tg = require('./telegram');
const { renderCard } = require('./card');
const { CHANNELS } = require('../cs/lib/publishers');
const xBudget = require('../cs/lib/x-budget');
const { generateCaption } = require('../cs/routes/fb-caption');

const esc = tg.esc;

// ─── what a row shares ───────────────────────────────────────────────────────
const isOwn = item => item.mode === 'share';
const brandOf = item => (isOwn(item) ? item.brand : 'newscast');
const urlOf = item => (isOwn(item) ? item.source_url : item.newscast_url) || '';
const chatOf = item => String(item.share_chat_id || (isOwn(item) ? tg.shareChatId(item.brand) : tg.chatId()));
const draftLines = item => String(item.draft_text || '').split('\n').map(l => l.trim()).filter(Boolean);
const headlineOf = item => (isOwn(item) ? String(item.source_title || '').trim() : draftLines(item)[0] || '');
const bodyOf = item => (isOwn(item)
  ? String(item.source_text || '').split('\n').map(l => l.trim()).filter(Boolean).join('\n\n')
  : draftLines(item).slice(1).join('\n\n'));
const brandName = b => ({ reyva: 'Reyva', newscast: 'Newscast', dhuvas: 'Dhuvas', voice: 'Voice', voice_en: 'Maldives Voice' }[b] || b);

// ─── Creative Studio's queue ─────────────────────────────────────────────────
// Best effort both ways: a queue that can't be read never blocks a share.
async function csStatus(item) {
  try { return await require('../cs/db').articleByUrl(urlOf(item)); } catch { return null; }
}
async function csMarkShared(item, note) {
  try { await require('../cs/db').noteShared(urlOf(item), note); }
  catch (e) { console.warn('[relay/share] queue note:', e.message); }
}

async function writeCaption(item, headline) {
  try {
    const r = await generateCaption({ headline, bodyText: bodyOf(item), brand: brandOf(item) });
    return { caption: r.caption, note: null };
  } catch (e) {
    console.error(`[relay/share] caption #${item.id}:`, e.message);
    return { caption: headline, note: `⚠️ AI caption failed (${String(e.message).slice(0, 120)}). Using the headline. Tap 🔁 or reply with your own.` };
  }
}

// ─── the share message ───────────────────────────────────────────────────────
function channelsOf(item) {
  return item.share_channels && typeof item.share_channels === 'object' ? item.share_channels : {};
}
// JSONB doesn't keep key order, so always list channels in CHANNELS' order.
const keysOf = ch => Object.keys(CHANNELS).filter(k => ch[k]);

// ─── X by hand ───────────────────────────────────────────────────────────────
// IFTTT sends about 166 tweets a month and answers "ok" long after it has
// stopped posting (cs/lib/x-budget.js). When a brand's allowance is spent its X
// channel turns manual: the card gets 🐦 Post on X — a link that opens X with
// the caption and article link filled in — and ✔️ X posted, which ticks it.
// 📣 Share skips a manual X; the other channels post as always.
const xWaiting = ch => !!(ch.x && ch.x.manual && ch.x.on && !ch.x.done);
const autoKeys = ch => keysOf(ch).filter(k => !(k === 'x' && ch.x.manual));

const mvtTime = iso => (iso ? new Date(new Date(iso).getTime() + 5 * 3600 * 1000).toISOString().slice(11, 16) : '');

/** "✅ Shared by Azmee 11:20 — Facebook, Telegram", one line per person, or null. */
function sharedLine(ch) {
  const by = new Map();
  for (const k of keysOf(ch)) {
    const c = ch[k];
    if (!c.done) continue;
    const key = c.by || 'someone';
    if (!by.has(key)) by.set(key, { at: c.at, labels: [] });
    by.get(key).labels.push(CHANNELS[k]?.label || k);
  }
  if (!by.size) return null;
  return [...by].map(([who, v]) => `✅ <b>Shared by ${esc(who)}</b>${v.at ? ` · ${mvtTime(v.at)}` : ''} — ${esc(v.labels.join(', '))}`).join('\n');
}

function shareText(item, extra, cs) {
  const ch = channelsOf(item);
  const warns = keysOf(ch).map(k => {
    const c = ch[k], L = CHANNELS[k]?.label || k;
    if (c.done && c.warn) return `ℹ️ ${L}: ${esc(c.warn)}`;
    if (!c.done && c.error) return `⚠️ ${L} failed: ${esc(c.error)}`;
    return null;
  }).filter(Boolean);
  const shared = sharedLine(ch);
  const head = isOwn(item) ? `${tg.BRAND_LABEL[item.brand] || item.brand} · 📣 <b>Share</b> · #${item.id}` : `📣 <b>Share</b> · #${item.id}`;
  const csLine = cs && cs.status === 'done' ? '🎨 Also loaded in Creative Studio — check it wasn\'t posted from there.' : null;
  const xLine = xWaiting(ch) ? '👆 <b>X is by hand</b> for now: tap 🐦 Post on X, send it there, then ✔️ X posted.' : null;
  const tail = [
    esc(urlOf(item)),
    warns.length ? warns.join('\n') : null,
    xLine,
    csLine,
    extra || null,
    shared ? null : '<i>↩️ Reply with a new caption to replace it.</i>',
  ].filter(Boolean);
  // Who shared goes at the top, where it's seen first. The photo caption limit
  // is 1024; only the AI caption is shortened to fit, as plain text before
  // escaping — cutting the finished HTML could break a tag, Telegram would
  // refuse the edit, and the card would go on looking unshared.
  const top = [head, shared].filter(Boolean).join('\n');
  const room = 1000 - top.length - tail.join('\n\n').length - 4;
  let cap = String(item.share_caption || '');
  if (esc(cap).length > room) {
    // Longest prefix whose escaped form, plus the ellipsis, still fits.
    let lo = 0, hi = cap.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (esc(cap.slice(0, mid)).length + 1 <= room) lo = mid; else hi = mid - 1; }
    cap = lo > 0 ? cap.slice(0, lo).trimEnd() + '…' : '';
  }
  return [top, esc(cap), ...tail].filter(Boolean).join('\n\n');
}

function shareButtons(item, confirming = false) {
  const ch = channelsOf(item);
  const keys = keysOf(ch);
  const btns = keys.map(k => {
    const c = ch[k], C = CHANNELS[k];
    const mark = c.done ? '✅' : k === 'x' && c.manual && c.on ? '👆' : c.error && c.on ? '⚠️' : c.on ? '☑' : '☐';
    return { text: `${mark} ${C.icon} ${C.label}`, callback_data: `rl:t:${item.id}:${k}` };
  });
  const rows = [];
  for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2));
  // X by hand: the link opens X with the post written; the tick records it.
  const xWait = xWaiting(ch);
  if (xWait) rows.push([
    { text: '🐦 Post on X', url: xBudget.intent({ caption: item.share_caption, url: urlOf(item) }) },
    { text: '✔️ X posted', callback_data: `rl:xd:${item.id}` },
  ]);
  // What 📣 Share will post — a manual X is not part of it.
  const pending = autoKeys(ch).filter(k => ch[k].on && !ch[k].done).length;
  const left = pending + (xWait ? 1 : 0);
  const anyDone = keys.some(k => ch[k].done);
  const allDone = keys.length && keys.every(k => ch[k].done);
  if (allDone) rows.push([{ text: '✅ Shared everywhere', callback_data: `rl:t:${item.id}:none` }]);
  else if (anyDone && !pending) {
    // Shared, with some channels left out on purpose. Say so, instead of a
    // Share button that makes the card look untouched.
    rows.push([{ text: xWait ? '✅ Shared — X is waiting for your tap' : '✅ Shared — tick a channel above to add it', callback_data: `rl:t:${item.id}:none` }]);
  } else {
    rows.push([
      { text: '🔁 New caption', callback_data: `rl:nc:${item.id}` },
      { text: '✏️ Edit caption', callback_data: `rl:ec:${item.id}` },
    ]);
    rows.push([
      { text: anyDone ? `📣 Share to ${pending} more` : pending ? `📣 Share (${pending})` : '📣 Share', callback_data: `rl:sh:${item.id}` },
    ]);
    // Posted some other way (the Facebook app, the channel itself…): say so
    // here, so nobody posts it again. Two taps, since it can't be undone.
    if (left) {
      rows.push(confirming
        ? [{ text: `✔️ Yes — ${left === 1 ? 'it was' : `all ${left} were`} posted already`, callback_data: `rl:mp:${item.id}:ok` },
           { text: '↩️ Cancel', callback_data: `rl:mp:${item.id}:no` }]
        : [{ text: '✔️ Already posted elsewhere', callback_data: `rl:mp:${item.id}` }]);
    }
  }
  return { inline_keyboard: rows };
}

async function refresh(item, extra) {
  if (!item.share_msg_id) return;
  const cs = await csStatus(item);
  try {
    await tg.call('editMessageCaption', {
      chat_id: chatOf(item), message_id: Number(item.share_msg_id),
      caption: shareText(item, extra, cs), parse_mode: 'HTML', reply_markup: shareButtons(item)
    });
    return true;
  } catch (e) {
    console.error(`[relay/share] refresh #${item.id}:`, e.message);
    // Last resort: plain caption, so the buttons at least show what happened.
    try {
      await tg.call('editMessageCaption', {
        chat_id: chatOf(item), message_id: Number(item.share_msg_id),
        caption: shareText(item, null, null).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').slice(0, 1000),
        reply_markup: shareButtons(item)
      });
      return true;
    } catch (e2) { console.error(`[relay/share] refresh #${item.id} (plain):`, e2.message); return false; }
  }
}

// ─── entry points ────────────────────────────────────────────────────────────
/**
 * Build and post the share card. Relay rows call this once the Newscast link is
 * known; share rows straight from the watcher (fromSource). Returns the row, or
 * null when no card was posted.
 */
async function prepare(item, headline, replyTo) {
  const brand = brandOf(item);
  const chat = chatOf(item);
  headline = headline || headlineOf(item);
  const ready = Object.keys(CHANNELS).filter(k => CHANNELS[k].ready(brand));
  if (!ready.length) {
    await tg.say(`📣 No ${brandName(brand)} social channels are set up yet, so there is nothing to share to.`, replyTo, chat);
    return null;
  }
  let card;
  try {
    card = await renderCard({ brand, headline, photo: item.source_image || null, url: urlOf(item), section: isOwn(item) ? item.source_section : null });
  } catch (e) {
    console.error(`[relay/share] card #${item.id}:`, e.message);
    await tg.say(`⚠️ Couldn't draw the share card for #${item.id}: ${esc(e.message)}`, replyTo, chat);
    return null;
  }
  const { caption, note } = await writeCaption(item, headline);
  // A rebuilt card (/share) keeps what already posted, so it can't post twice.
  const before = channelsOf(item);
  const channels = Object.fromEntries(ready.map(k => [k, before[k]?.done ? before[k] : { on: true, done: false, error: null }]));
  // Posted from Creative Studio before this card existed: tick those now.
  const early = [];
  for (const p of await db.takeEarlyPosts(urlOf(item), brand).catch(e => { console.warn('[relay/share] early posts:', e.message); return []; })) {
    if (!channels[p.channel] || channels[p.channel].done) continue;
    const by = `${p.who || 'someone'} (${p.via || 'Creative Studio'})`;
    channels[p.channel] = { on: true, done: true, error: null, by, at: new Date(p.at).toISOString(), warn: null };
    early.push({ ...p, by });
  }
  // X: automatic while this month's IFTTT allowance lasts, by hand after.
  if (channels.x && !channels.x.done) channels.x.manual = !(await xBudget.status(brand)).auto;
  // …and the old card loses its buttons, so only one card per story takes taps.
  if (item.share_msg_id) {
    try { await tg.call('editMessageReplyMarkup', { chat_id: chatOf(item), message_id: Number(item.share_msg_id), reply_markup: { inline_keyboard: [] } }); }
    catch (e) { console.warn('[relay/share] old card:', e.message); }
  }
  let row = await db.update(item.id, {
    share_caption: caption, share_card: card, share_channels: JSON.stringify(channels), share_busy: false,
    share_chat_id: Number(chat)
  });

  const m = await tg.sendPhotoBuffer({
    buffer: card, caption: shareText(row, note, await csStatus(row)), markup: shareButtons(row), replyTo, chat
  });
  row = await db.update(item.id, { share_msg_id: m.message_id });
  if (early.length) {
    // Same notice a Creative Studio post gives once the card is up, one per person.
    const byWho = new Map();
    for (const p of early) {
      const k = `${p.who || 'someone'}|${p.via || 'Creative Studio'}`;
      if (!byWho.has(k)) byWho.set(k, []);
      byWho.get(k).push(CHANNELS[p.channel]?.label || p.channel);
    }
    for (const [k, labels] of byWho) {
      const [who, via] = k.split('|');
      console.log(`[relay/share] #${row.id} card came after ${via} posts by ${who}: ${labels.join(', ')}`);
      await tg.say(`📣 <b>Shared from ${esc(via)}</b> #${row.id} — ${esc(who)}\n✅ ${esc(labels.join(', '))}`, row.share_msg_id, chat)
        .catch(e => console.warn('[relay/share] early notice:', e.message));
    }
  }
  return row;
}

/**
 * A masthead's own new story (share mode), from the watcher or /pull. The card
 * goes to that masthead's group; the row moves new → share once it's there.
 * Throws if it didn't get there, so the caller can count the attempt.
 */
async function fromSource(item) {
  await db.update(item.id, { attempts: (item.attempts || 0) + 1 });
  const row = await prepare(item);
  if (!row || !row.share_msg_id) throw new Error('share card not posted');
  return db.transition(item.id, ['new', 'share'], 'share', {});
}

// ─── button taps ─────────────────────────────────────────────────────────────
async function toggle(item, key) {
  const ch = channelsOf(item);
  if (!ch[key]) {
    if (key !== 'none') return { answer: `That channel is not set up for ${brandName(brandOf(item))}.` };
    const s = sharedLine(ch);
    return { answer: s ? s.replace(/<[^>]+>/g, '') : 'Everything is posted.' };
  }
  if (ch[key].done) return { answer: `Already posted to ${CHANNELS[key].label}${ch[key].by ? ` by ${ch[key].by}` : ''}${ch[key].at ? ` at ${mvtTime(ch[key].at)}` : ''}.` };
  ch[key].on = !ch[key].on;
  const row = await db.update(item.id, { share_channels: JSON.stringify(ch) });
  await refresh(row);
  return { answer: `${CHANNELS[key].label}: ${ch[key].on ? 'on' : 'off'}` };
}

async function newCaption(item) {
  // REYVA: re-read the story from reyvaonline.com's API before a new caption,
  // so an article edited after it was carded gets a caption from its new text.
  // (VxD re-read via relay/feed.js for the same reason.)
  if (isOwn(item) && item.source_url) {
    try {
      const { article } = await require('../lib/reyva-article').readArticle(item.source_url);
      const s = article || {};
      if (s.text && s.text.length >= 80 && s.text !== item.source_text) item = await db.update(item.id, { source_text: s.text });
    } catch (e) { console.warn(`[relay/share] #${item.id} body re-read:`, e.message); }
  }
  const { caption, note } = await writeCaption(item, headlineOf(item));
  const row = await db.update(item.id, { share_caption: caption });
  await refresh(row, note);
}

async function replaceCaption(item, text, who, how = 'Caption by') {
  const row = await db.update(item.id, { share_caption: text.trim() });
  await refresh(row, `✏️ ${how} ${esc(who)}`);
}

// ─── ✏️ Edit caption ─────────────────────────────────────────────────────────
// The prompt's first line — "✏️ Caption · #123" — is how the reply finds its
// story, so it survives a restart with nothing stored (same as relay drafts).
const CAPTION_PROMPT = /^✏️\s*Caption · #(\d+)/u;

/** Post the force-reply prompt under the share card, for the tapper only. */
async function askCaptionEdit(item, user) {
  const name = [user?.first_name, user?.last_name].filter(Boolean).join(' ') || user?.username || 'you';
  const now = String(item.share_caption || '');
  return tg.call('sendMessage', {
    chat_id: chatOf(item), parse_mode: 'HTML',
    text: `✏️ Caption · #${item.id}\n<a href="tg://user?id=${Number(user?.id) || 0}">${esc(name)}</a>\n\n`
      + `Now: <code>${esc(now.length > 700 ? now.slice(0, 700) + '…' : now)}</code>\n\n`
      + 'Reply with the new caption, or just the fix, one per line: <code>މިރޭގައި → ރޭގައި</code>\nOld word first, then the new one.',
    reply_parameters: item.share_msg_id ? { message_id: Number(item.share_msg_id), allow_sending_without_reply: true } : undefined,
    reply_markup: { force_reply: true, selective: true, input_field_placeholder: 'Caption' },
    link_preview_options: { is_disabled: true }
  });
}

/** A prompt's plain text → the story id, or null if it isn't a caption prompt. */
function parseCaptionPrompt(text) {
  const m = CAPTION_PROMPT.exec(String(text || ''));
  return m ? Number(m[1]) : null;
}

/** Post to every ticked channel that hasn't posted yet. One share at a time per story. */
async function share(item, who) {
  const locked = await db.lockShare(item.id);
  if (!locked) return { answer: 'Already sharing — hold on.' };
  let row = locked;
  try {
    const ch = channelsOf(row);
    // Checked again at the moment of sharing: the allowance may have run out
    // since the card was drawn — or come back, on the day the credits renew.
    if (ch.x && ch.x.on && !ch.x.done) {
      const manual = !(await xBudget.status(brandOf(row))).auto;
      if (manual !== !!ch.x.manual) {
        ch.x = { ...ch.x, manual, error: manual ? null : ch.x.error };
        row = await db.update(row.id, { share_channels: JSON.stringify(ch) });
      }
    }
    const todo = autoKeys(ch).filter(k => ch[k].on && !ch[k].done);
    if (!todo.length) {
      if (!xWaiting(ch)) return { answer: 'Tick at least one channel first.' };
      await refresh(row);
      return { answer: 'Only X is left, and X is by hand for now: tap 🐦 Post on X on the card, then ✔️ X posted.' };
    }
    if (!row.share_card) return { answer: 'The card is missing — tap 🔁 or /pull the story again.' };
    await refresh(row, `⏳ Sharing to ${todo.map(k => CHANNELS[k].label).join(', ')}… — ${esc(who)}`);

    const image = Buffer.isBuffer(row.share_card) ? row.share_card : Buffer.from(row.share_card);
    for (const k of todo) {
      try {
        const r = await CHANNELS[k].post({ brand: brandOf(row), caption: row.share_caption, url: urlOf(row), image });
        ch[k] = { on: true, done: true, error: null, by: who, at: new Date().toISOString(), warn: r.commentError || null };
      } catch (e) {
        // The allowance ran out between the check above and this post.
        if (k === 'x' && e.manual) { ch.x = { ...ch.x, on: true, done: false, error: null, manual: true }; continue; }
        console.error(`[relay/share] #${row.id} ${k}:`, e.message);
        ch[k] = { ...ch[k], on: true, done: false, error: String(e.message).slice(0, 160) };
      }
    }
    row = await db.update(row.id, { share_channels: JSON.stringify(ch) });
    const posted = keysOf(ch).filter(k => ch[k].done);
    if (posted.length) {
      const time = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(11, 16);   // MVT
      await csMarkShared(row, `${posted.map(k => CHANNELS[k].label).join(', ')} · ${who} · ${time}`);
    }
    const failed = keysOf(ch).filter(k => ch[k].error && !ch[k].done);
    const okNow = todo.filter(k => ch[k].done);
    await refresh(row, failed.length ? `Tap 📣 Share to retry the ⚠️ ${failed.length === 1 ? 'one' : 'ones'}.` : null);
    // A reply under the card, so the whole group gets a notification — an
    // edited caption notifies nobody, which is how a share went unnoticed.
    const line = [
      okNow.length ? `✅ ${okNow.map(k => CHANNELS[k].label).join(', ')}` : null,
      failed.length ? `⚠️ ${failed.map(k => `${CHANNELS[k].label} (${ch[k].error})`).join(', ')}` : null,
      xWaiting(ch) ? '👆 X is by hand — tap 🐦 Post on X on the card, then ✔️ X posted' : null,
    ].filter(Boolean).join('\n');
    await tg.say(`📣 <b>Shared</b> #${row.id} — ${esc(who)}\n${esc(line)}`, row.share_msg_id, chatOf(row)).catch(e => console.warn('[relay/share] notice:', e.message));
    return { answer: failed.length ? `${failed.length} channel(s) failed` : 'Shared ✅', notified: true };
  } finally {
    await db.update(item.id, { share_busy: false });
  }
}

/**
 * ✔️ Already posted elsewhere. First tap asks; `ok` marks every ticked channel
 * that hasn't posted as done, by the tapper, without posting anything.
 */
async function markPosted(item, who, arg) {
  if (!arg || arg === 'no') {
    try {
      await tg.call('editMessageReplyMarkup', { chat_id: chatOf(item), message_id: Number(item.share_msg_id), reply_markup: shareButtons(item, !arg) });
    } catch (e) { console.warn(`[relay/share] #${item.id} confirm:`, e.message); }
    return { answer: arg ? 'Cancelled' : 'Tap ✔️ Yes to confirm — nothing gets posted.' };
  }
  const ch = channelsOf(item);
  const todo = keysOf(ch).filter(k => ch[k].on && !ch[k].done);
  if (!todo.length) return { answer: 'Nothing left to mark.' };
  const at = new Date().toISOString();
  for (const k of todo) ch[k] = { on: true, done: true, error: null, by: `${who} (posted elsewhere)`, at, warn: null };
  const row = await db.update(item.id, { share_channels: JSON.stringify(ch) });
  await refresh(row);
  await csMarkShared(row, `${todo.map(k => CHANNELS[k].label).join(', ')} · ${who} (posted elsewhere) · ${mvtTime(at)}`);
  await tg.say(`✔️ <b>Marked as posted</b> #${row.id} — ${esc(who)}\n${esc(todo.map(k => CHANNELS[k].label).join(', '))}`, row.share_msg_id, chatOf(row))
    .catch(e => console.warn('[relay/share] mark notice:', e.message));
  return { answer: 'Marked as posted ✅' };
}

/** ✔️ X posted — the tweet went out by hand (🐦 Post on X). Ticks X, posts nothing. */
async function xPosted(item, who) {
  const ch = channelsOf(item);
  if (!ch.x) return { answer: `X is not set up for ${brandName(brandOf(item))}.` };
  if (ch.x.done) return { answer: `Already posted to X${ch.x.by ? ` by ${ch.x.by}` : ''}${ch.x.at ? ` at ${mvtTime(ch.x.at)}` : ''}.` };
  const at = new Date().toISOString();
  ch.x = { on: true, done: true, error: null, by: `${who} (by hand)`, at, warn: null };
  const row = await db.update(item.id, { share_channels: JSON.stringify(ch) });
  await refresh(row);
  await csMarkShared(row, `X · ${who} (by hand) · ${mvtTime(at)}`);
  await tg.say(`🐦 <b>Posted on X</b> #${row.id} — ${esc(who)}`, row.share_msg_id, chatOf(row))
    .catch(e => console.warn('[relay/share] x notice:', e.message));
  return { answer: 'X marked as posted ✅' };
}

// ─── posted from somewhere else ──────────────────────────────────────────────
// Creative Studio posts a story channel by channel, one request each. Every
// post it makes is ticked on that story's share card here (cs/index.js calls
// markExternal), so the group never shares a story twice without knowing.
// Its notices are gathered for a little while, so four channels posted from
// Creative Studio give one reply under the card, not four.
const pendingNotes = new Map();   // row id → { who, via, labels: Set, timer }

function noteLater(row, who, via, label) {
  const k = row.id;
  const p = pendingNotes.get(k) || { who, via, labels: new Set(), timer: null };
  p.labels.add(label);
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    pendingNotes.delete(k);
    tg.say(`📣 <b>Shared from ${esc(p.via)}</b> #${k} — ${esc(p.who)}\n✅ ${esc([...p.labels].join(', '))}`, row.share_msg_id, chatOf(row))
      .catch(e => console.warn('[relay/share] external notice:', e.message));
  }, 20000);
  pendingNotes.set(k, p);
}

/**
 * Tick `channel` as posted on the story's share card, when the story has one.
 * { brand, url, channel: 'facebook'|'telegram'|'x'|'viber', who, via }
 */
async function markExternal({ brand, url, channel, who, via = 'Creative Studio' }) {
  if (!CHANNELS[channel] || !url || !brand) return null;
  const item = await db.findShareByUrl(url, brand);
  if (!item) {
    // No card yet — usually the watcher hasn't picked the story up. Keep it for
    // prepare(), so the card arrives already ticked instead of looking unshared.
    await db.addEarlyPost({ brand, url, channel, who: who || 'someone', via });
    console.log(`[relay/share] ${brand} ${channel} posted from ${via} by ${who} before its card — kept for ${url}`);
    return null;
  }
  const ch = channelsOf(item);
  if (ch[channel] && ch[channel].done) return item;
  ch[channel] = { on: true, done: true, error: null, by: `${who || 'someone'} (${via})`, at: new Date().toISOString(), warn: null };
  const row = await db.update(item.id, { share_channels: JSON.stringify(ch) });
  console.log(`[relay/share] #${row.id} ${channel} posted from ${via} by ${who}`);
  if (isLive(row)) {
    await refresh(row);
    noteLater(row, who || 'someone', via, CHANNELS[channel].label);
  }
  return row;
}

/** A share card that still takes taps: posted, and (for relay rows) published. */
const isLive = item => !!(item && item.share_msg_id && (isOwn(item) ? item.status === 'share' : item.status === 'published'));

module.exports = { prepare, fromSource, toggle, share, markExternal, markPosted, xPosted, newCaption, replaceCaption, askCaptionEdit, parseCaptionPrompt, shareText, shareButtons, isLive, chatOf, headlineOf };
