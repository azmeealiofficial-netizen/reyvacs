/* VxD Creative Studio — tolerant HTML attribute extraction
 *
 * Why this exists
 * ---------------
 * Fanvaiy emits share-link markup with UNESCAPED double quotes inside the
 * title attribute, because headlines routinely contain them:
 *
 *   <a title="... މަނަވަރު "ޢިމާދުއްދީން" ހިދުމަތަށް ނެރެފި" target="_blank">
 *
 * A naive  /title="([^"]*)"/  stops at the first inner quote and silently
 * truncates the headline — no error, just a short title. That is the
 * "ޢިމާދުއްދީން" bug.
 *
 * The fix: a quote only terminates the attribute when what follows it is the
 * end of the tag, or the start of another attribute. Anything else is a quote
 * that belongs to the headline.
 *
 * These helpers return RAW (still entity-encoded) values. Callers keep their
 * own ent() decoding, so entity handling is unchanged.
 */

'use strict';

// A quote closes the attribute only if followed by `>` / `/>` …
const TAG_END = /^\s*\/?>/;
// … or by whitespace and another attribute name plus `=`.
const NEXT_ATTR = /^\s+[a-zA-Z_:][-a-zA-Z0-9_:.]*\s*=/;

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every value of the named attribute, in document order.
 * Tolerates unescaped quotes of the same kind inside the value.
 *
 * @param {string} html
 * @param {string} name       attribute name, e.g. 'title' or 'content'
 * @param {{limit?: number}} [opts]
 * @returns {string[]} raw, undecoded values
 */
function attrValues(html, name, opts) {
  const limit = (opts && opts.limit) || 50;
  const out = [];
  if (!html || !name) return out;

  // Require a boundary before the name so `title` never matches `data-title`.
  const open = new RegExp('(?:^|[\\s"\'/])' + escapeRe(name) + '\\s*=\\s*(["\'])', 'gi');

  let m;
  while (out.length < limit && (m = open.exec(html)) !== null) {
    const quote = m[1];
    const start = m.index + m[0].length;

    let end = -1;
    let i = start;
    while (i < html.length) {
      const j = html.indexOf(quote, i);
      if (j === -1) break;
      const after = html.slice(j + 1, j + 64);
      if (TAG_END.test(after) || NEXT_ATTR.test(after)) { end = j; break; }
      i = j + 1; // an inner, unescaped quote — keep going
    }

    // No convincing terminator found: fall back to the old, conservative
    // behaviour rather than swallowing the rest of the document.
    if (end === -1) {
      end = html.indexOf(quote, start);
      if (end === -1) break;
    }

    out.push(html.slice(start, end));
    open.lastIndex = end + 1;
  }
  return out;
}

/**
 * First value of the named attribute that satisfies `test`.
 * @returns {string} raw value, or '' when nothing matches
 */
function firstAttrValue(html, name, test) {
  const vals = attrValues(html, name);
  for (const v of vals) {
    if (!test || test(v)) return v;
  }
  return '';
}

/**
 * content="…" of the <meta> tag carrying property/name === `property`.
 * Anchors on the tag rather than on attribute order, so it works whether
 * content comes before or after property.
 * @returns {string} raw value, or ''
 */
function metaContent(html, property) {
  if (!html) return '';
  const key = new RegExp(
    '(?:property|name)\\s*=\\s*["\']' + escapeRe(property) + '["\']', 'i'
  );
  const hit = key.exec(html);
  if (!hit) return '';
  const tagStart = html.lastIndexOf('<meta', hit.index);
  if (tagStart === -1) return '';
  const vals = attrValues(html.slice(tagStart, tagStart + 4000), 'content', { limit: 1 });
  return vals.length ? vals[0] : '';
}

module.exports = { attrValues, firstAttrValue, metaContent };
