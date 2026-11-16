// ─────────────────────────────────────────────────────────────────────────────
// lib/reyva-article.js — read a Reyva Online article
// ─────────────────────────────────────────────────────────────────────────────
// reyvaonline.com is a Next.js front end that renders articles client-side
// ("Loading" is all the HTML holds), so VxD's Fanvaiy HTML scraper finds
// nothing there. The site's own JSON API is the source instead:
//
//   GET https://reyvaonline.com/api/articles/<id>?lang=dv
//     → { article: { title, latinTitle, excerpt, body: [blocks], coverImage,
//                    categories: { nameDv, slug } … }, related: […] }
//
// Article links come in two shapes and both carry the same id:
//   reyvaonline.com/article/3538   (what the site links to)
//   reyvaonline.com/news/3538      (what Reyva prints on its cards)
// ─────────────────────────────────────────────────────────────────────────────

const { articleFetchOpts } = require('./article-fetch');

const SITE = 'reyvaonline.com';
const API = 'https://' + SITE + '/api/articles/';

/** Article id from any Reyva link, or null. */
function articleId(url) {
  const m = String(url || '').match(/reyvaonline\.com\/(?:article|news)\/(\d+)/i);
  return m ? m[1] : null;
}

/** The link as Reyva prints it on cards: reyvaonline.com/news/<id>. */
function cardUrl(id) { return SITE + '/news/' + id; }

/* Strapi rich-text blocks → plain paragraphs. Paragraph, heading, quote and
 * list blocks all carry text in nested `children`; images and embeds don't. */
function blockText(node) {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  return (node.children || []).map(blockText).join('');
}
function bodyText(blocks) {
  const out = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (b.type === 'list') {
      for (const li of b.children || []) { const t = blockText(li).trim(); if (t) out.push('• ' + t); }
      continue;
    }
    const t = blockText(b).replace(/\s+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out.join('\n\n');
}

/* Largest rendition first: the original upload is what a 1080-wide card needs. */
function imageUrls(a) {
  const img = a.coverImage || a.seoImage || a.thumbnailImage;
  if (!img) return [];
  const f = img.formats || {};
  return [img.url, f.large && f.large.url, f.medium && f.medium.url].filter(Boolean);
}

/**
 * { article, why } — article is null on failure and `why` says why, in the
 * same shape VxD's fanvaiy-article.readArticle uses so callers read alike.
 */
async function readArticle(url) {
  const id = articleId(url);
  if (!id) return { article: null, why: 'not a reyvaonline.com article link' };
  let r;
  try { r = await fetch(API + id + '?lang=dv', articleFetchOpts(15000, { Accept: 'application/json' })); }
  catch (e) { return { article: null, why: /abort|timeout/i.test(e.name + e.message) ? 'timed out' : e.message }; }
  if (!r.ok) return { article: null, why: 'HTTP ' + r.status + (r.status === 404 ? ' (not published yet?)' : ''), status: r.status };
  let d;
  try { d = await r.json(); } catch { return { article: null, why: 'API did not return JSON' }; }
  const a = d && d.article;
  if (!a || !a.title) return { article: null, why: 'article has no headline' };
  const cat = a.categories && !Array.isArray(a.categories) ? a.categories : (Array.isArray(a.categories) ? a.categories[0] : null);
  const imgs = imageUrls(a);
  return {
    article: {
      id,
      title: String(a.title).trim(),
      text: bodyText(a.body).substring(0, 8000),
      imageUrl: imgs[0] || '',
      imageUrls: imgs,
      // VxD's queue stores a "section" per article (it picks the Voice Sports
      // card). For Reyva it carries the Dhivehi category name for the card label.
      section: cat ? (cat.nameDv || cat.name || null) : null,
      url: cardUrl(id)
    },
    why: null
  };
}

async function fetchArticle(url) { return (await readArticle(url)).article; }

/* Kept for the queue code path that VxD wrote against fanvaiy-article. */
function parseSection() { return null; }

module.exports = { readArticle, fetchArticle, articleId, cardUrl, bodyText, parseSection, SITE };
