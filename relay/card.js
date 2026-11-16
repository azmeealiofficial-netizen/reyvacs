// ─────────────────────────────────────────────────────────────────────────────
// relay/card.js — the share card image, drawn on the server
// ─────────────────────────────────────────────────────────────────────────────
// REYVA FORK. VxD's relay/card.js is a hand port of Creative Studio's card
// templates, which has to be changed in step with them. Reyva's runs the
// studio's OWN reyva-card.js here instead, inside a small sandbox that gives it
// what the browser would: StudioCore's fonts, word-wrap and image loader. One
// design, two places it's drawn — the share card cannot drift from the studio.
//
// Same entry point VxD's share.js calls: renderCard({ brand, headline, photo,
// url, section }) → JPEG buffer.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { articleFetchOpts } = require('../lib/article-fetch');

// Required on first use: a canvas binding that fails to load must cost the
// share card only, never the boot (VxD's rule too).
let canvasMod = null;
const canvasLib = () => (canvasMod ||= require('@napi-rs/canvas'));

const PUB = path.join(__dirname, '..', 'cs', 'public');
const W = 1080, H = 1350;

let fontsReady = false;
function ensureFonts() {
  if (fontsReady) return;
  const { GlobalFonts } = canvasLib();
  const reg = (file, fam) => GlobalFonts.registerFromPath(path.join(PUB, 'fonts', file), fam);
  if (!reg('aammufkF.ttf', 'VXDHead') || !reg('MVTypewriter_reg.ttf', 'VXDBody')) {
    throw new Error('card fonts failed to register (cs/public/fonts)');
  }
  // Handles and the link are set in Poppins on Reyva's cards.
  if (!reg('poppins-latin-400-normal.woff2', 'ReyvaLatin')) console.warn('[relay/card] Poppins did not register — Latin falls back');
  fontsReady = true;
}

function wrap(c, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (c.measureText(t).width > maxWidth && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  return lines;
}

/* The studio's reyva-card.js, loaded once into a sandbox with a fake window. */
let reyvaCard = null;
function card() {
  if (reyvaCard) return reyvaCard;
  const window = {
    StudioCore: {
      FONT_HEAD: 'VXDHead', FONT_BODY: 'VXDBody',
      wrapThaana: wrap,
      // The only image reyva-card.js loads itself is its own logo mark.
      loadImage: src => canvasLib().loadImage(path.join(PUB, String(src).replace(/^\/+/, '')))
    }
  };
  const src = fs.readFileSync(path.join(PUB, 'reyva-card.js'), 'utf8');
  vm.runInNewContext(src, { window, console, Math, String, Promise }, { filename: 'reyva-card.js' });
  if (!window.ReyvaCard) throw new Error('reyva-card.js did not load');
  return (reyvaCard = window.ReyvaCard);
}

async function loadPhoto(src) {
  if (!src) return null;
  const { loadImage } = canvasLib();
  if (Buffer.isBuffer(src)) return loadImage(src);
  const r = await fetch(src, articleFetchOpts(30000, { Accept: 'image/*' }));
  if (!r.ok) throw new Error(`photo HTTP ${r.status}`);
  return loadImage(Buffer.from(await r.arrayBuffer()));
}

/**
 * The 4:5 news card, as the studio exports it. palette: 'blue' (the desk's
 * normal card) or 'red' (switched per story with 🎨 on the share card);
 * RELAY_CARD_PALETTE changes the default. The category word beside the logo
 * is off, as it is by default in the studio.
 */
const defaultPalette = () => ((process.env.RELAY_CARD_PALETTE || 'blue').trim().toLowerCase() === 'red' ? 'red' : 'blue');

async function renderCard({ brand = 'reyva', headline, photo, url, palette }) {
  if (brand !== 'reyva') throw new Error(`no share card design for ${brand}`);
  ensureFonts();
  const canvas = canvasLib().createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  let img = null;
  try { img = await loadPhoto(photo); } catch (e) { console.warn('[relay/card] photo:', e.message); }
  const pal = palette === 'red' || palette === 'blue' ? palette : defaultPalette();
  await card().draw(ctx, {
    w: W, h: H, tpl: 'news', pal,
    cc: { headline: headline || '', url: url || '', eyebrow: '' },
    headSize: 55, photo: img, photoPos: { x: 0, y: 0 }
  });
  return canvas.encode('jpeg', 90);
}

const MONTHS_DV = ['ޖެނުއަރީ', 'ފެބްރުއަރީ', 'މާރިޗު', 'އޭޕްރީލް', 'މޭ', 'ޖޫން', 'ޖުލައި', 'އޯގަސްޓް', 'ސެޕްޓެމްބަރު', 'އޮކްޓޯބަރު', 'ނޮވެމްބަރު', 'ޑިސެމްބަރު'];
function todayDhivehi(now = new Date()) {
  const d = new Date(now.getTime() + 5 * 3600 * 1000);
  return `${d.getUTCDate()} ${MONTHS_DV[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

module.exports = { renderCard, todayDhivehi, defaultPalette };
