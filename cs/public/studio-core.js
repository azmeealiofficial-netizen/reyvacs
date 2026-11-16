/* studio-core.js — shared rendering engine for VxD Creative Studio
 * Themes, font/image loading, Thaana text layout, cover-fit drawing, motion effects.
 */
(function () {
  console.log('[Reyva] studio-core v5 (VxD fork)');
  /* `dir` is the masthead's text direction and defaults to 'rtl' when absent, so
   * the three Dhivehi brands are byte-for-byte unaffected by its introduction.
   * voice_en (maldivesvoice.mv) is VOICE's English edition: same accent and ink,
   * Latin script, left-to-right.
   * Its logo file does not exist yet. That is not fatal — ensureLogos() catches
   * the 404 and stores null, and both logo helpers fall back to the text badge —
   * so the card renders a "VOICE EN" pill in the accent colour until the PNG is
   * dropped into cs/public/img/. */
  /* REYVA FORK: one masthead. VxD's table had dhuvas, voice, newscast and
   * voice_en here; everything downstream (outlet buttons, URL routing, logos,
   * share targets) is derived from these keys, so this is the switch.
   * accent is what the reel and video studios use for highlights. The card
   * itself is drawn by reyva-card.js, in the blue or red palette. */
  const THEME = {
    reyva: { logo: '/img/reyva-logo.png', accent: '#3a97cb', ink: '#000621', site: 'reyvaonline.com', handle: '@reyvaonline', label: 'REYVA', layout: 'reyva' }
  };

  /* Category variants of a masthead. Kept out of THEME on purpose: card-studio.js
   * derives the Outlet buttons and URL routing from Object.keys(THEME), and Voice
   * Sports is a VOICE story on a different card, not a fifth outlet.
   * voice_sport is Azmee's supplied Voice Sports template (2026-10-10): the VOICE
   * rail card in blue, the VOICE SPORTS lockup, a grey @voicemv, no accent bar.
   * relay/card.js draws the same card server-side; change both together. */
  const VARIANTS = {
    voice_sport: { brand: 'voice', logo: '/img/voice-sports-logo.png', accent: '#147ac0', rule: '#8dc7ee', handleInk: '#b7ad98' }
  };
  const isSportSection = s => /^sports?$/i.test(String(s || '').trim());

  const dirOf = b => (THEME[b] && THEME[b].dir) || 'rtl';
  const isLtr = b => dirOf(b) === 'ltr';

  /* Logo sizing.
   * card-studio.js scales logos by HEIGHT; this file scales them by WIDTH. Both
   * were fine while every logo was a ~1.30:1 stacked lockup, but a wider lockup
   * blows out the card and shrinks to a sliver on reels — the same asset failing
   * in opposite directions depending on which helper drew it.
   * Logos at or under LOGO_REF_ASPECT keep the original single-axis maths exactly;
   * only wider ones are fitted inside the box the original would have filled.
   * dhuvas is 1.290:1 and voice is 1.299:1, so both take the unchanged path. */
  const LOGO_REF_ASPECT = 1.30;

  function logoFitScale(img, boxW, boxH) {
    if (img.width / img.height <= LOGO_REF_ASPECT) return null;   // unchanged path
    return Math.min(boxW / img.width, boxH / img.height);
  }

  const FONT_HEAD = "'VXDHead','MV Aaamu FK','MV Faseyha','MV Boli',sans-serif";
  const FONT_BODY = "'VXDBody','MV Typewriter','MV Faseyha','MV Boli',sans-serif";

  /* Latin stacks for the English masthead. public/fonts/ holds two Thaana faces and
   * nothing else, and both have only the glyphs their script needs — set Latin text
   * in VXDHead and the browser silently falls through to whatever it has, which is
   * how a card ends up in a different typeface than the one on screen. These are
   * system stacks on purpose: no new font file to 404, and no second copy of the
   * "the SPA fallback served 200 HTML instead of a font" bug.
   * Swap in a webfont here if the English edition gets its own type. */
  const FONT_HEAD_LTR = "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif";
  const FONT_BODY_LTR = "'Inter','Helvetica Neue',Helvetica,Arial,sans-serif";
  const headFont = b => (isLtr(b) ? FONT_HEAD_LTR : FONT_HEAD);
  const bodyFont = b => (isLtr(b) ? FONT_BODY_LTR : FONT_BODY);

  /* Thaana hangs vowel marks well below the baseline, so every vertical gap in the
   * card templates clears 0.34em before adding real space. Latin descenders are
   * shallower; reusing 0.34 leaves a visible hole under an English headline. */
  const descenderRatio = b => (isLtr(b) ? 0.18 : 0.34);

  let fontReady = null;
  const fontsFailed = [];   // { file, reason }
  const logos = {};

  function loadImage(src) {
    return new Promise((res, rej) => {
      const i = new Image(); i.crossOrigin = 'anonymous';
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Could not load ' + src));
      i.src = src;
    });
  }

  async function ensureFont() {
    if (!fontReady) {
      fontReady = (async () => {
        const defs = [
          ['VXDHead', '/fonts/aammufkF.ttf'],
          ['VXDBody', '/fonts/MVTypewriter_reg.ttf'],
          // REYVA: Poppins sets the handles and the link on Reyva's cards.
          ['ReyvaLatin', '/fonts/poppins-latin-400-normal.woff2', { weight: '400' }],
          ['ReyvaLatin', '/fonts/poppins-latin-500-normal.woff2', { weight: '500' }],
          ['ReyvaLatin', '/fonts/poppins-latin-600-normal.woff2', { weight: '600' }]
        ];
        for (const [fam, url, desc] of defs) {
          try {
            // verify the file actually exists and is a font, not SPA/404 HTML
            const r = await fetch(url, { cache: 'force-cache' });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const buf = await r.arrayBuffer();
            const head = new TextDecoder().decode(new Uint8Array(buf.slice(0, 12))).toLowerCase();
            if (head.includes('<!doc') || head.includes('<html')) throw new Error('server returned HTML (file missing?)');
            const f = new FontFace(fam, buf, desc || {});
            await f.load();
            document.fonts.add(f);
          } catch (e) {
            fontsFailed.push({ file: url, reason: e.message || 'load failed' });
            console.warn('[VxD] font failed:', url, e);
            showFontBanner();
          }
        }
      })();
    }
    return fontReady;
  }

  async function ensureLogos() {
    for (const b of Object.keys(THEME)) {
      if (!logos[b]) { try { logos[b] = await loadImage(THEME[b].logo); } catch { logos[b] = null; } }
    }
    for (const v of Object.keys(VARIANTS)) {
      if (!THEME[VARIANTS[v].brand]) continue;   // REYVA: VxD's voice_sport has no masthead here
      if (!logos[v]) { try { logos[v] = await loadImage(VARIANTS[v].logo); } catch { logos[v] = null; } }
    }
    return logos;
  }

  async function ensureAssets() { await Promise.all([ensureFont(), ensureLogos()]); }

  /* cover-fit draw with zoom + pan (pan -1..1 of the overflow) */
  function coverDraw(c, img, cw, ch, zoom, panX, panY) {
    const ir = img.width / img.height, cr = cw / ch;
    let dw, dh;
    if (ir > cr) { dh = ch * zoom; dw = dh * ir; } else { dw = cw * zoom; dh = dw / ir; }
    const maxX = (dw - cw) / 2, maxY = (dh - ch) / 2;
    c.drawImage(img, (cw - dw) / 2 + (panX || 0) * maxX, (ch - dh) / 2 + (panY || 0) * maxY, dw, dh);
  }

  /* Word-wrap by measured width (canvas measureText handles Thaana shaping).
   * Nothing in here is script-specific — it splits on whitespace and measures —
   * so wrapText is the same function under a name that does not lie. wrapThaana
   * stays as the alias every existing caller uses. */
  function wrapThaana(c, text, maxWidth) {
    const words = (text || '').split(/\s+/).filter(Boolean);
    const lines = []; let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (c.measureText(t).width > maxWidth && line) { lines.push(line); line = w; }
      else line = t;
    }
    if (line) lines.push(line);
    return lines;
  }

  /* Text block anchored to bottom-`align`; returns block height.
   * `align` defaults to 'right' so every existing call is unaffected. Pass
   * 'center' and x becomes the centre line instead of the edge.
   *
   * `dir` defaults to 'rtl' — the direction that shapes Thaana correctly, and what
   * this function did unconditionally before the English masthead existed. Pass
   * 'ltr' and x becomes the LEFT edge, so callers must hand it the left anchor
   * rather than the right one; getting that wrong pins the text off-canvas rather
   * than failing loudly, which is why every LTR call site derives both from the
   * same pair of locals. */
  function drawTextBlock(c, text, x, yBottom, maxWidth, fontPx, lineH, color, family, align, dir) {
    c.save();
    c.font = `${fontPx}px ${family || FONT_BODY}`;
    const d = dir || 'rtl';
    c.direction = d; c.textAlign = align || (d === 'ltr' ? 'left' : 'right'); c.textBaseline = 'alphabetic';
    c.fillStyle = color;
    const lines = wrapThaana(c, text, maxWidth);
    const totalH = lines.length * lineH;
    lines.forEach((ln, i) => c.fillText(ln, x, yBottom - totalH + (i + 1) * lineH));
    c.restore();
    return lines.length * lineH;
  }

  /* Label lives in THEME. This was a hardcoded dhuvas/VOICE ternary, which meant
   * any third brand silently rendered as "VOICE" in every logo-fallback path. */
  function badgeText(brand) { return (THEME[brand] && THEME[brand].label) || String(brand || '').toUpperCase(); }

  function drawTextBadge(c, brand, x, y, align, scale) {
    const th = THEME[brand];
    const s = scale || 1;
    c.save();
    c.font = `800 ${Math.round(34 * s)}px ` + getComputedStyle(document.body).fontFamily;
    const label = badgeText(brand);
    const tw = c.measureText(label).width;
    const padX = 18 * s, padY = 12 * s, bh = 34 * s + padY * 2;
    let bx = x;
    if (align === 'right') bx = x - tw - padX * 2;
    if (align === 'center') bx = x - (tw + padX * 2) / 2;
    c.fillStyle = th.accent;
    if (c.roundRect) { c.beginPath(); c.roundRect(bx, y, tw + padX * 2, bh, 8 * s); c.fill(); }
    else c.fillRect(bx, y, tw + padX * 2, bh);
    c.fillStyle = '#ffffff'; c.textBaseline = 'middle'; c.textAlign = 'left';
    c.fillText(label, bx + padX, y + bh / 2 + 2);
    c.restore();
  }

  /* Recolour a logo while keeping its alpha shape. 'source-in' paints the fill
   * only where the mark already has pixels, so antialiased edges survive. The
   * result is cached per brand+colour — this runs on every frame of an export. */
  const logoTints = {};
  function logoTinted(brand, color) {
    const img = logos[brand];
    if (!img) return null;
    const key = brand + '|' + color;
    if (logoTints[key]) return logoTints[key];
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const x = cv.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, cv.width, cv.height);
    logoTints[key] = cv;
    return cv;
  }

  /* `off` ({dx,dy}) shifts the MARK only, so a caller clamping to a platform
   * safe zone can pull the logo clear of the status bar and action rail. The
   * corner glow deliberately does not move: it is a decorative wash, and a
   * radial highlight floating in from mid-frame reads as a rendering fault. */
  function drawLogoTopRight(c, brand, cw, targetW, off) {
    const dx = (off && off.dx) || 0, dy = (off && off.dy) || 0;
    const img = logos[brand];
    if (!img) return drawTextBadge(c, brand, cw - 50 + dx, 50 + dy, 'right', (targetW || 150) / 150);
    const tw = targetW || 150;
    const s = logoFitScale(img, tw, tw / LOGO_REF_ASPECT) || (tw / img.width);
    const w = img.width * s, h = img.height * s;
    const x = cw - w - 70 + dx, y = 65 + dy;
    /* The corner wash has to invert with the mark: a white logo inside a white
     * glow is invisible, and the glow is there to separate the mark from the
     * photo, not to be decoration for its own sake. */
    const white = !!(off && off.white);
    const rgb = white ? '0,0,0' : '255,255,255';
    const a0 = white ? 0.55 : 0.75, a1 = white ? 0.28 : 0.38, a2 = white ? 0.10 : 0.12;
    c.save();
    const radius = Math.max(w, h) * 4.5;
    const g = c.createRadialGradient(cw, 0, 0, cw, 0, radius);
    g.addColorStop(0, `rgba(${rgb},${a0})`);
    g.addColorStop(0.35, `rgba(${rgb},${a1})`);
    g.addColorStop(0.7, `rgba(${rgb},${a2})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    c.fillStyle = g;
    c.fillRect(cw - radius, 0, radius, radius);
    c.restore();
    c.drawImage(white ? (logoTinted(brand, '#ffffff') || img) : img, x, y, w, h);
  }

  function drawLogoCentered(c, brand, cw, y, targetW) {
    const img = logos[brand];
    if (!img) return drawTextBadge(c, brand, cw / 2, y, 'center', (targetW || 320) / 150);
    const tw = targetW || 320;
    const s = logoFitScale(img, tw, tw / LOGO_REF_ASPECT) || (tw / img.width);
    c.drawImage(img, (cw - img.width * s) / 2, y, img.width * s, img.height * s);
  }

  /* motion effects (reel) */
  const FX = {
    zoomIn: 'Zoom in', zoomOut: 'Zoom out', kenburns: 'Ken Burns (diagonal)',
    panLeft: 'Pan left', panRight: 'Pan right', driftUp: 'Drift up', driftDown: 'Drift down',
    rotate: 'Rotate + zoom', pulse: 'Pulse', none: 'Static'
  };
  const easeInOut = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  function drawPhotoFx(c, img, cw, ch, fx, p, basePanX, basePanY) {
    const e = easeInOut(p);
    const bx = basePanX || 0, by = basePanY || 0;
    switch (fx) {
      case 'zoomOut': coverDraw(c, img, cw, ch, 1.14 - 0.13 * e, bx, by); break;
      case 'kenburns': coverDraw(c, img, cw, ch, 1.02 + 0.12 * e, bx + (-0.7 + 1.4 * e), by + (-0.5 + 1.0 * e)); break;
      case 'panLeft': coverDraw(c, img, cw, ch, 1.14, bx + (0.9 - 1.8 * e), by); break;
      case 'panRight': coverDraw(c, img, cw, ch, 1.14, bx + (-0.9 + 1.8 * e), by); break;
      case 'driftUp': coverDraw(c, img, cw, ch, 1.12, bx, by + (0.8 - 1.6 * e)); break;
      case 'driftDown': coverDraw(c, img, cw, ch, 1.12, bx, by + (-0.8 + 1.6 * e)); break;
      case 'rotate': {
        const ang = (-1.5 + 3 * e) * Math.PI / 180;
        c.save(); c.translate(cw / 2, ch / 2); c.rotate(ang); c.translate(-cw / 2, -ch / 2);
        coverDraw(c, img, cw, ch, 1.12 + 0.08 * e, bx, by);
        c.restore(); break;
      }
      case 'pulse': coverDraw(c, img, cw, ch, 1.05 + 0.05 * Math.sin(p * Math.PI * 2), bx, by); break;
      case 'none': coverDraw(c, img, cw, ch, 1.001, bx, by); break;
      default: coverDraw(c, img, cw, ch, 1.0 + 0.13 * e, bx, 0.15 * e + by);
    }
  }

  /* audio format sniff */
  function sniffAudio(buf) {
    const b = new Uint8Array(buf.slice(0, 16));
    const ascii = String.fromCharCode(...b.slice(0, 12));
    if (ascii.startsWith('ID3')) return { fmt: 'MP3 (ID3)', ok: true };
    if (b[0] === 0xFF && (b[1] & 0xE0) === 0xE0) return { fmt: 'MP3', ok: true };
    if (ascii.startsWith('RIFF')) return { fmt: 'WAV', ok: true };
    if (ascii.startsWith('OggS')) return { fmt: 'OGG', ok: true };
    if (ascii.startsWith('fLaC')) return { fmt: 'FLAC', ok: true };
    if (ascii.slice(4, 8) === 'ftyp') return { fmt: 'MP4/M4A', ok: true };
    const low = String.fromCharCode(...b).toLowerCase();
    if (low.includes('<!doc') || low.includes('<html')) return { fmt: 'HTML page (not audio!)', ok: false };
    if (low.startsWith('{') || low.startsWith('[')) return { fmt: 'JSON/text (not audio!)', ok: false };
    return { fmt: 'unknown (' + Array.from(b.slice(0, 4)).map(x => x.toString(16).padStart(2, '0')).join(' ') + ')', ok: false };
  }

  function showFontBanner() {
    if (document.getElementById('vxdFontBanner')) {
      document.getElementById('vxdFontBanner').textContent = bannerText();
      return;
    }
    const el = document.createElement('div');
    el.id = 'vxdFontBanner';
    el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#7a1f16;color:#ffd9d3;font:12.5px -apple-system,sans-serif;padding:9px 14px;text-align:center';
    el.textContent = bannerText();
    document.body.appendChild(el);
  }
  function bannerText() {
    return '\u26A0 Fonts not loading: ' + fontsFailed.map(f => f.file + ' (' + f.reason + ')').join(' \u2022 ') + ' \u2014 fix filenames in public/fonts/ (case-sensitive), then redeploy';
  }

  window.StudioCore = {
    THEME, VARIANTS, isSportSection, FX, easeInOut, FONT_HEAD, FONT_BODY, fontsFailed,
    FONT_HEAD_LTR, FONT_BODY_LTR, headFont, bodyFont,
    dirOf, isLtr, descenderRatio,
    // drawTextBadge was internal — only the two logo helpers fell back to it.
    // card-studio's drawLogo needs the same fallback now that a brand can exist
    // before its logo file does.
    LOGO_REF_ASPECT, logoFitScale, logoTinted, badgeText, drawTextBadge,
    loadImage, ensureFont, ensureLogos, ensureAssets, logos,
    coverDraw, wrapThaana, wrapText: wrapThaana,
    drawTextBlock, drawLogoTopRight, drawLogoCentered,
    drawPhotoFx, sniffAudio
  };
})();
