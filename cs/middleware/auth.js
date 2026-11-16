// ─────────────────────────────────────────────────────────────────────────────
// cs/middleware/auth.js — Creative Studio's gate
// ─────────────────────────────────────────────────────────────────────────────
// Creative Studio had no user accounts at all. Its only gate was a lock code on
// the Settings panel; /api/ai/* — which spends Anthropic credit on every call —
// was open to anyone who found the URL.
//
// It now rides on the host app's session, and access is granted per employee
// per masthead: a cs_profiles row lists the brands that person may work on. No
// row, or no brands, means no access at all — there is no default and no admin
// bypass, so an unassigned superadmin sees nothing.
//
// The brand list is not decoration. It gates the queue, every share destination
// and article fetching, because the failure it prevents is someone posting to
// the wrong masthead — which is a published mistake under someone else's name,
// not merely a permissions slip.
//
// The vxd_sid cookie added in the dhivehi-studio merge is what makes this free:
// Creative Studio's SPA is cookie-based, so it needs no token plumbing.
// ─────────────────────────────────────────────────────────────────────────────

// Reyva: ../../auth-core is the standalone stand-in — open access, every
// visitor is the one studio user with the 'reyva' masthead.
const auth = require('../../auth-core');

async function attachUser(req, res, next) {
  try {
    req.vsaUser = await auth.resolveSession(req);
  } catch (err) {
    console.error('[cs] session lookup failed:', err.message);
    req.vsaUser = null;
  }
  next();
}

// req.path is relative to the innermost mount, so /cs/api/ai/card arrives here
// as /api/ai/card. originalUrl is the one to test against — reading req.path
// instead is what sent every Studio XHR a 302 to the login page during the last
// merge, and the SPA got HTML where it expected JSON.
function wantsJson(req) {
  const full = (req.originalUrl || '').split('?')[0];
  return req.xhr
    || full.includes('/api/')
    || req.headers.accept?.includes('application/json');
}

function brandsOf(req) {
  return (req.vsaUser && req.vsaUser.cs && req.vsaUser.cs.brands) || [];
}

function requireAuth(req, res, next) {
  if (!req.vsaUser) {
    if (wantsJson(req)) return res.status(401).json({ error: 'Not authenticated' });
    return res.status(401).send('Not authenticated');
  }
  // Telling someone to log in when they are already logged in is how an
  // afternoon disappears, so these two are deliberately distinguishable.
  if (!brandsOf(req).length) {
    return res.status(403).json({
      error: 'This account has no Creative Studio access.',
      code: 'no_brands'
    });
  }
  next();
}

// Anything carrying a brand — sharing to Telegram, X or Viber, generating a
// caption, acting on a queue item — must be checked against the grant. The
// client hides what you cannot use, but the client is not the gate.
function requireBrand(req, res, brand) {
  if (!brand) { res.status(400).json({ error: 'Missing brand' }); return false; }
  if (!brandsOf(req).includes(brand)) {
    res.status(403).json({ error: `You do not have access to ${String(brand).toUpperCase()}` });
    return false;
  }
  return true;
}

module.exports = { attachUser, requireAuth, requireBrand, brandsOf, wantsJson };
