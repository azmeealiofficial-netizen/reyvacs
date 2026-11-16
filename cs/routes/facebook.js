/* routes/facebook.js — Creative Studio's 📘 Facebook button
 *
 * A thin wrapper: the Graph API work lives in lib/publishers.js (postFacebook,
 * checkFacebook), shared with the Newscast relay's Telegram share. Setup notes
 * are in lib/share-targets.js (facebookTarget) and relay/README.md.
 */

const router = require('../../lib/async-router')();
const { postFacebook, checkFacebook } = require('../lib/publishers');

/* Setup check: is the token a working Page token for the configured Page? */
router.post('/check', async (req, res) => {
  try { res.json(await checkFacebook(req.body.brand)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

/* Post the card. Body: { caption, articleUrl, imageBase64 (JPEG/PNG data URL), brand } */
router.post('/share', async (req, res) => {
  const { caption, articleUrl, imageBase64, brand } = req.body;
  if (!brand) return res.status(400).json({ error: 'Missing brand' });
  if (!imageBase64) return res.status(400).json({ error: 'No card image' });
  const m = /^data:(image\/(?:jpe?g|png));base64,(.+)$/i.exec(imageBase64);
  if (!m) return res.status(400).json({ error: 'Card must be a JPEG or PNG data URL' });
  try {
    res.json(await postFacebook({ brand, caption, url: articleUrl, image: Buffer.from(m[2], 'base64'), mime: m[1].toLowerCase() }));
  } catch (e) {
    console.error(`[facebook] ${brand}: share failed:`, e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

module.exports = router;
