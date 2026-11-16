/* Claude extraction endpoints: article text → Thaana fields for Photo Posts and Reels */
const express = require('express');
const router = require('../../lib/async-router')();
const { langOf } = require('../lib/share-targets');

// CS_-prefixed: ANTHROPIC_API_KEY is deliberately kept out of this service's
// environment so /studio's Settings UI stays the owner of that key. Setting the
// unprefixed name here would silently disable editing it there.
const MODEL = process.env.CS_ANTHROPIC_MODEL || 'claude-sonnet-5';

/* Output language is per-masthead, not per-article.
 *
 * The prompt used to hardcode "ALL text fields in Thaana", which was correct while
 * every outlet published in Dhivehi. maldivesvoice.mv (voice_en) publishes in
 * English, and the failure is not an error — the model dutifully TRANSLITERATES an
 * English article into Thaana and the card renders confident nonsense. So the
 * script rule is chosen by the brand's language, defaulting to Dhivehi so any brand
 * without a BRAND_LANG entry behaves exactly as before.
 *
 * Note the explicit "do not translate" line on the English side: without it the
 * model happily renders a Dhivehi source into English, which is a translation
 * decision no one asked an image generator to make. */
const LANG_RULES = {
  dv: {
    script: 'Thaana (Dhivehi) script',
    all: '- ALL text fields in Thaana (Dhivehi) script. Digits/punctuation allowed.',
    inScript: 'in Thaana',
    caution: '- CRITICAL: if unsure of a Thaana word, use a simpler one. Never invent compound words.'
  },
  en: {
    script: 'English',
    all: '- ALL text fields in ENGLISH. Never output Thaana, and never transliterate Thaana into Latin letters.\n'
       + '- Do NOT translate: the source article is already in English, so use the outlet\'s own wording wherever you can.\n'
       + '- Sentence case. No ALL CAPS, no title case on full sentences.',
    inScript: 'in English',
    caution: '- Keep names, titles and institutions exactly as the article spells them.'
  }
};
const rules = lang => LANG_RULES[lang] || LANG_RULES.dv;

const cardSystem = (lang) => {
  const L = rules(lang);
  return `You turn a news article into fields for a social media photo post card.
The card has 4 possible templates: quote, headline, stat, news.
Return ONLY valid minified JSON — no markdown fences, no commentary — with EXACTLY these keys:
{"headline":"","pullQuote":"","attribName":"","attribRole":"","eyebrow":"","statNumber":"","statLabel":"","bullets":["",""],"suggestedTemplate":"","fbCaption":""}

Rules:
${L.all}
- "headline": punchy 6-12 word headline for the card. The single most newsworthy fact.
- "pullQuote": a compelling direct or indirect quote from the article, 12-25 words. If no quote exists, write a powerful statement capturing the article's key message.
- "attribName": the name of the person quoted (${L.script}). If no person, use the institution or source name.
- "attribRole": the title/role/position of the person quoted (${L.script}).
- "eyebrow": a short 2-4 word category label (e.g. economy, politics, health).
- "statNumber": the single most impactful number/statistic from the article (digits, e.g. "1.29" or "47%"). If none, use "".
- "statLabel": a short label for that statistic ${L.inScript}, 2-5 words.
- "bullets": exactly 2 short supporting facts from the article, each 8-14 words ${L.inScript}.
- "suggestedTemplate": which template fits best — one of: "quote", "headline", "stat", "news". Pick "quote" if there's a strong quote/statement, "stat" if there's a standout number, "headline" for general stories, "news" for breaking/developing stories.
- "fbCaption": post caption ${L.inScript}: 1-2 sentence summary + 3-5 relevant hashtags on a new line.
${L.caution}
- Never fabricate facts. Output JSON only.`;
};

/* Reels are still Dhivehi-only: the reel and video workspaces have no LTR text
 * path yet, so there is nothing to render an English script into. Left as it was
 * deliberately — see the note in card-studio.js. */
const REEL_SYSTEM = `You turn a Dhivehi (or English) news article into fields for a vertical video Reel (Facebook/Instagram).
Return ONLY valid minified JSON — no markdown fences, no commentary — with EXACTLY these keys:
{"hook":"","captions":["","",""],"cta":"","fbCaption":""}

Rules:
- All text in Thaana (Dhivehi) script. Digits/punctuation allowed inside text.
- "hook": a scroll-stopping 6-10 word headline for the FIRST slide. This decides whether viewers stay past 3 seconds — punchy, curiosity-driving, never a dry copy of the article's first line. No clickbait lies.
- "captions": exactly {{N}} short slide captions, each 8-14 words, telling the story in sequence. Each must stand alone. Most important fact first.
- "cta": a short 4-8 word follow/read-more line for the outro slide.
- "fbCaption": the post caption in Thaana: 1-2 sentence summary + 3-5 relevant hashtags on a new line.
- Never fabricate facts. Output JSON only.`;

async function callClaude(system, userText) {
  const apiKey = process.env.CS_ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('CS_ANTHROPIC_API_KEY not configured'); e.status = 500; throw e; }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: userText.substring(0, 6000) }]
    }),
    signal: AbortSignal.timeout(90000)
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    const e = new Error('Upstream AI error'); e.status = 502; e.detail = detail.slice(0, 200); throw e;
  }
  const data = await r.json();
  console.log('[ai] Response stop_reason:', data.stop_reason, '| content blocks:', data.content?.length, '| model:', data.model);
  if (!data.content || data.content.length === 0) {
    console.error('[ai] Empty content. Full response:', JSON.stringify(data).slice(0, 500));
    const e = new Error('Model returned empty response'); e.status = 502; throw e;
  }
  // Sonnet 5 may return multiple blocks (thinking + text). Find the text block with content.
  let out = '';
  for (const block of data.content) {
    console.log('[ai] Block type:', block.type, '| length:', (block.text || '').length);
    if (block.type === 'text' && block.text && block.text.trim().length > 0) {
      out = block.text.trim();
    }
  }
  if (!out) {
    console.error('[ai] No text content. stop_reason:', data.stop_reason, '| Full:', JSON.stringify(data.content).slice(0, 500));
    let msg = 'Model returned no text content';
    if (data.stop_reason === 'max_tokens') msg = 'Model ran out of tokens before producing output (raise max_tokens)';
    const e = new Error(msg); e.status = 502; throw e;
  }
  console.log('[ai] Raw text length:', out.length, '| first 200 chars:', out.slice(0, 200));
  // strip markdown fences (various formats Sonnet 5 might use)
  out = out.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/g, '').trim();
  // strip any leading text before the first { and trailing text after last }
  const first = out.indexOf('{'), last = out.lastIndexOf('}');
  if (first !== -1 && last > first) out = out.substring(first, last + 1);
  // fix common JSON issues: trailing commas, single quotes
  out = out.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
  let fields;
  try { fields = JSON.parse(out); }
  catch (parseErr) {
    console.error('[ai] JSON parse failed. Raw output:', out.slice(0, 500));
    const e = new Error('Model did not return valid JSON');
    e.status = 502;
    e.detail = out.slice(0, 300);
    throw e;
  }
  return { fields, usage: data.usage || null };
}

router.post('/card', async (req, res) => {
  try {
    const text = ((req.body && req.body.text) || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'No article text provided' });
    const guidelines = ((req.body.guidelines) || '').toString().trim();
    const template = ((req.body.template) || '').toString().trim();
    // The brand decides the output language. It is optional on purpose: an older
    // cached copy of the SPA that does not send one still gets the Dhivehi prompt
    // it used to get, rather than a 400. Note that sending `brand` also opts this
    // route into the router-level grant check in ../index.js, which is correct —
    // spending Anthropic credit on a masthead you cannot publish to is wasted work.
    const brand = ((req.body.brand) || '').toString().trim();
    let system = cardSystem(langOf(brand));
    if (template) system += '\n\nThe user has selected the "' + template + '" template. Prioritize filling its fields well, but fill all fields so they can switch templates.';
    if (guidelines) system += '\n\nEDITORIAL GUIDELINES (follow these strictly):\n' + guidelines.substring(0, 2000);
    const result = await callClaude(system, text);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.detail });
  }
});

router.post('/reel', async (req, res) => {
  try {
    const text = ((req.body && req.body.text) || '').toString().trim();
    if (!text) return res.status(400).json({ error: 'No article text provided' });
    const n = Math.min(Math.max(parseInt(req.body.slideCount) || 3, 2), 5);
    const guidelines = ((req.body.guidelines) || '').toString().trim();
    let system = REEL_SYSTEM.replace('{{N}}', n);
    if (guidelines) system += '\n\nEDITORIAL GUIDELINES (follow these strictly):\n' + guidelines.substring(0, 2000);
    const result = await callClaude(system, text);
    if (!Array.isArray(result.fields.captions)) result.fields.captions = [];
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, detail: err.detail });
  }
});

module.exports = router;
