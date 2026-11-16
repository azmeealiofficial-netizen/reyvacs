// ─────────────────────────────────────────────────────────────────────────────
// lib/async-router.js
// ─────────────────────────────────────────────────────────────────────────────
// Studio was written for Express 5, which catches a rejected promise from an
// async route handler and forwards it to the error middleware. The host app runs
// Express 4, which does not: the rejection escapes, the response is never
// written, and the request hangs until the client times out. There is no log
// line, because nothing threw synchronously.
//
// studio/routes/api.js has 21 handlers that await outside any try/catch, so this is not
// theoretical — one Postgres blip would hang a page. Patching the verbs once,
// here, beats wrapping 21 call sites by hand and hoping nobody adds a 22nd.
//
// Handlers with four arguments are Express error middleware and are left alone.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');

const VERBS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'all'];

function wrapHandler(h) {
  if (typeof h !== 'function' || h.length >= 4) return h;
  const wrapped = function (req, res, next) {
    try {
      return Promise.resolve(h.call(this, req, res, next)).catch(next);
    } catch (err) {
      return next(err);
    }
  };
  Object.defineProperty(wrapped, 'name', { value: h.name || 'anonymous' });
  return wrapped;
}

module.exports = function asyncRouter(opts) {
  const router = express.Router(opts);
  for (const verb of VERBS) {
    const orig = router[verb].bind(router);
    router[verb] = function (path, ...handlers) {
      return orig(path, ...handlers.map(wrapHandler));
    };
  }
  return router;
};
