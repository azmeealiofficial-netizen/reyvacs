// ─────────────────────────────────────────────────────────────────────────────
// server.js — Reyva Creative Studio
// ─────────────────────────────────────────────────────────────────────────────
// A standalone copy of VxD Super App's Creative Studio (its cs/ module), for
// Reyva Online (reyvaonline.com). cs/ and lib/ keep VxD's layout so fixes can
// be carried across by diff; this file stands in for VxD's server.js, which
// mounted cs/ at /cs among a dozen other apps. Here it is the whole site.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const path = require('path');
const cs = require('./cs');
const relay = require('./relay');   // Telegram share desk (relay/index.js)

const app = express();
const PORT = process.env.PORT || 3000;

// Behind the home server's reverse proxy: trust it for req.ip / req.protocol.
app.set('trust proxy', 1);

// Reels arrive as base64 in JSON, so the body limit is large (VxD: 100mb on /cs).
app.use(express.json({ limit: '100mb' }));

app.get('/health', (req, res) => res.json({ ok: true }));

// Privacy policy — needed for the Facebook app review (kept from the original
// reyvacs placeholder site).
app.get(['/privacy', '/privacy-policy', '/data-deletion'], (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'privacy.html')));

// Telegram share desk webhook — before the studio, whose SPA fallback is a catch-all.
app.use('/relay', relay.router);

app.use('/', cs.router);

(async () => {
  try {
    await cs.init();
    await relay.init();
  } catch (e) {
    console.error('[boot] database init failed:', e.message);
    process.exit(1);
  }
  app.listen(PORT, () => {
    console.log(`Reyva Creative Studio on :${PORT}`);
    cs.startJobs();
    relay.startJobs();
  });
})();
