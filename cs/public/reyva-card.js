/* reyva-card.js — Reyva Online's two card layouts, drawn on canvas.
 *
 * Measured off the templates Reyva supplied (2026-11-16), at 1080 wide:
 *   NEWS  (3.png blue, 5.png / 8.png red) — 4:5
 *     handles top-left · gradient badge top-right overlapping the photo ·
 *     photo 94→985 × 182→773 · gradient panel to 1217 · centred Aammu headline
 *     with a hard drop shadow · link pill centred on the panel's bottom edge.
 *     Optional category word left of the badge (8.png).
 *   QUOTE (905048063 / 910417940_….jpg) — 4:5
 *     photo 108→454 left, gradient panel 454→972, both 138→1043 · “ ” marks ·
 *     right-aligned quote · role + name in MV Typewriter · handles bottom-left ·
 *     link pill bottom-right. With AI cutout on, the subject is drawn again,
 *     unclipped, so it steps out over the panel the way the designer's do.
 *
 * Square and 9:16 reuse the same top and bottom bands and give the extra or
 * missing height to the photo, so the panel keeps its proportions.
 *
 * card-studio.js calls ReyvaCard.draw() when the brand's layout is 'reyva'.
 */
(function () {
  const SC = window.StudioCore;

  const PALETTES = {
    blue: {
      label: 'Blue',
      bg:    [[0, '#00133f'], [0.3, '#00133e'], [0.55, '#000f35'], [0.8, '#000724'], [1, '#000621']],
      panel: [[0, '#3a91c7'], [0.25, '#3266a6'], [0.5, '#28347b'], [0.75, '#161b4e'], [0.9, '#0a0b32'], [1, '#030120']],
      badge: [[0, '#41d2f5'], [0.2, '#3a97cb'], [0.25, '#346aab'], [0.5, '#1e2763'], [0.8, '#151a4d'], [1, '#030122']],
      pill:  [[0, '#2b90d0'], [0.45, '#1f4f9b'], [1, '#07055a']],
      icon: '#2d3a75', wave: 'rgba(110,150,255,0.06)', shadow: '#0b0f33'
    },
    red: {
      label: 'Red',
      bg:    [[0, '#430700'], [0.3, '#440700'], [0.55, '#380500'], [0.8, '#250300'], [1, '#220301']],
      panel: [[0, '#e6570a'], [0.1, '#e0470b'], [0.25, '#d4260f'], [0.5, '#ab0010'], [0.75, '#630009'], [0.9, '#370003'], [1, '#1a0001']],
      badge: [[0, '#fd9a01'], [0.2, '#e85e09'], [0.25, '#d72f0e'], [0.5, '#84000c'], [0.8, '#620009'], [1, '#1d0001']],
      pill:  [[0, '#ee5a0a'], [0.3, '#d42a0e'], [0.6, '#b0000f'], [1, '#3d0003']],
      icon: '#c8101a', wave: 'rgba(255,110,80,0.06)', shadow: '#2a0000'
    }
  };

  const CREAM = '#fcf8e7';
  const LATIN = "'ReyvaLatin','Poppins','Helvetica Neue',Arial,sans-serif";
  const HANDLES = { fb: '@reyvaonline', x: '@reyvaonlinemv' };

  /* ── assets ── */
  let markImg = null, markP = null;
  function ensureMark() {
    return (markP ||= SC.loadImage('/img/reyva-mark.png').then(i => (markImg = i)).catch(() => null));
  }
  const origCache = { src: null, img: null };
  async function original(src) {
    if (!src) return null;
    if (origCache.src !== src) {
      origCache.src = src;
      try { origCache.img = await SC.loadImage(src); } catch { origCache.img = null; }
    }
    return origCache.img;
  }

  /* ── helpers ── */
  function grad(c, x0, y0, x1, y1, stops) {
    const g = c.createLinearGradient(x0, y0, x1, y1);
    for (const [t, col] of stops) g.addColorStop(t, col);
    return g;
  }

  // Cover-fit into a rect with pan (-1..1 of the overflow) — same convention as
  // card-studio's photo drag, so dragging the preview reframes these cards too.
  function coverRect(c, img, x, y, w, h, pos) {
    const ir = img.width / img.height, br = w / h;
    let dw, dh;
    if (ir > br) { dh = h; dw = dh * ir; } else { dw = w; dh = dw / ir; }
    const mx = (dw - w) / 2, my = (dh - h) / 2;
    return { dx: x + (w - dw) / 2 + (pos ? pos.x : 0) * mx, dy: y + (h - dh) / 2 + (pos ? pos.y : 0) * my, dw, dh };
  }

  function placeholder(c, x, y, w, h) {
    c.fillStyle = '#c8ccd6'; c.fillRect(x, y, w, h);
    c.font = '34px ' + SC.FONT_BODY; c.fillStyle = '#0006';
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.direction = 'rtl';
    c.fillText('ފޮޓޯ', x + w / 2, y + h / 2);
  }

  /* Background: vertical gradient plus faint wave lines, as in the templates. */
  function background(c, w, h, P) {
    c.fillStyle = grad(c, 0, 0, 0, h, P.bg); c.fillRect(0, 0, w, h);
    c.save();
    c.strokeStyle = P.wave; c.lineWidth = 1.6;
    for (let i = -8; i < 60; i++) {
      const y0 = i * 26;
      c.beginPath();
      for (let x = 0; x <= w; x += 12) {
        const y = y0 + x * 0.06 + Math.sin(x / 210 + i * 0.35) * 18;
        if (x === 0) c.moveTo(x, y); else c.lineTo(x, y);
      }
      c.stroke();
    }
    c.restore();
  }

  /* Gradient square + cream circle with the "e" knocked out. */
  function badge(c, x, y, s, P) {
    c.fillStyle = grad(c, x, y, x + s, y + s, P.badge); c.fillRect(x, y, s, s);
    const m = s * 0.47;
    if (markImg) c.drawImage(markImg, x + (s - m) / 2, y + (s - m) / 2, m, m);
    else { c.fillStyle = CREAM; c.beginPath(); c.arc(x + s / 2, y + s / 2, m / 2, 0, Math.PI * 2); c.fill(); }
  }

  function fbIcon(c, cx, cy, r, bg) {
    c.save();
    c.fillStyle = CREAM; c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
    c.fillStyle = bg; c.font = '700 ' + Math.round(r * 1.75) + 'px ' + LATIN;
    c.textAlign = 'center'; c.textBaseline = 'alphabetic'; c.direction = 'ltr';
    c.fillText('f', cx + r * 0.12, cy + r * 1.02);
    c.restore();
  }
  function xIcon(c, x, y, s) {
    c.save();
    c.strokeStyle = CREAM; c.lineWidth = Math.max(1.4, s * 0.075); c.lineJoin = 'miter';
    c.beginPath();                                   // the hollow thick stroke
    c.moveTo(x, y); c.lineTo(x + s * 0.3, y); c.lineTo(x + s, y + s); c.lineTo(x + s * 0.7, y + s); c.closePath();
    c.stroke();
    c.lineWidth = Math.max(1.6, s * 0.09);           // the thin stroke, broken at the crossing
    c.beginPath(); c.moveTo(x + s * 0.94, y); c.lineTo(x + s * 0.58, y + s * 0.4); c.stroke();
    c.beginPath(); c.moveTo(x + s * 0.42, y + s * 0.6); c.lineTo(x + s * 0.06, y + s); c.stroke();
    c.restore();
  }

  /* Two stacked handles; (x, cy1) is the left edge / centre of the first line. */
  function handles(c, x, cy1, gap, fs, bg) {
    const r = fs * 0.72;
    fbIcon(c, x + r, cy1, r, bg);
    xIcon(c, x + r * 0.15, cy1 + gap - r * 0.85, r * 1.7);
    c.save();
    c.font = '400 ' + fs + 'px ' + LATIN; c.fillStyle = CREAM;
    c.textAlign = 'left'; c.textBaseline = 'middle'; c.direction = 'ltr';
    c.fillText(HANDLES.fb, x + r * 2 + fs * 0.62, cy1 + 1);
    c.fillText(HANDLES.x, x + r * 2 + fs * 0.42, cy1 + gap + 1);
    c.restore();
  }

  function linkIcon(c, cx, cy, s, col) {
    c.save();
    c.translate(cx, cy); c.rotate(-Math.PI / 4);
    c.strokeStyle = col; c.lineWidth = s * 0.11; c.lineCap = 'round';
    const lw = s * 0.42, lh = s * 0.3, r = lh / 2;
    for (const off of [-lw * 0.42, lw * 0.42]) {
      c.beginPath();
      c.moveTo(off - lw / 2 + r, -r); c.lineTo(off + lw / 2 - r, -r);
      c.arc(off + lw / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
      c.lineTo(off - lw / 2 + r, r);
      c.arc(off - lw / 2 + r, 0, r, Math.PI / 2, Math.PI * 1.5);
      c.stroke();
    }
    c.restore();
  }

  /* Link pill. align: 'center' → x is the centre; 'right' → x is the right edge. */
  function pill(c, text, x, cy, ph, fs, P, align) {
    c.save();
    c.font = '400 ' + fs + 'px ' + LATIN; c.direction = 'ltr';
    const tw = c.measureText(text).width;
    const box = ph - 8, padL = 4 + box + ph * 0.27, padR = ph * 0.3;
    const pw = padL + tw + padR;
    const px = align === 'right' ? x - pw : x - pw / 2, py = cy - ph / 2;
    c.fillStyle = grad(c, px, 0, px + pw, 0, P.pill); c.fillRect(px, py, pw, ph);
    c.fillStyle = '#f3efe6'; c.fillRect(px + 4, py + 4, box, box);
    linkIcon(c, px + 4 + box / 2, cy, box * 0.66, P.icon);
    c.fillStyle = CREAM; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(text, px + padL, cy + 1);
    c.restore();
  }

  /* Thaana block with the templates' hard offset shadow. Returns line count. */
  function shadowText(c, lines, x, yFirst, lh, fs, P, align) {
    c.save();
    c.font = fs + 'px ' + SC.FONT_HEAD; c.direction = 'rtl'; c.textAlign = align; c.textBaseline = 'alphabetic';
    const dx = Math.max(2, fs * 0.06), dy = Math.max(3, fs * 0.08);
    lines.forEach((ln, i) => { c.fillStyle = P.shadow; c.fillText(ln, x + dx, yFirst + i * lh + dy); });
    lines.forEach((ln, i) => { c.fillStyle = CREAM; c.fillText(ln, x, yFirst + i * lh); });
    c.restore();
  }

  /* “ ” drawn as shapes: a filled dot with a tail curling up (“), then the
   * same turned 180° (”). Glyphs differ by font; the template's are this shape. */
  function quoteMarks(c, x, y, h) {
    const r = h * 0.3, gap = r * 0.3;
    function six(cx, cy) {
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.fill();
      c.beginPath();
      c.moveTo(cx - r, cy);
      c.quadraticCurveTo(cx - r * 1.05, cy - r * 2.3, cx + r * 0.9, cy - r * 3.05);
      c.lineTo(cx + r * 0.98, cy - r * 2.62);
      c.quadraticCurveTo(cx - r * 0.1, cy - r * 1.9, cx + r * 0.1, cy - r * 0.6);
      c.closePath(); c.fill();
    }
    c.save(); c.fillStyle = '#f3efe6';
    const cy = y + h - r;
    six(x + r, cy); six(x + r * 3 + gap, cy);
    c.save();
    const nx = x + r * 6 + gap * 4;
    c.translate(nx + r * 4 + gap, y + r + h - r * 2 - (h - r * 4.05));
    c.rotate(Math.PI);
    six(r, 0); six(r * 3 + gap, 0);
    c.restore();
    c.restore();
  }

  function wrap(c, text, maxW, fs, family) {
    c.save(); c.font = fs + 'px ' + family; c.direction = 'rtl';
    const out = [];
    for (const para of String(text || '').split(/\n+/)) out.push(...SC.wrapThaana(c, para, maxW));
    c.restore();
    return out;
  }

  const HEAD = { two: 72, more: 88 };

  /* Fewest lines at maxW, then the narrowest width that keeps that count —
   * so the lines come out close to equal instead of a long line and a stub. */
  function balanced(c, text, maxW, fs, minLines) {
    // minLines: narrow the measure until the text takes at least that many lines.
    if (minLines && wrap(c, text, maxW, fs, SC.FONT_HEAD).length < minLines
        && String(text || '').trim().split(/\s+/).length >= minLines) {
      let lo = maxW * 0.3, hi = maxW;
      for (let i = 0; i < 18; i++) {
        const mid = (lo + hi) / 2;
        if (wrap(c, text, mid, fs, SC.FONT_HEAD).length >= minLines) lo = mid; else hi = mid;
      }
      maxW = lo;
    }
    const n = wrap(c, text, maxW, fs, SC.FONT_HEAD).length;
    if (n <= 1) return wrap(c, text, maxW, fs, SC.FONT_HEAD);
    let lo = maxW * 0.3, hi = maxW;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (wrap(c, text, mid, fs, SC.FONT_HEAD).length <= n) hi = mid; else lo = mid;
    }
    return wrap(c, text, hi, fs, SC.FONT_HEAD);
  }

  /* ───────── NEWS ───────── */
  function drawNews(c, o, P) {
    const { w, h, cc } = o;
    const fx = Math.round(w * 0.0875), fw = w - fx * 2;
    const top = 182, bottom = h - 133;
    const split = Math.round(top + (bottom - top) * 0.5713);

    background(c, w, h, P);

    // panel
    c.fillStyle = grad(c, fx, split, fx + fw, bottom, P.panel); c.fillRect(fx, split, fw, bottom - split);

    // photo
    c.save(); c.beginPath(); c.rect(fx, top, fw, split - top); c.clip();
    if (o.photo) { const r = coverRect(c, o.photo, fx, top, fw, split - top, o.photoPos); c.drawImage(o.photo, r.dx, r.dy, r.dw, r.dh); }
    else placeholder(c, fx, top, fw, split - top);
    c.restore();

    // headline, centred in the panel above the pill
    // Headline size (Reyva, 2026-11-17): 2 lines → 72, 3 or more → up to 88 then ×0.86, wrapped
    // wide (86% of the panel) and balanced so the lines come out near-equal.
    // It never leaves the panel: a long headline steps down until it fits,
    // with clear space above (photo) and below (link pill). autoSize: false —
    // the studio's Heading size slider once moved — uses headSize as given,
    // still shrinking only if it would overflow.
    const maxW = Math.round(fw * 0.86);
    const LH = 1.65;
    const areaTop = split + 46, areaBot = bottom - 64;
    const fits = (n, f) => (n - 1) * Math.round(f * LH) + f * 1.25 <= areaBot - areaTop;
    const auto = o.autoSize !== false;
    let fs, lines;
    if (auto) {
      // 1) Fits on two lines at 72 → 72. 2) Otherwise the 3+ route: up to 88,
      //    shrunk to fit the panel, then 86% of that for air (option B).
      lines = balanced(c, cc.headline, maxW, HEAD.two);
      if (lines.length <= 2) fs = HEAD.two;
      else {
        fs = HEAD.more; lines = balanced(c, cc.headline, maxW, fs);
        while (!fits(lines.length, fs) && fs > 30) { fs -= 2; lines = balanced(c, cc.headline, maxW, fs); }
        // …and it stays on three lines (or more): at the smaller size it could
        // squeeze onto two, which would read as an undersized two-line card.
        fs = Math.round(fs * 0.86); lines = balanced(c, cc.headline, maxW, fs, 3);
      }
    } else {
      fs = o.headSize; lines = balanced(c, cc.headline, maxW, fs);
    }
    // Never leave the panel, whichever route it took.
    while (!fits(lines.length, fs) && fs > 30) { fs -= 2; lines = balanced(c, cc.headline, maxW, fs); }
    const lh = Math.round(fs * LH);
    const blockH = (lines.length - 1) * lh + fs * 1.0;
    const yFirst = Math.round(areaTop + (areaBot - areaTop - blockH) / 2 + fs * 0.78);
    shadowText(c, lines, w / 2, yFirst, lh, fs, P, 'center');

    // header: handles, badge, optional category word
    handles(c, 160, 124, 28, 17, P.bg[0][1]);
    const bs = 108, bx = 804, by = 104;
    badge(c, bx, by, bs, P);
    if (cc.eyebrow && cc.eyebrow.trim()) {
      c.save();
      const efs = 34;
      c.font = efs + 'px ' + SC.FONT_HEAD; c.direction = 'rtl'; c.textAlign = 'right'; c.textBaseline = 'middle';
      c.fillStyle = P.shadow; c.fillText(cc.eyebrow.trim(), bx - 26 + 3, by + bs * 0.32 + 4);
      c.fillStyle = CREAM;    c.fillText(cc.eyebrow.trim(), bx - 26, by + bs * 0.32);
      c.restore();
    }

    // link pill straddling the panel's bottom edge
    if (cc.url) pill(c, cardLink(cc.url), w / 2, bottom, 46, 21.5, P, 'center');
  }

  /* ───────── QUOTE ───────── */
  async function drawQuote(c, o, P) {
    const { w, h, cc } = o;
    const fx = 108, fr = w - 108;                 // frame 108 → 972
    const top = 138, bottom = h - 307;            // 138 → 1043 at 1350
    const split = Math.round(fx + (fr - fx) * 0.4); // photo | panel at 454

    background(c, w, h, P);
    c.fillStyle = grad(c, split, top, fr, bottom, P.panel); c.fillRect(split, top, fr - split, bottom - top);

    // photo — with cutout on, draw the ORIGINAL in the frame, then the subject
    // again unclipped so it steps out over the panel.
    const base = o.cut ? await original(o.photoSrc) : o.photo;
    let r = null;
    c.save(); c.beginPath(); c.rect(fx, top, split - fx, bottom - top); c.clip();
    if (base) { r = coverRect(c, base, fx, top, split - fx, bottom - top, o.photoPos); c.drawImage(base, r.dx, r.dy, r.dw, r.dh); }
    else placeholder(c, fx, top, split - fx, bottom - top);
    c.restore();
    if (o.cut && r) {
      c.save(); c.beginPath(); c.rect(fx, top, fr - fx, bottom - top); c.clip();
      c.drawImage(o.cut, r.dx, r.dy, r.dw, r.dh);
      c.restore();
    }

    // “ ”
    quoteMarks(c, split + 42, top + 58, 52);

    // quote text, right-aligned, top-anchored under the marks
    const fs = o.headSize, lh = Math.round(fs * 1.62);
    const tx = fr - 52, maxW = fr - split - 90;
    const lines = wrap(c, cc.pullQuote, maxW, fs, SC.FONT_HEAD);
    const yFirst = top + 58 + 52 + 40 + Math.round(fs * 0.9);
    shadowText(c, lines, tx, yFirst, lh, fs, P, 'right');

    // role, then name — small, MV Typewriter
    let ay = yFirst + (lines.length - 1) * lh + Math.round(fs * 0.55) + 42;
    c.save();
    c.font = '22px ' + SC.FONT_BODY; c.direction = 'rtl'; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.fillStyle = 'rgba(252,248,231,0.9)';
    for (const t of [cc.attrib1, cc.attrib2]) { if (t && t.trim()) { c.fillText(t.trim(), tx, ay); ay += 34; } }
    c.restore();

    badge(c, 812, 108, 106, P);

    // footer: handles left, pill right
    const fy = bottom + 184;
    handles(c, fx, fy, 28, 18, P.bg[P.bg.length - 1][1]);
    if (cc.url) pill(c, cardLink(cc.url), fr, fy + 14, 46, 23, P, 'right');
  }

  /* The link exactly as Reyva prints it: reyvaonline.com/news/<id>. */
  function cardLink(u) {
    const s = String(u || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
    const m = s.match(/^reyvaonline\.com\/(?:article|news)\/(\d+)/i);
    return m ? 'reyvaonline.com/news/' + m[1] : s;
  }

  async function draw(c, o) {
    await ensureMark();
    const P = PALETTES[o.pal] || PALETTES.blue;
    c.save();
    if (o.tpl === 'quote') await drawQuote(c, o, P); else drawNews(c, o, P);
    c.restore();
  }

  window.ReyvaCard = { draw, PALETTES, cardLink, HANDLES };
})();
