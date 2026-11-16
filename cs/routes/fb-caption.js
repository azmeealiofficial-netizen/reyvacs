/* routes/fb-caption.js — Generate varied Facebook captions in Thaana
   Rotates between 4 styles, respects editorial guidelines, NO links/hashtags */
const express = require('express');
const router = require('../../lib/async-router')();
const Anthropic = require('@anthropic-ai/sdk').default;
const db = require('../db');
const { langOf } = require('../lib/share-targets');

// Constructed per request, not at require time. `new Anthropic()` with no args
// reads ANTHROPIC_API_KEY — the one variable this service must not define, or
// /studio loses the ability to edit its key from its own Settings UI. Building
// it at module load also meant a missing key took the whole app down at boot
// instead of failing one request.
function anthropic(overrideKey) {
  const apiKey = overrideKey || process.env.CS_ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('CS_ANTHROPIC_API_KEY not configured'); e.status = 500; throw e; }
  return new Anthropic({ apiKey });
}

const STYLES = ['key_detail', 'summary_short', 'context_angle'];

const STYLE_INSTRUCTIONS = {
  key_detail: 'State the single most important fact.',
  summary_short: 'Say what happened in simplest terms.',
  context_angle: 'Say what happened and one reason it matters.',
};

/* Caption register per outlet. This was an inline `brand === 'voice' ? ... : ...`
 * ternary, which silently gave every future brand voice's fallback.
 * TODO(Azmee): 'accessible' for newscast is a placeholder — set it deliberately.
 * voice_en inherits VOICE's register; change it here if the English edition is
 * meant to read differently from the Dhivehi one. */
const BRAND_TONE = { dhuvas: 'accessible', voice: 'formal', newscast: 'accessible', voice_en: 'formal' };

/* ─── Fact guard ───
 * A caption once said "އޭނާ މިހާރު ވަނީ ހައްޔަރުކޮށްފައި" on a story where police
 * were only looking into the case. The prompt forbids that, but a prompt is not
 * a guarantee, so the caption is checked against the article before it leaves.
 * Each entry is a stem: if the caption contains it and the headline + full body
 * do not, the caption added a claim. Stems, not words, so suffixes still match
 * (ހައްޔަރު → ހައްޔަރުކޮށްފި, ހައްޔަރުކުރި, ...). */
const RISKY_TERMS = [
  // arrest / custody / prosecution / sentence
  'ހައްޔަރު', 'ބަންދުކޮށް', 'ބަންދުގައި', 'ބަންދަށް', 'ދައުވާ', 'ހުކުމް', 'ޖަލަށް', 'ޖަލުގައި',
  'ކުށްވެރިކޮށް', 'ކުށްވެރިވެ', 'ތުހުމަތު',
  // death / injury
  'މަރުވި', 'މަރުވެ', 'މަރާލ', 'ޝަހީދު', 'ޒަޚަމް', 'ތަދުވި',
  // office
  'އިސްތިއުފާ', 'ވަކިކޮށް', 'ވަކިކުރި',
  // English captions (voice_en)
  'arrest', 'detain', 'custody', 'remand', 'charged', 'prosecut', 'convict', 'sentenced', 'jail', 'prison',
  'died', 'killed', 'death', 'injur', 'resign', 'dismiss', 'sacked', 'accused',
];
// ޙ/ހ and ޢ/އ are spelled both ways in Maldivian copy (ދަޢުވާ / ދައުވާ,
// ޙުކުމް / ހުކުމް), so both sides are folded before comparing.
const fold = s => String(s || '').toLowerCase()
  .replace(/\u0799/g, '\u0780').replace(/\u07A2/g, '\u0787')
  .replace(/[\u200B-\u200D\uFEFF]/g, '');
const numbersIn = s => (String(s || '').replace(/(\d),(\d)/g, '$1$2').match(/\d+(\.\d+)?/g) || []);

function unsupportedClaims(caption, headline, bodyText) {
  const cap = fold(caption);
  const src = fold(`${headline}\n${bodyText || ''}`);
  const terms = RISKY_TERMS.filter(t => cap.includes(fold(t)) && !src.includes(fold(t)));
  const srcNums = new Set(numbersIn(src));
  const nums = numbersIn(cap).filter(n => !srcNums.has(n));
  return [...terms, ...nums];
}

const sumUsage = (u = {}, v = {}) => {
  const add = k => (u[k] || 0) + (v[k] || 0);
  return { input_tokens: add('input_tokens'), output_tokens: add('output_tokens'),
    cache_creation_input_tokens: add('cache_creation_input_tokens'), cache_read_input_tokens: add('cache_read_input_tokens'), retried: true };
};

/* The generator itself, callable without a request: the Newscast relay writes
 * the caption for its Telegram share card with exactly this. Throws with
 * .status set; the route below turns that into the same JSON errors as before. */
async function generateCaption({ headline, bodyText, brand, style, model, apiKey, _retry, _avoid }) {
    if (!headline) { const e = new Error('Missing headline'); e.status = 400; throw e; }

    const chosenStyle = style || STYLES[Math.floor(Math.random() * STYLES.length)];

    let guidelines = '';
    try {
      const r = await db.query(`SELECT value FROM cs_settings WHERE key = 'guidelines' LIMIT 1`);
      if (r.rows.length && r.rows[0].value) guidelines = '\n\nEDITORIAL GUIDELINES (follow these strictly as hard rules):\n' + r.rows[0].value;
    } catch {}

    /* Language follows the masthead, not the request. langOf() defaults to 'dv',
     * so a brand with no BRAND_LANG entry — or a request that omits brand
     * entirely — gets the original Dhivehi prompt unchanged. */
    const lang = langOf(brand);
    const en = lang === 'en';

    const systemPrompt = en
      ? `You write very short Facebook captions in English for a Maldivian news outlet.

LENGTH RULE — THIS IS THE MOST IMPORTANT RULE:
- EXACTLY 2 short sentences. That's it.
- Total caption MUST be under 200 characters. Count carefully.
- Each sentence should be 8-14 words maximum.
- Drop all unnecessary details — names, titles, dates — unless they ARE the news.
- Use the office, not the full name: "the President", not the person's full name.

OTHER RULES:
- Write ONLY in English. Never output Thaana, and never transliterate Thaana into Latin letters.
- ONLY state facts from the provided text. NEVER fabricate.
- The caption only shortens the article. It never adds an outcome the article does not state.
- Keep the article's legal status exactly. "Police are investigating" stays "investigating" — never upgrade it to arrested, detained, charged, convicted, sentenced or jailed. Never add a death, injury, resignation, dismissal or number that the article does not state.
- NEVER ask questions.
- NEVER give advice or commentary.
- No URLs, hashtags, or engagement bait.
- Plain, natural news English. Short words. Short sentences. No headline-ese, no dropped articles.
- Sentence case. No ALL CAPS.
- Keep names, titles and institutions exactly as the article spells them.
- Brand: ${BRAND_TONE[brand] || 'accessible'}
${guidelines}

Return ONLY the 2-sentence caption. Nothing else.`
      : `You write very short Facebook captions in Dhivehi (Thaana script) for a Maldivian news outlet.

LENGTH RULE — THIS IS THE MOST IMPORTANT RULE:
- 2 short sentences: the news, then one more detail. Never more than 2. Use 1 only if the story truly has nothing else to add.
- Total caption MUST be under 120 Thaana characters. Count carefully.
- Each sentence should be 8-12 words maximum.
- Drop all unnecessary details — names, titles, dates — unless they ARE the news.
- If the headline mentions "ރައީސް" just say "ރައީސް", skip the full name.

FORMAT (Azmee's caption style):
- Write it as ONE line. Never use a line break. No tags, labels or quote marks around it.
- Separate the two sentences with a Thaana comma (،) or a full stop (.).
- Use TV-news style verb endings, NOT the written -eve endings. Never end a sentence with "އެވެ" or "ށެވެ" or any "-ެވެ" form.
  Examples of the style: "ހިފަހައްޓައިފި"، "ފަރުވާ ދެނީ"، "ފަށައިފި"، "ނިންމައިފި"، "އަތުވެއްޖެ"
- Lead with the news itself. Do NOT tack "... ކަމަށް X ބުނެފި" onto every caption. Name who said it only when the news IS a statement, or when the article itself gives the claim as one source's word.
- When you do name a speaker, vary the verb. Prefer "ބުނޭ" / "ކަމަށް ބުނޭ" over repeating "ބުނެފި".
- Keep the article's honorifics. If the article uses "ވިދާޅުވި" for a minister, the President, an MP or another official, write "ވިދާޅުވި" (e.g. "... ކަމަށް ވިދާޅުވި") — never "ވިދާޅުވޭ", and never downgrade them to "ބުނެފި".
- Never use unattributed hedges like "ބެލެވޭ" or "ބެލެވެނީ". An expectation or opinion must name its source: "ކަމަށް ފުލުހުން ބުނޭ", not "ކަމަށް ބެލެވޭ".
- Thaana script only (plus digits and punctuation). Never a letter from any other script — no Sinhala, no Latin, no Arabic letters (ﷲ in a name is fine).

OTHER RULES:
- Write ONLY in Dhivehi/Thaana. No English.
- ONLY state facts from the provided text. NEVER fabricate.
- The caption only shortens the article. It never adds an outcome the article does not state.
- Keep the article's legal status exactly. If the article says "ބަލަނީ" / "ބަލަމުންދާ", the caption says that — never upgrade it to "ހައްޔަރުކޮށް", "ބަންދުކޮށް", "ދަޢުވާކޮށް", "ހުކުމްކޮށް" or "ޖަލަށް". Never add a death, injury, resignation, dismissal or number that the article does not state.
- If the article says a claim is unconfirmed or comes from one report, keep that qualifier — never state it as plain fact.
- NEVER ask questions. No "ތޯ؟".
- NEVER give advice or commentary.
- No URLs, hashtags, or engagement bait.
- Simple natural Dhivehi. Short words. Short sentences.
- CRITICAL: If unsure of a Thaana word, use a simpler one. No invented compound words.
- Brand: ${BRAND_TONE[brand] || 'accessible'}
${guidelines}

Return ONLY the caption, on one line. Nothing else.`;

    const response = await anthropic(apiKey).messages.create({
      // Captions run on Opus — deliberately a different model from extraction,
      // so CAPTION_MODEL is its own knob rather than sharing ANTHROPIC_MODEL.
      // Sharing one var is how the Sonnet 5 switch silently broke captions.
      model: model || process.env.CS_CAPTION_MODEL || 'claude-opus-5',
      // Opus and Sonnet 5 both spend budget on a thinking block before writing
      // anything. 300 left no room for the caption itself; the length rules
      // live in the system prompt, not in max_tokens.
      max_tokens: 1000,
      // Cached: the system prompt is identical for every caption of a brand
      // (rules + saved guidelines + tone), so repeat calls within 1 hour read
      // it at 10% of the input price. The per-caption style lives in the user
      // message for exactly this reason — anything varying here breaks the cache.
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      messages: [{ role: 'user', content: `STYLE: ${STYLE_INSTRUCTIONS[chosenStyle]}\n\nWrite a very short 2-sentence caption for:\n\nHeadline: ${headline}\n\n${bodyText ? 'Article:\n' + bodyText.substring(0, 1000) : '(headline only)'}${_avoid ? `\n\nYour previous caption said "${_avoid.join('", "')}", which this article does not say. Write it again using only what the article states.` : ''}` }]
    });

    // Sonnet 5 returns multiple blocks (thinking + text). content[0] is often
    // the thinking block, whose .text is undefined — reading it silently fell
    // back to the headline, so the UI looked like nothing happened at all.
    // Same scan routes/ai.js already does.
    const blocks = Array.isArray(response.content) ? response.content : [];
    console.log('[fb-caption] blocks:', blocks.map(b => b.type + ':' + ((b.text || '').length)).join(', ') || 'none',
      '| stop_reason:', response.stop_reason);

    let caption = '';
    for (const b of blocks) {
      if (b.type === 'text' && b.text && b.text.trim()) caption = b.text.trim();
    }

    if (!caption) {
      console.error('[fb-caption] No text block. stop_reason:', response.stop_reason,
        '| blocks:', JSON.stringify(blocks).slice(0, 400));
      const why = response.stop_reason === 'max_tokens'
        ? 'model ran out of tokens before writing the caption (raise max_tokens)'
        : 'model returned no text content';
      const e = new Error('Caption generation failed: ' + why); e.status = 502; throw e;
    }

    // Safety: if the response was cut off (stop_reason != 'end_turn'), truncate to last complete sentence
    if (response.stop_reason === 'max_tokens' && caption.length > 10) {
      // The Thaana sentence enders are 3 chars wide, the full stop is 1. Looking
      // for them at all is harmless on an English caption — they simply never
      // match — but the width arithmetic must still key off which one won.
      const lastStop = Math.max(caption.lastIndexOf('.'), caption.lastIndexOf('އެވެ'), caption.lastIndexOf('ށެވެ'));
      if (lastStop > 20) caption = caption.substring(0, lastStop + (caption[lastStop] === '.' ? 1 : 3));
    }

    // Clean-up the prompt cannot guarantee: a model occasionally wraps the
    // caption in <caption> tags or splits it over two lines.
    caption = caption.replace(/<\/?[a-z_]+>/gi, '').trim();
    if (!en) caption = caption.replace(/\s*\n+\s*/g, (m, i) => /[.،!؟]$/.test(caption.slice(0, i)) ? ' ' : '، ');

    // A claim the article doesn't make (an arrest, a death, a number) is a legal
    // risk, not a style slip. Rewrite once, naming what was added; if the rewrite
    // still adds it, throw — the relay then falls back to the headline with a
    // ⚠️ note on the share card, and the Studio UI shows the error.
    const added = unsupportedClaims(caption, headline, bodyText);
    if (added.length) {
      console.warn('[fb-caption] caption adds claims not in the article:', JSON.stringify(added), '|', caption);
      if (!_avoid) {
        const again = await generateCaption({ headline, bodyText, brand, style: chosenStyle, model, apiKey, _retry, _avoid: added });
        again.usage = sumUsage(response.usage || {}, again.usage || {});
        return again;
      }
      const e = new Error(`AI caption added "${added.join('", "')}", which is not in the article`); e.status = 422; throw e;
    }

    // A Dhivehi caption with a letter from another script (a Sinhala "මි" was
    // seen in testing) must never reach a page. Retry once; usage is summed so
    // cost comparisons stay honest.
    const FOREIGN = /[^\u0780-\u07BF\uFDF2\s0-9.,،؛؟?!%\-–—:'"‘’“”()\/]/;
    if (!en && FOREIGN.test(caption) && !_retry) {
      console.warn('[fb-caption] foreign script in caption, retrying:', JSON.stringify(caption.match(FOREIGN)[0]));
      const again = await generateCaption({ headline, bodyText, brand, style: chosenStyle, model, apiKey, _retry: true, _avoid });
      again.usage = sumUsage(response.usage || {}, again.usage || {});
      return again;
    }
    return { caption, style: chosenStyle, headline, lang, model: response.model, usage: response.usage || null, stopReason: response.stop_reason };
}

router.post('/generate', async (req, res) => {
  try {
    res.json(await generateCaption(req.body || {}));
  } catch (err) {
    console.error('[fb-caption] Error:', err.message);
    if (err.status === 400 || err.status === 422 || err.status === 502) return res.status(err.status).json({ error: err.message });
    res.status(500).json({ error: 'Caption generation failed: ' + err.message });
  }
});

/* ─── Caption A/B check (lab/caption-ab.html) ───
 * Runs the exact production prompt above on two models for one article, with
 * the SAME style for both, so the only variable is the model. The API key may
 * come in the body (a throwaway key for the test, used for this request only,
 * never stored or logged); without one it falls back to CS_ANTHROPIC_API_KEY. */
const AB_MODELS = new Set([
  'claude-opus-5', 'claude-sonnet-4-6', 'claude-opus-4-6',
  'claude-sonnet-5', 'claude-haiku-4-5-20251001'
]);

router.post('/compare', async (req, res) => {
  const { headline, bodyText, brand, models, apiKey } = req.body || {};
  if (!headline) return res.status(400).json({ error: 'Missing headline' });
  if (!Array.isArray(models) || models.length !== 2 || !models.every(m => AB_MODELS.has(m)))
    return res.status(400).json({ error: 'Pick two models from: ' + [...AB_MODELS].join(', ') });
  const style = STYLES.includes(req.body.style) ? req.body.style : STYLES[Math.floor(Math.random() * STYLES.length)];
  const key = typeof apiKey === 'string' && apiKey.trim() ? apiKey.trim() : undefined;

  const results = await Promise.all(models.map(async (m) => {
    const t0 = Date.now();
    try {
      const out = await generateCaption({ headline, bodyText, brand, style, model: m, apiKey: key });
      return { model: m, ok: true, caption: out.caption, usage: out.usage, stopReason: out.stopReason, ms: Date.now() - t0 };
    } catch (err) {
      // err.message only: SDK errors do not carry the key, and nothing here logs the body.
      return { model: m, ok: false, error: err.message, ms: Date.now() - t0 };
    }
  }));
  res.json({ ok: true, style, results });
});

router.generateCaption = generateCaption;
module.exports = router;
