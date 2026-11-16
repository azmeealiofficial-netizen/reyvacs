// lib/local-fetcher.js — standalone stand-in.
// In VxD this routes masthead fetches through the office Dell when Cloudflare
// refuses the server. reyvaonline.com serves its API to servers without
// complaint, so here it is a plain fetch with the browser-like headers, and it
// mounts no routes (VxD's /api/fetcher/* endpoints do not exist in this app).
const { articleFetchOpts } = require('./article-fetch');

async function mastheadFetch(url, timeoutMs = 15000, extraHeaders) {
  return fetch(url, { ...articleFetchOpts(timeoutMs, extraHeaders), redirect: 'follow' });
}

module.exports = { mastheadFetch, mount() {}, PUBLIC_PATHS: [] };
