// ─────────────────────────────────────────────────────────────────────────────
// relay/watcher.js — notice new Reyva Online stories
// ─────────────────────────────────────────────────────────────────────────────
// REYVA FORK. VxD's watcher scans Fanvaiy homepages for numeric ids. Reyva's
// site has a JSON list of its newest stories, so this reads that:
//
//   GET https://reyvaonline.com/api/articles?lang=dv&pageSize=20
//     → { articles: [{ id, slug, title, link, pubDate, category, image }, …] }
//
// New = published after the baseline AND not carded yet. The baseline is the
// newest pubDate seen (epoch ms, relay_state key 'share:reyva') — like VxD's
// feed.js for maldivesvoice.mv, and for the same reason: ids are not publish
// order, so a story drafted early and published late would slip under an id
// high-water mark. The first tick only records the baseline; cards start with
// the next story, so switching the desk on doesn't flood the group.
// ─────────────────────────────────────────────────────────────────────────────

const db = require('./db');
const reyva = require('../lib/reyva-article');
const { articleFetchOpts } = require('../lib/article-fetch');

const BRAND = 'reyva';
const KEY = 'share:reyva';
const LIST = 'https://reyvaonline.com/api/articles?lang=dv&pageSize=20';

async function latest() {
  const r = await fetch(LIST, articleFetchOpts(15000, { Accept: 'application/json' }));
  if (!r.ok) throw new Error('article list HTTP ' + r.status);
  const d = await r.json();
  return (d.articles || [])
    .map(a => ({ id: String(a.slug || a.id), at: Date.parse(a.pubDate) }))
    .filter(a => /^\d+$/.test(a.id) && Number.isFinite(a.at));
}

/** Read one story and add it as a share row. Returns the row (null if it raced in). */
async function addStory(id) {
  const { article, why } = await reyva.readArticle(reyva.cardUrl(id));
  if (!article) throw new Error(`#${id}: ${why}`);
  return db.addItem({
    mode: 'share', brand: BRAND, sourceId: id,
    url: 'https://' + reyva.cardUrl(id),          // https://reyvaonline.com/news/<id>
    title: article.title, text: article.text, image: article.imageUrl || null, section: article.section
  });
}

/**
 * One check. watchers = [{ mode: 'share', onNew }] (VxD's shape); onNew(item)
 * is called for each new story, oldest first.
 */
async function tick(watchers) {
  const w = (watchers || []).find(x => x.mode === 'share');
  if (!w) return 'no share watcher';
  const list = await latest();
  if (!list.length) return 'reyva: empty list';
  const newest = Math.max(...list.map(a => a.at));
  const baseline = await db.getBaseline(KEY);
  if (baseline == null) {
    await db.setBaseline(KEY, newest);
    return `reyva: baseline set (${new Date(newest).toISOString()}) — cards start with the next story`;
  }
  const fresh = list.filter(a => a.at > baseline).sort((a, b) => a.at - b.at);
  const known = await db.knownIds(BRAND, fresh.map(a => a.id), 'share');
  let added = 0, high = baseline;
  for (const a of fresh) {
    if (!known.has(a.id)) {
      try {
        const item = await addStory(a.id);
        if (item) { added++; try { await w.onNew(item); } catch (e) { console.error(`[relay] share #${item.id} failed:`, e.message); } }
      } catch (e) {
        // Leave the baseline below this story so the next tick tries it again.
        console.warn('[relay/watcher]', e.message);
        break;
      }
    }
    high = Math.max(high, a.at);
  }
  if (high > baseline) await db.setBaseline(KEY, high);
  return `reyva: ${list.length} listed, ${fresh.length} new, ${added} carded`;
}

/** /pull <link>: a row for one story now, whatever its age. */
async function pullUrl(url, { mode = 'share' } = {}) {
  const id = reyva.articleId(url);
  if (!id) throw new Error('That is not a reyvaonline.com article link (…/article/<id> or …/news/<id>).');
  const had = await db.getBySource(BRAND, id, mode);
  if (had) return { item: had, existing: true };
  const item = await addStory(id);
  return { item: item || await db.getBySource(BRAND, id, mode), existing: !item };
}

module.exports = { tick, pullUrl, latest };
