// db.js — the one Postgres pool (same shape as VxD Super App's db.js, which
// cs/db.js requires as '../db').
//
// Different from VxD on one point: SSL. VxD turns it on whenever NODE_ENV is
// production, because Railway's Postgres needs it. On the home server the
// database is a sibling container on a private Docker network that does not
// speak TLS, so SSL is opt-in: DATABASE_SSL=1, or sslmode= in the URL.
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: (process.env.DATABASE_SSL === '1' || (DATABASE_URL || '').includes('sslmode='))
    ? { rejectUnauthorized: false }
    : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

// An idle-connection error is otherwise an unhandled 'error' event that takes
// the process down.
pool.on('error', (err) => console.error('PostgreSQL pool error:', err.message));

module.exports = { pool };
