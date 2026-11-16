/* routes/x.js — Publish to X via IFTTT webhook
 *
 * A thin wrapper over postX in lib/publishers.js, the same sender the Telegram
 * share cards use, so both paths draw on one monthly tweet count
 * (lib/x-budget.js).
 *
 * Two answers that are not errors:
 *   { ok: true }                             handed to IFTTT
 *   { ok: true, manual: true, intentUrl }    the month's IFTTT allowance is
 *                                            spent — nothing was sent; the page
 *                                            opens intentUrl so it is posted
 *                                            by hand, link and all, for free.
 */
const router = require('../../lib/async-router')();

const { postX } = require('../lib/publishers');

router.post('/publish', async (req, res) => {
  try {
    const { headline, articleUrl, brand } = req.body;
    if (!brand) return res.status(400).json({ error: 'Missing brand' });
    const r = await postX({ brand, caption: headline, url: articleUrl });
    res.json(r);
  } catch (err) {
    if (err.manual) {
      // Not posted yet, so the story's share card must not be ticked for X.
      res.locals.xManual = true;
      return res.json({ ok: true, manual: true, intentUrl: err.intentUrl, message: err.message });
    }
    console.error('[x] Publish error:', err.message);
    res.status(err.status || 500).json({ error: 'X publish failed: ' + err.message });
  }
});

module.exports = router;
