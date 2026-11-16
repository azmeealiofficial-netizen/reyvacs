// ─────────────────────────────────────────────────────────────────────────────
// relay/db.js — one row per source story, and the watcher's baselines
// ─────────────────────────────────────────────────────────────────────────────
// Every state change is a conditional UPDATE … WHERE status IN (…) RETURNING.
// That is the whole concurrency story: when the editor and Azmee tap Publish on
// the same draft in the same second, exactly one UPDATE matches and the other
// gets zero rows and is told "already being handled". No locks, no queue.
//
//   pending ──Rewrite──▶ writing ──ok──▶ drafted ──Publish──▶ publishing ──ok──▶ published
//      │                   └─fail─▶ pending   │  ▲                └─fail─▶ drafted
//      └─Skip─▶ skipped                        │  └──Redo (writing)
//                                              └─Drop─▶ dropped
//
// Share-only rows (mode 'share', relay/share.js) are a masthead's OWN stories,
// shared from that masthead's group with no rewrite: new ──card sent──▶ share.
// The same Dhuvas story can be both a relay row (rewritten for Newscast) and a
// share row (shared as Dhuvas), so uniqueness is (mode, brand, source_id).
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../db');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_items (
      id               SERIAL PRIMARY KEY,
      brand            VARCHAR(20)  NOT NULL,
      source_id        VARCHAR(40)  NOT NULL,
      source_url       TEXT         NOT NULL,
      source_title     TEXT,
      source_text      TEXT,
      source_image     TEXT,
      status           VARCHAR(20)  NOT NULL DEFAULT 'pending',
      card_msg_id      BIGINT,
      card_is_photo    BOOLEAN      NOT NULL DEFAULT false,
      draft_text       TEXT,
      draft_category   VARCHAR(80),
      draft_latin      TEXT,
      draft_msg_ids    JSONB        NOT NULL DEFAULT '[]',
      attempts         INTEGER      NOT NULL DEFAULT 0,
      decided_by       TEXT,
      newscast_url     TEXT,
      newscast_admin   TEXT,
      last_error       TEXT,
      created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      UNIQUE (brand, source_id)
    )`);
  // Added after the first deploy, hence ALTER rather than in CREATE above.
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS source_section VARCHAR(40)`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS newscast_section VARCHAR(40)`);
  // Social share from the group (relay/share.js).
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_caption TEXT`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_card BYTEA`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_msg_id BIGINT`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_channels JSONB NOT NULL DEFAULT '{}'`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_busy BOOLEAN NOT NULL DEFAULT false`);
  // Share-only mode (a masthead's own stories) and the chat each share card is in.
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS mode VARCHAR(10) NOT NULL DEFAULT 'relay'`);
  await pool.query(`ALTER TABLE relay_items ADD COLUMN IF NOT EXISTS share_chat_id BIGINT`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS relay_items_mode_brand_source ON relay_items (mode, brand, source_id)`);
  // The original UNIQUE (brand, source_id) would stop a Dhuvas story being both
  // a relay row and a share row. Dropped by shape rather than by name, so a
  // differently named constraint can't survive and break share inserts.
  await pool.query(`
    DO $$ DECLARE c text; BEGIN
      FOR c IN SELECT conname FROM pg_constraint
               WHERE conrelid = 'relay_items'::regclass AND contype = 'u' AND array_length(conkey, 1) = 2
      LOOP EXECUTE 'ALTER TABLE relay_items DROP CONSTRAINT ' || quote_ident(c); END LOOP;
    END $$`);
  // Share cards sent before share_chat_id existed are all in the Newscast group.
  const relayChat = (process.env.RELAY_CHAT_ID || '').trim();
  if (/^-?\d+$/.test(relayChat)) {
    await pool.query(`UPDATE relay_items SET share_chat_id=$1 WHERE share_msg_id IS NOT NULL AND share_chat_id IS NULL`, [Number(relayChat)]);
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS relay_items_status_idx ON relay_items (status, created_at DESC)`);
  // A post made from Creative Studio before the story's share card exists
  // (Creative Studio hears of a story from the Telegram channel within seconds;
  // the watcher's card can come a minute or two later). Kept here and applied
  // when the card is built — relay/share.js prepare().
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_early_posts (
      brand      VARCHAR(20) NOT NULL,
      url_key    TEXT        NOT NULL,
      channel    VARCHAR(20) NOT NULL,
      who        TEXT,
      via        TEXT,
      at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (brand, url_key, channel)
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS relay_state (
      brand        VARCHAR(20) PRIMARY KEY,
      baseline_id  BIGINT      NOT NULL,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

// ─── watcher baselines ───────────────────────────────────────────────────────
async function getBaseline(brand) {
  const { rows } = await pool.query('SELECT baseline_id FROM relay_state WHERE brand=$1', [brand]);
  return rows.length ? Number(rows[0].baseline_id) : null;
}
async function setBaseline(brand, id) {
  await pool.query(
    `INSERT INTO relay_state (brand, baseline_id) VALUES ($1,$2)
     ON CONFLICT (brand) DO UPDATE SET baseline_id=$2, updated_at=NOW()`, [brand, id]);
}
async function knownIds(brand, ids, mode = 'relay') {
  if (!ids.length) return new Set();
  const { rows } = await pool.query(
    'SELECT source_id FROM relay_items WHERE mode=$3 AND brand=$1 AND source_id = ANY($2::text[])',
    [brand, ids.map(String), mode]);
  return new Set(rows.map(r => r.source_id));
}

// ─── items ───────────────────────────────────────────────────────────────────
/** Insert a new source story. Returns the row, or null if we already had it. */
async function addItem({ brand, sourceId, url, title, text, image, section, mode = 'relay' }) {
  const { rows } = await pool.query(
    `INSERT INTO relay_items (brand, source_id, source_url, source_title, source_text, source_image, source_section, mode, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (mode, brand, source_id) DO NOTHING RETURNING *`,
    [brand, String(sourceId), url, title, text, image, section || null, mode, mode === 'share' ? 'new' : 'pending']);
  return rows[0] || null;
}

async function getBySource(brand, sourceId, mode = 'relay') {
  const { rows } = await pool.query('SELECT * FROM relay_items WHERE mode=$1 AND brand=$2 AND source_id=$3', [mode, brand, String(sourceId)]);
  return rows[0] || null;
}

async function get(id) {
  const { rows } = await pool.query('SELECT * FROM relay_items WHERE id=$1', [id]);
  return rows[0] || null;
}

/** Move id from one of `from` to `to`, setting extra columns. Null if the row wasn't in `from`. */
async function transition(id, from, to, set = {}) {
  const cols = Object.keys(set);
  const assigns = cols.map((c, i) => `${c}=$${i + 4}`);
  const { rows } = await pool.query(
    `UPDATE relay_items SET status=$2, updated_at=NOW()${assigns.length ? ', ' + assigns.join(', ') : ''}
     WHERE id=$1 AND status = ANY($3::text[]) RETURNING *`,
    [id, to, from, ...cols.map(c => set[c])]);
  return rows[0] || null;
}

async function update(id, set) {
  const cols = Object.keys(set);
  if (!cols.length) return get(id);
  const { rows } = await pool.query(
    `UPDATE relay_items SET ${cols.map((c, i) => `${c}=$${i + 2}`).join(', ')}, updated_at=NOW()
     WHERE id=$1 RETURNING *`, [id, ...cols.map(c => set[c])]);
  return rows[0] || null;
}

/** Message ids are only unique per chat, so the chat is part of the lookup. */
async function findByShareMessage(msgId, chatId) {
  const { rows } = await pool.query(
    'SELECT * FROM relay_items WHERE share_msg_id=$1 AND share_chat_id=$2 ORDER BY id DESC LIMIT 1',
    [Number(msgId), Number(chatId)]);
  return rows[0] || null;
}

// Same normalisation as Creative Studio's queue (cs/db.js URL_KEY_SQL), so
// "dhuvas.mv/304014" from there matches "https://dhuvas.mv/304014" here.
const urlKeySql = col => `rtrim(regexp_replace(regexp_replace(lower(${col}), '^https?://(www\\.)?', ''), '[?#].*$', ''), '/')`;
const urlKey = url => String(url || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');

/**
 * The share row for a story link: a masthead's own story (share mode), or for
 * brand 'newscast' a relay row by its Newscast link. Null if none.
 */
async function findShareByUrl(url, brand) {
  const key = urlKey(url);
  if (!key || !brand) return null;
  const { rows } = await pool.query(
    `SELECT * FROM relay_items WHERE
       (mode='share' AND brand=$2 AND ${urlKeySql('source_url')} = $1)
       OR ($2='newscast' AND mode='relay' AND newscast_url IS NOT NULL AND ${urlKeySql('newscast_url')} = $1)
     ORDER BY id DESC LIMIT 1`, [key, brand]);
  return rows[0] || null;
}

/** Remember a post made before the story had a share card. Old ones are pruned. */
async function addEarlyPost({ brand, url, channel, who, via }) {
  const key = urlKey(url);
  if (!key || !brand || !channel) return;
  await pool.query(`DELETE FROM relay_early_posts WHERE at < NOW() - interval '2 days'`);
  await pool.query(
    `INSERT INTO relay_early_posts (brand, url_key, channel, who, via) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (brand, url_key, channel) DO NOTHING`, [brand, key, channel, who || null, via || null]);
}

/** The early posts for a story link, removed as they are taken. */
async function takeEarlyPosts(url, brand) {
  const key = urlKey(url);
  if (!key || !brand) return [];
  const { rows } = await pool.query(
    `DELETE FROM relay_early_posts WHERE brand=$1 AND url_key=$2 AND at > NOW() - interval '2 days' RETURNING *`, [brand, key]);
  return rows;
}

/** Take the share lock. Null if a share for this story is already running. */
async function lockShare(id) {
  const { rows } = await pool.query('UPDATE relay_items SET share_busy=true WHERE id=$1 AND share_busy=false RETURNING *', [id]);
  return rows[0] || null;
}

async function findByDraftMessage(msgId) {
  const { rows } = await pool.query(
    `SELECT * FROM relay_items WHERE draft_msg_ids @> $1::jsonb ORDER BY id DESC LIMIT 1`,
    [JSON.stringify([Number(msgId)])]);
  return rows[0] || null;
}

/** Rows stuck mid-step after a restart (deploy while writing/publishing). */
async function stuck(olderThanMinutes) {
  const { rows } = await pool.query(
    `SELECT * FROM relay_items WHERE status IN ('writing','publishing')
     AND updated_at < NOW() - ($1 || ' minutes')::interval`, [String(olderThanMinutes)]);
  return rows;
}

async function stats(sinceHours = 24, mode = 'relay', brand = null) {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM relay_items
     WHERE created_at > NOW() - ($1 || ' hours')::interval AND mode=$2 AND ($3::text IS NULL OR brand=$3)
     GROUP BY status`, [String(sinceHours), mode, brand]);
  return Object.fromEntries(rows.map(r => [r.status, r.n]));
}

/** Share rows whose card never reached the group (Telegram down, card failed). */
async function unsentShares(maxAttempts = 3) {
  const { rows } = await pool.query(
    `SELECT * FROM relay_items WHERE mode='share' AND status='new' AND attempts < $1
     AND created_at > NOW() - interval '6 hours' ORDER BY id LIMIT 10`, [maxAttempts]);
  return rows;
}

module.exports = { init, getBaseline, setBaseline, knownIds, addItem, getBySource, get, transition, update, findByDraftMessage, findByShareMessage, findShareByUrl, addEarlyPost, takeEarlyPosts, lockShare, stuck, stats, unsentShares };
