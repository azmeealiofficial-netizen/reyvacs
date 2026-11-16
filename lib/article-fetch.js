// ─────────────────────────────────────────────────────────────────────────────
// lib/article-fetch.js — the one way this app fetches from the mastheads
// ─────────────────────────────────────────────────────────────────────────────
// dhuvas.mv, voice.mv and newscast.mv sit behind a WAF that refuses requests
// which claim to be a desktop browser. Creative Studio's poller sent a full
// Chrome impersonation — User-Agent, Sec-Ch-Ua, Sec-Fetch-*, Upgrade-Insecure-
// Requests — and got a flat 403 on every single call, while the super app's own
// scrapers fetched the same pages from the same container in the same second
// using nothing but an honest crawler UA. Claiming to be Chrome from a data
// centre is the thing that gets blocked; saying what you are does not.
//
// So there is one header set, here, and everything that talks to a masthead
// uses it. Do not "improve" this by adding browser headers back.
// ─────────────────────────────────────────────────────────────────────────────

const ARTICLE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; VxDSuperApp/1.0)',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9'
};

// Accept stays application/json even for article pages, because that is exactly
// what the working callers send and the origin ignores it. Pass an override only
// where it matters, e.g. { Accept: 'image/*' } for the CDN.
function articleFetchOpts(timeoutMs, extraHeaders) {
  return {
    headers: extraHeaders ? { ...ARTICLE_HEADERS, ...extraHeaders } : ARTICLE_HEADERS,
    signal: AbortSignal.timeout(timeoutMs || 30000)
  };
}

module.exports = { ARTICLE_HEADERS, articleFetchOpts };
