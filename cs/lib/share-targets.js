/* VxD Creative Studio — per-brand social destinations
 *
 * Why the fallback rules are asymmetric
 * -------------------------------------
 * TELEGRAM_CHANNEL_ID and IFTTT_WEBHOOK_KEY predate multi-brand support and point
 * at DHUVAS. They fall back for DHUVAS ONLY. If they fell back for every brand, a
 * VOICE or NEWSCAST card would post silently into the @dhuvas channel or fire the
 * dhuvas tweet applet — wrong content under the wrong masthead, with a success
 * message. Failing closed and hiding the button is the safe direction.
 *
 * The bot TOKEN is different from the CHANNEL: one bot can be admin of all three
 * channels, and the token is not the destination. So TELEGRAM_BOT_TOKEN applies to
 * every brand, with an optional per-brand override. The channel never does.
 *
 * The IFTTT KEY *is* the destination (it identifies the account), so it must be set
 * per brand. The event name defaults to vxd_tweet_<brand> so only the key is
 * required; dhuvas keeps the original vxd_tweet event.
 *
 * Env-var suffix is the brand key upper-cased, underscores and all, so voice_en's
 * variables are:
 *   CS_TELEGRAM_CHANNEL_VOICE_EN   IFTTT_KEY_VOICE_EN   IFTTT_EVENT_VOICE_EN
 *   VIBER_TOKEN_VOICE_EN           VIBER_SENDER_VOICE_EN
 * Until they are set, summary() reports the brand as not ready and the client
 * hides its share buttons — which is the intended state, not a bug.
 */

'use strict';

// Reyva studio: one masthead. (VxD runs dhuvas, voice, newscast, voice_en.)
const BRANDS = ['reyva'];
// The one brand → masthead-domain map. routes/telegram.js used to keep its own
// copy; two lists that must agree will eventually disagree.
//
// voice_en is maldivesvoice.mv, VOICE's English edition. It is a separate HOST,
// not a path on voice.mv — which matters, because every brand lookup in this
// codebase resolves the masthead from the hostname alone. Note also that
// 'maldivesvoice.mv'.endsWith('.voice.mv') is false, so the exact-or-suffix match
// the callers use cannot confuse the two. A voice.mv/en path would have needed
// path-aware detection in index.js, telegram.js and card-studio.js alike.
const BRAND_SITES = { reyva: 'reyvaonline.com' };

/* Publication language per masthead. Not cosmetic — two things read it and both
 * fail SILENTLY when it is wrong:
 *   • the article extractor in ../index.js filters candidate paragraphs and
 *     headlines by script, so the Thaana gate returns an empty body with ok:true
 *     for an English article;
 *   • the Claude prompts in ../routes/{ai,fb-caption}.js instruct the model to
 *     write in Thaana, so an English source comes back transliterated.
 * Anything reading this must default to 'dv', so a brand added without an entry
 * behaves exactly as the three original ones did. */
const BRAND_LANG = { reyva: 'dv' };
const langOf = b => BRAND_LANG[b] || 'dv';

// The unsuffixed legacy env vars (CS_TELEGRAM_CHANNEL_ID, IFTTT_WEBHOOK_KEY)
// apply to Reyva — it is the only masthead, so there is no wrong one to hit.
const LEGACY = 'reyva';                    // the brand the pre-multi-brand vars refer to

const env = k => (process.env[k] || '').trim();
const suffix = b => String(b || '').toUpperCase();

function telegramTarget(brand) {
  const B = suffix(brand);
  // CS_-prefixed. The unprefixed TELEGRAM_BOT_TOKEN is the host app's own env
  // fallback for a *different* bot (VSA 8486349896, Creative Studio 8988730556);
  // VSA reads its token from the database first, so sharing the name would have
  // been a latent bug rather than an immediate one — the worst kind.
  const token   = env('CS_TELEGRAM_BOT_TOKEN_' + B) || env('CS_TELEGRAM_BOT_TOKEN');
  const channel = env('CS_TELEGRAM_CHANNEL_' + B) || (brand === LEGACY ? env('CS_TELEGRAM_CHANNEL_ID') : '');
  return { token, channel, ready: !!(token && channel) };
}

function xTarget(brand) {
  const B = suffix(brand);
  const key   = env('IFTTT_KEY_' + B) || (brand === LEGACY ? env('IFTTT_WEBHOOK_KEY') : '');
  const event = env('IFTTT_EVENT_' + B) || (brand === LEGACY ? 'vxd_tweet' : 'vxd_tweet_' + brand);
  return { key, event, ready: !!key };
}

/* Viber Channels Post API.
 * No legacy fallback exists for any brand — Viber was added after multi-brand, so
 * every brand must be named explicitly. Both values are per-Channel: the token
 * comes from the Channel's Developer Tools screen, and the sender must be a
 * SUPER admin's user id (from get_account_info -> members[] where role is
 * "superadmin"). A plain admin id is rejected. */
function viberTarget(brand) {
  const B = suffix(brand);
  const token  = env('VIBER_TOKEN_' + B);
  const sender = env('VIBER_SENDER_' + B);
  return { token, sender, ready: !!(token && sender) };
}

/* Facebook Page via the Graph API. A Page access token (not a user token) with
 * pages_manage_posts. FB_LINK_IN_<BRAND> is 'comment' (default — the article
 * link goes in the Page's first comment) or 'caption'. No legacy fallback: every
 * brand names its own Page, so a card can never land on another outlet's Page. */
function facebookTarget(brand) {
  const B = suffix(brand);
  const pageId = env('FB_PAGE_ID_' + B);
  const token  = env('FB_PAGE_TOKEN_' + B);
  const linkIn = env('FB_LINK_IN_' + B).toLowerCase() === 'caption' ? 'caption' : 'comment';
  return { pageId, token, linkIn, ready: !!(pageId && token) };
}

/* { dhuvas: { telegram: true, x: true, viber: true, facebook: false }, … } — safe to send to the
 * browser: readiness flags only, never tokens or keys. */
function summary() {
  const out = {};
  for (const b of BRANDS) out[b] = {
    telegram: telegramTarget(b).ready,
    x: xTarget(b).ready,
    viber: viberTarget(b).ready,
    facebook: facebookTarget(b).ready
  };
  return out;
}

module.exports = {
  BRANDS, BRAND_SITES, BRAND_LANG, langOf, LEGACY,
  telegramTarget, xTarget, viberTarget, facebookTarget, summary
};
