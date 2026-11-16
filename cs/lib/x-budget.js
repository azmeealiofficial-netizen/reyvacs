/* cs/lib/x-budget.js — is X still on automatic, or is it tap-to-post?
 *
 * Why this exists
 * ---------------
 * Since 29 Oct 2026 IFTTT bills in credits: a tweet costs 120, Pro gives 20,000
 * a month, so about 166 tweets. Dhuvas tweets 15-30 a day and ran dry on 8 Nov.
 * IFTTT's webhook still answers 200 with no credits left, so nothing here can
 * SEE the account is empty — every tweet "succeeded" and none was posted.
 *
 * So the app keeps its own count. Each tweet handed to IFTTT is a row in
 * cs_x_posts; once a brand has used its budget for the billing month, X stops
 * going to IFTTT and becomes tap-to-post: a link that opens X with the caption
 * and article link filled in. A post made by hand costs nothing (X's $0.20 link
 * fee is an API fee), so the link stays clickable all month.
 *
 * Variables, per brand (suffix = brand key upper-cased, as in share-targets.js):
 *   IFTTT_X_BUDGET_<BRAND>       tweets IFTTT may send per billing month.
 *                                Unset = no counting, always automatic (how
 *                                every brand behaved before). 0 = always by hand.
 *   IFTTT_X_CYCLE_DAY_<BRAND>    day of the month the credits renew (UTC), 1-31.
 *                                Falls back to IFTTT_X_CYCLE_DAY, then 1.
 *   IFTTT_X_EMPTY_UNTIL_<BRAND>  a date (2026-11-29): by hand until then, whatever
 *                                the count says. For when the account is already
 *                                empty, or runs out early.
 */

'use strict';

const db = require('../db');

const env = k => (process.env[k] || '').trim();
const suffix = b => String(b || '').toUpperCase();
const fullUrl = u => (!u ? '' : (String(u).startsWith('http') ? String(u) : 'https://' + u));

function config(brand) {
  const B = suffix(brand);
  const raw = env('IFTTT_X_BUDGET_' + B);
  const n = parseInt(raw, 10);
  const d = parseInt(env('IFTTT_X_CYCLE_DAY_' + B) || env('IFTTT_X_CYCLE_DAY'), 10);
  const u = Date.parse(env('IFTTT_X_EMPTY_UNTIL_' + B));
  return {
    budget: raw === '' || !Number.isFinite(n) ? null : Math.max(0, n),
    day: Number.isFinite(d) ? Math.min(31, Math.max(1, d)) : 1,
    emptyUntil: Number.isFinite(u) ? u : 0
  };
}

const daysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** The billing month `now` falls in, as { start, end } in ms. A cycle day past
 *  the end of a short month (31 in April) lands on that month's last day. */
function cycle(day, now = Date.now()) {
  const t = new Date(now);
  let y = t.getUTCFullYear(), m = t.getUTCMonth();
  let start = Date.UTC(y, m, Math.min(day, daysIn(y, m)));
  if (start > now) {
    m -= 1; if (m < 0) { m = 11; y -= 1; }
    start = Date.UTC(y, m, Math.min(day, daysIn(y, m)));
  }
  let ny = y, nm = m + 1; if (nm > 11) { nm = 0; ny += 1; }
  return { start, end: Date.UTC(ny, nm, Math.min(day, daysIn(ny, nm))) };
}

/** { auto: true }  → hand the tweet to IFTTT.
 *  { auto: false } → tap-to-post. `resets` is when automatic comes back (ms). */
async function status(brand) {
  const c = config(brand);
  const now = Date.now();
  if (c.emptyUntil > now) return { auto: false, why: 'empty', resets: c.emptyUntil };
  if (c.budget === null) return { auto: true, unlimited: true };
  const { start, end } = cycle(c.day, now);
  // 0 = always by hand. Decided here, before the count, so a database hiccup
  // can never send a tweet to IFTTT for a brand that has opted out of it.
  if (c.budget === 0) return { auto: false, why: 'off', used: 0, budget: 0, left: 0, resets: end };
  let used;
  try { used = await db.xPostCount(brand, new Date(start)); }
  catch (e) {
    // A count that can't be read must not stop tweets: carry on automatically.
    console.warn(`[x] ${brand}: could not read the tweet count (${e.message}) — staying on automatic`);
    return { auto: true, budget: c.budget, used: null, resets: end };
  }
  const left = Math.max(0, c.budget - used);
  return { auto: left > 0, why: left > 0 ? null : 'budget', used, budget: c.budget, left, resets: end };
}

/** One tweet was handed to IFTTT. */
async function record(brand) {
  try { await db.addXPost(brand); }
  catch (e) { console.warn(`[x] ${brand}: could not record the tweet (${e.message})`); }
}

/** A link that opens X's composer with the caption and article link filled in.
 *  X counts a link as 23 characters and allows 280, so the caption is cut to
 *  fit; the whole address also stays under 2,000 characters, because Thaana
 *  takes six characters a letter once it is percent-encoded. */
function intent({ caption, url }) {
  const link = fullUrl(url);
  const cut = (s, n) => { const a = [...s]; return a.length > n ? a.slice(0, n - 1).join('').trimEnd() + '…' : s; };
  let text = cut(String(caption || '').trim(), link ? 250 : 275);
  const build = t => 'https://x.com/intent/post?text=' + encodeURIComponent(t) + (link ? '&url=' + encodeURIComponent(link) : '');
  let out = build(text);
  while (out.length > 2000 && [...text].length > 20) {
    text = cut(text, Math.floor([...text].length * 0.9));
    out = build(text);
  }
  return out;
}

module.exports = { config, cycle, status, record, intent };
