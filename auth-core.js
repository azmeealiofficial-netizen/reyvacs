// ─────────────────────────────────────────────────────────────────────────────
// auth-core.js — standalone stand-in for VxD Super App's auth-core
// ─────────────────────────────────────────────────────────────────────────────
// cs/ was lifted out of the super app, where it rode on VxD staff sessions.
// Reyva's studio is open for now (Azmee, 2026-11-16: "leave login open, we will
// add that layer later"). Keeping the module name and the two functions cs/
// calls means the login layer can be added here later without touching cs/.
//
// Every visitor is the one studio user, granted the one masthead.
// ─────────────────────────────────────────────────────────────────────────────

const STUDIO_USER = Object.freeze({
  id: 0, name: 'Reyva Studio', username: 'reyva',
  cs: { brands: ['reyva'] }
});

async function resolveSession(_req) { return STUDIO_USER; }

function readCookie(req, name) {
  const raw = (req.headers && req.headers.cookie) || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

module.exports = { resolveSession, readCookie, STUDIO_USER };
