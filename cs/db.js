// ─────────────────────────────────────────────────────────────────────────────
// cs/db.js — Creative Studio's data layer
// ─────────────────────────────────────────────────────────────────────────────
// Rewired onto the host app's single pool (../db). Creative Studio used to open
// its own, against its own database.
//
// Every table is prefixed cs_, and the rename is not cosmetic. Creative Studio's
// `settings` was (key TEXT, value TEXT); VSA's is (key VARCHAR, value TEXT) —
// close enough that CREATE TABLE IF NOT EXISTS would have silently no-opped,
// after which this module would have been writing lock_code and guidelines into
// the very table that holds VSA's telegram_bot_token and smtp_pass. No error,
// no warning; it would simply have half-worked.
//
// There are still no migrations in this codebase. These CREATE statements are
// authoritative on a fresh database and inert on an existing one, so a column
// added later needs a guarded ALTER as well as an edit here.
// ─────────────────────────────────────────────────────────────────────────────

const { pool } = require('../db');

// Reyva: from the environment, not VxD's hard-coded code — a copy of the
// studio should not open its Settings with another newsroom's code.
const DEFAULT_LOCK_CODE = (process.env.CS_LOCK_CODE || '').trim() || '0000';

async function init() {
  const client = await pool.connect();
  try {
    /* Who may use Creative Studio, and for which mastheads.
     *
     * A row here is the grant, exactly as studio_profiles is for /studio — and
     * for the same reason the two are separate tables rather than one: a
     * studio_profiles row carries an uncapped AI budget, so assigning someone a
     * Creative Studio brand must not be capable of handing them that.
     *
     * No row, or an empty brands array, means no access. Never LEFT JOIN a
     * default set of brands into existence here; the whole point is that access
     * is granted deliberately, one person at a time.
     *
     * There is no admin bypass. A superadmin with no row sees nothing, which is
     * survivable because the assignment UI lives in /admin, gated on the VxD
     * role — so it is not possible to lock yourself out of granting access. */
    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_profiles (
        -- REYVA: no VxD employees table here. Unused while the studio is open;
        -- kept for the login layer, which will add its own users table.
        employee_id VARCHAR(50) PRIMARY KEY,
        brands      TEXT[] NOT NULL DEFAULT '{}',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // No fb_* columns: Facebook publishing did not come across with the merge.
    // The standalone app carried thirteen of them plus a guarded ALTER block; all
    // of it was write-only by then. `status` is still 'pending' | 'done' |
    // 'skipped', which is what the queue UI actually sets.
    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_articles (
        id SERIAL PRIMARY KEY,
        url TEXT NOT NULL UNIQUE,
        brand TEXT NOT NULL,
        title TEXT,
        text TEXT,
        image_url TEXT,
        status TEXT DEFAULT 'pending',
        telegram_msg_id TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // Set when the story was shared from a relay Telegram group (relay/share.js):
    // "Facebook, Telegram · Azmee · 14:32". The queue shows it so the same story
    // isn't posted twice from here.
    await client.query(`ALTER TABLE cs_articles ADD COLUMN IF NOT EXISTS shared_note TEXT`);
    // The masthead's own section slug ("sport", "world", …) as the article page
    // states it. Voice Sports stories load into the studio on the sports card.
    await client.query(`ALTER TABLE cs_articles ADD COLUMN IF NOT EXISTS section TEXT`);


    /* Short-lived public image hosting for Viber.
     * Viber's Channels Post API will not accept an upload — it fetches `media`
     * from a public URL ending in .jpeg. Rows live in Postgres rather than on
     * disk because Railway containers restart and a file would vanish mid-fetch.
     * Deliberately excluded from createBackup(): an hour-lived buffer of image
     * bytes would bloat every backup for nothing. */
    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_media (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    /* One row per tweet handed to IFTTT. IFTTT answers 200 with no credits
     * left, so the only way to know a brand's monthly allowance is spent is to
     * count here — see lib/x-budget.js. */
    await client.query(`
      CREATE TABLE IF NOT EXISTS cs_x_posts (
        id SERIAL PRIMARY KEY,
        brand TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS cs_x_posts_brand_at ON cs_x_posts (brand, created_at)`);

    await client.query(`
      INSERT INTO cs_settings (key, value)
      VALUES ('lock_code', $1)
      ON CONFLICT (key) DO NOTHING
    `, [DEFAULT_LOCK_CODE]);

    console.log('cs: tables ready');
  } finally {
    client.release();
  }
}

async function addArticle(url, brand, title, text, imageUrl, telegramMsgId, section) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO cs_articles (url, brand, title, text, image_url, telegram_msg_id, section)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (url) DO NOTHING
       RETURNING id`,
      [url, brand, title || '', text || '', imageUrl || '', telegramMsgId || '', section || null]
    );
    return rows.length ? rows[0].id : null; // null = already exists
  } catch (e) { console.error('[cs/db] addArticle error:', e.message); return null; }
}

// Always brand-scoped. An empty list returns nothing rather than everything —
// getting that fallback backwards would show every masthead's queue to someone
// with no grant at all, which is the exact failure this table exists to prevent.
async function getPendingArticles(brands) {
  const list = Array.isArray(brands) ? brands.filter(Boolean) : [];
  if (!list.length) return [];
  const { rows } = await pool.query(
    `SELECT * FROM cs_articles
      WHERE status = 'pending' AND brand = ANY($1)
      ORDER BY created_at DESC LIMIT 20`,
    [list]
  );
  return rows;
}

// Used to check a queue action against the caller's brands. Ids are sequential
// and therefore guessable, so this reads the row's own brand rather than
// trusting that the item was ever shown to this person.
async function getArticleBrand(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return null;
  const { rows } = await pool.query('SELECT brand FROM cs_articles WHERE id = $1', [n]);
  return rows.length ? rows[0].brand : null;
}

async function markArticle(id, status) {
  await pool.query('UPDATE cs_articles SET status = $1 WHERE id = $2', [status, id]);
}

/* Queue rows are keyed by whatever link was posted in the channel, so compare
 * links without scheme, www, query or trailing slash: https://www.dhuvas.mv/1/
 * and http://dhuvas.mv/1?x=y are the same story. */
const URL_KEY_SQL = `rtrim(regexp_replace(regexp_replace(lower(url), '^https?://(www\\.)?', ''), '[?#].*$', ''), '/')`;
function urlKey(url) {
  return String(url || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/** The queue row for a story link, or null. */
async function articleByUrl(url) {
  const key = urlKey(url);
  if (!key) return null;
  const { rows } = await pool.query(`SELECT id, status, shared_note FROM cs_articles WHERE ${URL_KEY_SQL} = $1 ORDER BY id DESC LIMIT 1`, [key]);
  return rows[0] || null;
}

/** Record that a story was shared from a relay group. Leaves status alone. */
async function noteShared(url, note) {
  const key = urlKey(url);
  if (!key) return;
  await pool.query(`UPDATE cs_articles SET shared_note = $1 WHERE ${URL_KEY_SQL} = $2`, [String(note).slice(0, 300), key]);
}

async function get(key) {
  const { rows } = await pool.query('SELECT value FROM cs_settings WHERE key = $1', [key]);
  return rows.length ? rows[0].value : null;
}

async function set(key, value) {
  await pool.query(`
    INSERT INTO cs_settings (key, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, value]);
}

async function getAll() {
  const { rows } = await pool.query('SELECT key, value FROM cs_settings');
  const obj = {};
  rows.forEach(r => { obj[r.key] = r.value; });
  return obj;
}

async function getLockCode() {
  return (await get('lock_code')) || DEFAULT_LOCK_CODE;
}

/* ── Short-lived media for Viber ── */
async function putMedia(id, mime, buffer) {
  await pool.query(
    'INSERT INTO cs_media (id, mime, bytes) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING',
    [id, mime, buffer]
  );
  return id;
}

async function getMedia(id) {
  const { rows } = await pool.query('SELECT mime, bytes FROM cs_media WHERE id = $1', [id]);
  return rows.length ? rows[0] : null;
}

/* Viber fetches the URL within seconds of the post, so anything older than an
 * hour has done its job. Called opportunistically on write rather than on a
 * timer. */
async function purgeMedia(maxAgeMinutes) {
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM cs_media WHERE created_at < NOW() - ($1 || ' minutes')::interval`,
      [String(maxAgeMinutes || 60)]
    );
    if (rowCount) console.log(`[cs/db] purged ${rowCount} expired media row(s)`);
  } catch (e) { console.error('[cs/db] purgeMedia error:', e.message); }
}

/* ── Tweets handed to IFTTT (lib/x-budget.js) ── */
async function addXPost(brand) {
  await pool.query('INSERT INTO cs_x_posts (brand) VALUES ($1)', [brand]);
}

async function xPostCount(brand, since) {
  const { rows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM cs_x_posts WHERE brand = $1 AND created_at >= $2', [brand, since]);
  return rows[0].n;
}

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query, init, get, set, getAll, getLockCode, addArticle, getPendingArticles, getArticleBrand, markArticle,
                   articleByUrl, noteShared, putMedia, getMedia, purgeMedia, addXPost, xPostCount };
