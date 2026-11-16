/* reel-studio.js — Reel workspace: photos + article → 1080x1920 MP4 (WebCodecs) */
(function () {
  const SC = window.StudioCore;
  const W = 1080, H = 1920, FPS = 30;
  const HOOK_SEC = 3.5, BODY_SEC = 4.0, OUTRO_SEC = 2.5, XFADE = 0.5;
  const MP4MUXER_CDN = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.min.js';
  const FX_KEYS = Object.keys(SC.FX);

  /* Text animations — all Thaana/RTL-safe */
  const TANIM = {
    fadeUp: 'Fade up', fade: 'Fade in', slideRight: 'Slide from right',
    pop: 'Pop', word: 'Word by word', type: 'Typewriter',
    blur: 'Blur in', none: 'None'
  };
  const TANIM_KEYS = Object.keys(TANIM);
  const TEXT_ANIM_SEC = 0.9;           // animation completes this far into the slide

  // grapheme-cluster split so fili never detach from their consonant
  const segmenter = ('Segmenter' in Intl) ? new Intl.Segmenter('dv', { granularity: 'grapheme' }) : null;
  function graphemes(str) {
    if (segmenter) return Array.from(segmenter.segment(str), s => s.segment);
    return Array.from(str); // code-point fallback
  }
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

  /* Animated RTL text block, anchored bottom-right like SC.drawTextBlock */
  function drawAnimText(c, text, x, yBottom, maxWidth, fontPx, lineH, color, family, anim, tRaw) {
    if (!text || !text.trim()) return 0;
    const t = Math.min(1, Math.max(0, tRaw));
    if (anim === 'none' || t >= 1) return SC.drawTextBlock(c, text, x, yBottom, maxWidth, fontPx, lineH, color, family);
    const e = SC.easeInOut(t);

    c.save();
    c.font = `${fontPx}px ${family}`;
    c.direction = 'rtl'; c.textAlign = 'right'; c.textBaseline = 'alphabetic';
    c.fillStyle = color;
    const lines = SC.wrapThaana(c, text, maxWidth);
    const totalH = lines.length * lineH;
    const lineY = i => yBottom - totalH + (i + 1) * lineH;

    switch (anim) {
      case 'fade':
        c.globalAlpha = e;
        lines.forEach((ln, i) => c.fillText(ln, x, lineY(i)));
        break;

      case 'fadeUp':
        c.globalAlpha = e;
        c.translate(0, (1 - e) * 60);
        lines.forEach((ln, i) => c.fillText(ln, x, lineY(i)));
        break;

      case 'slideRight':   // RTL-natural: enters from the right edge
        c.globalAlpha = Math.min(1, e * 1.4);
        c.translate((1 - e) * 160, 0);
        lines.forEach((ln, i) => c.fillText(ln, x, lineY(i)));
        break;

      case 'pop': {
        const s = 0.6 + 0.4 * easeOutBack(t);
        c.globalAlpha = Math.min(1, t * 2.5);
        const cx = x - maxWidth / 2, cy = yBottom - totalH / 2;
        c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy);
        lines.forEach((ln, i) => c.fillText(ln, x, lineY(i)));
        break;
      }

      case 'blur':
        c.filter = `blur(${(1 - e) * 10}px)`;
        c.globalAlpha = e;
        lines.forEach((ln, i) => c.fillText(ln, x, lineY(i)));
        c.filter = 'none';
        break;

      case 'word': {       // staggered per word, laid out manually right-to-left
        const allWords = lines.map(ln => ln.split(' '));
        const nWords = allWords.reduce((a, w) => a + w.length, 0);
        const spaceW = c.measureText('\u00A0').width;
        let wi = 0;
        allWords.forEach((words, li) => {
          let cursor = x;
          const y = lineY(li);
          for (const w of words) {
            const start = wi / nWords, span = 1.6 / nWords;
            const wt = Math.min(1, Math.max(0, (t - start * 0.8) / span));
            if (wt > 0) {
              c.globalAlpha = wt;
              c.save(); c.translate(0, (1 - SC.easeInOut(wt)) * 26);
              c.fillText(w, cursor, y);
              c.restore();
            }
            cursor -= c.measureText(w).width + spaceW;
            wi++;
          }
        });
        c.globalAlpha = 1;
        break;
      }

      case 'type': {       // grapheme-cluster reveal, right-to-left
        const perLine = lines.map(ln => graphemes(ln));
        const totalG = perLine.reduce((a, g) => a + g.length, 0);
        let remain = Math.floor(e * totalG);
        perLine.forEach((g, li) => {
          if (remain <= 0) return;
          const take = Math.min(g.length, remain);
          const shown = g.slice(0, take).join('');
          const y = lineY(li);
          c.fillText(shown, x, y);
          if (take < g.length || (li === perLine.length - 1 && e < 0.98)) {
            // cursor bar at the growing (left) end
            const w = c.measureText(shown).width;
            c.fillStyle = SC.THEME[state.brand].accent;
            c.fillRect(x - w - 14, y - fontPx * 0.75, 6, fontPx * 0.85);
            c.fillStyle = color;
          }
          remain -= take;
        });
        break;
      }
    }
    c.restore();
    return totalH;
  }


  const LOGO_ANIM = { fade: 'Fade in', drop: 'Drop from top', pop: 'Pop', pulse: 'Gentle pulse (all slides)', none: 'None' };

  const state = {
    brand: 'reyva',
    logoAnim: 'fade',
    hook: '', hookSize: 70,
    capSize: 60,
    cta: '',
    clampText: true,   // lay text out inside the active safe zone, not the raw frame
    ctaDefaults: {
      // REYVA: the outro line is "follow <Reyva> for the latest news". Reyva's
      // Thaana spelling isn't confirmed yet — empty renders no CTA, as for newscast.
      reyva: '',
      dhuvas: '\u078c\u07a7\u0792\u07a7 \u079a\u07a6\u0784\u07a6\u0783\u07a7\u0787\u07a8 \u0789\u07a6\u07a2\u07aa\u078d\u07ab\u0789\u07a7\u078c\u07a6\u0781\u07b0 \u078b\u07aa\u0788\u07a6\u0790\u07b0 \u078a\u07ae\u078d\u07af \u0786\u07ae\u0781\u07b0\u078d\u07a6\u0787\u07b0\u0788\u07a7',
      voice:  '\u078c\u07a7\u0792\u07a7 \u079a\u07a6\u0784\u07a6\u0783\u07a7\u0787\u07a8 \u0789\u07a6\u07a2\u07aa\u078d\u07ab\u0789\u07a7\u078c\u07a6\u0781\u07b0 \u0788\u07ae\u0787\u07a8\u0790\u07b0 \u078a\u07ae\u078d\u07af \u0786\u07ae\u0781\u07b0\u078d\u07a6\u0787\u07b0\u0788\u07a7',
      // TODO(Azmee): Thaana spelling of "Newscast" not supplied, and guessing it
      // would put unverified vocabulary on air. The sentence is identical to the
      // other two apart from the brand word (dhuvas uses \u078b\u07aa\u0788\u07a6\u0790\u07b0, voice uses \u0788\u07ae\u0787\u07a8\u0790\u07b0) \u2014
      // drop the Newscast spelling into the same slot. Empty means no CTA renders.
      newscast: ''
    },
    fbCaption: '',
    slides: [],            // { img, caption, fx, size }
    music: null, musicVol: 0.35, tracks: [],
    playing: false, exporting: false,
    _pendingCaptions: []
  };

  const host = document.getElementById('tool-reel');
  host.innerHTML = `
    <aside class="controls">
      <h2>Reel</h2><p class="sub">article + photos \u2192 vertical MP4</p>

      <div class="grp"><label>Source article</label>
        <textarea id="rSrc" style="min-height:90px" placeholder="\u0793\u07AC\u0786\u07B0\u0790\u07B0\u0793\u07B0 \u0795\u07AD\u0790\u07B0\u0793\u07B0\u0786\u07AE\u0781\u07B0\u078D\u07A6\u078B\u07AC\u0787\u07B0\u0788\u07A7"></textarea>
        <button class="btn-ghost" id="rAI">\u2728 AI: write hook &amp; slide captions</button>
        <div class="status" id="rAIStatus"></div></div>

      <div class="grp"><label>Outlet</label>
        <!-- Data-driven from THEME so a new masthead cannot be missing here while
             it exists in card-studio — a hidden button means the grant filter in
             index.html finds nothing to select, leaves DHUVAS active, and the
             person publishes a reel under the wrong masthead without being told.
             NOTE: the LTR text path is built for CARDS only so far. voice_en
             renders here with the Thaana right-to-left layout; the English reel
             and video layouts are still to be built. -->
        <div class="seg" id="rBrand">${Object.keys(SC.THEME).map(function (k, i) {
          return '<button data-v="' + k + '"' + (i === 0 ? ' class="on"' : '') + '>' + SC.THEME[k].label + '</button>';
        }).join('')}</div></div>

      <div class="grp"><label>Hook headline (slide 1)</label>
        <textarea id="rHook"></textarea>
        <div class="slider-row"><label>Size</label><input type="range" id="rHookSize" min="48" max="160" step="2" value="70"><span class="val" id="rHookSizeVal">70</span></div></div>

      <div class="grp"><label>Photos &amp; captions (2\u20136)</label>
        <label class="upload">\u{1F4F7} Add photos<input type="file" id="rPhotos" accept="image/*" multiple hidden></label>
        <div id="rSlides" style="margin-top:9px"></div>
        <p class="hint">Slide 1 = first photo + hook. ~4s per slide. Changing an effect plays that slide.</p></div>

      <div class="grp"><label>Music</label>
        <select id="rMusic">
          <option value="">No music</option>
          <option value="__upload">Upload MP3\u2026</option>
        </select>
        <input type="file" id="rMusicFile" accept="audio/*" hidden>
        <div class="slider-row"><label>Volume</label><input type="range" id="rMusicVol" min="5" max="100" step="5" value="35"><span class="val" id="rMusicVolVal">35%</span></div>
        <div class="status" id="rMusicStatus"></div>
        <p class="hint">Loops to reel length, fades out. Add MP3s to <code>public/audio/</code> + list in <code>tracks.json</code>. Skip music on serious/tragic stories.</p></div>

      <div class="grp"><label>Outro CTA</label>
        <textarea id="rCta"></textarea></div>

      <div class="grp"><label>FB caption</label>
        <textarea id="rFbCap" style="min-height:70px"></textarea>
        <button class="btn-ghost" id="rCopy">Copy caption</button></div>

      <button class="btn-primary" id="rExport">\u2B07 Export MP4</button>

      <div class="grp" style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px">
        <label>FB caption</label>
        <button class="btn-ghost" id="rAICaption" style="margin:0 0 6px;font-size:11px">\u2728 AI Caption</button>
        <textarea id="rFbCapAI" rows="3" style="width:100%;background:var(--field);border:1px solid var(--border);border-radius:var(--r-sm);padding:8px;color:var(--text);font-family:var(--thaana-head);font-size:13px;direction:rtl;text-align:right;resize:vertical;line-height:1.8" placeholder="Caption for Facebook\u2026"></textarea>
        <button class="btn-primary" id="rReadyFb" style="margin-top:8px;font-size:15px;padding:14px">\ud83d\udce4 Copy Caption + Download MP4</button>
      </div>

      <div id="rSafeZone"></div>

      <div class="status" id="rStatus"></div>
    </aside>
    <div class="stage">
      <canvas class="preview" id="rCanvas" width="${W}" height="${H}"></canvas>
      <div class="pbar" id="rPbar"><div></div></div>
      <div class="transport seg">
        <button id="rPlay">\u25B6 Preview</button>
        <button id="rStop">\u23F9 Stop</button>
      </div>
    </div>`;

  const $ = s => host.querySelector(s);
  const canvas = $('#rCanvas'), ctx = canvas.getContext('2d');

  /* safe-zone guide: DOM layer above the preview canvas, never drawn into ctx
     (the MP4 is encoded from the offscreen canvas, but keep the rule uniform). */
  const szCtrl = window.SafeZones ? window.SafeZones.attach(canvas) : null;
  let szUI = null;

  /* ── safe-zone TEXT LAYOUT ───────────────────────────────────────────────
   * The overlay measures; this places. With clamping on, every text anchor is
   * resolved against the selected destination's safe rect instead of the raw
   * 1080x1920 frame — the hook used to sit at y=1700, which is 450px inside
   * Facebook's 672px caption band, so the headline was being published under
   * the caption on every Reel.
   *
   * With clamping OFF these expressions reduce to the original constants
   * exactly (hook 110/220, caption 90/200), so the old look is still one
   * checkbox away and nothing about existing reels is forced to change. */
  function layoutBox() {
    if (!szCtrl || !state.clampText) return { x: 0, y: 0, w: W, h: H, clamped: false };
    const core = szCtrl.info().core;
    return { x: core.x, y: core.y, w: core.w, h: core.h, clamped: true };
  }
  /* Room kept at the top of the zone for the logo mark (200px wide, ~154 tall
   * at y+65) so an auto-fitted headline cannot grow up into it. */
  const LOGO_RESERVE = 240;
  let lastFit = null;              // reported by redrawStill when a shrink happened

  /* Resolve the whole text block: wrap width, font size, line height, and the
   * baseline it hangs from. Two things here are easy to get wrong and both were:
   *
   *  1. DESCENDERS. drawTextBlock puts the last BASELINE at `yBottom`, but
   *     Thaana descends 0.34x the font size below the baseline (SC.descenderRatio
   *     — card-studio has always known this, reel-studio never did). Clamping the
   *     baseline to the zone edge still hangs the tails into the caption band:
   *     at size 120 that is 41px of headline sitting under Facebook's UI.
   *  2. OVERFLOW. A long Dhivehi hook at 120px is four lines ~744px tall, and
   *     Meta's usable height is 978px minus the logo. The size slider is now a
   *     MAXIMUM: step down until the block fits, never past 44px. */
  function textBlock(c, seg) {
    const isHook = seg.type === 'hook';
    const text   = (isHook ? state.hook : seg.slide.caption) || '';
    const b      = layoutBox();
    const side   = b.clamped ? 30 : (isHook ? 110 : 90);
    const botIn  = b.clamped ? 30 : (isHook ? 220 : 200);
    const ratio  = isHook ? 1.55 : 1.64;
    const dr     = SC.descenderRatio(state.brand);
    const want   = isHook ? state.hookSize : (seg.slide.size || state.capSize);
    const maxW   = b.w - side * 2;
    const right  = b.x + b.w - side;
    const topLimit = b.y + (b.clamped ? LOGO_RESERVE : 0);

    let size = want, lh, lines, totalH, baseBottom, top;
    for (;;) {
      c.save(); c.font = `${size}px ${SC.FONT_HEAD}`; c.direction = 'rtl';
      lines = SC.wrapThaana(c, text, maxW); c.restore();
      lh = Math.round(size * ratio);
      totalH = lines.length * lh;
      baseBottom = b.y + b.h - botIn - (b.clamped ? Math.round(size * dr) : 0);
      top = baseBottom - totalH + lh - size * 0.95;   // 0.95: Thaana upper marks
      if (!b.clamped || top >= topLimit || size <= 44) break;
      size -= 2;
    }
    return {
      isHook, size, want, lh, lines, maxW, right, box: b,
      baselineBottom: baseBottom,
      barX: right + (b.clamped ? 12 : 22),
      top: Math.round(top),
      bottom: Math.round(baseBottom + (b.clamped ? size * dr : 0)),
      shrunk: size < want
    };
  }
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const offCtx = off.getContext('2d');

  function fit() {
    const stage = host.querySelector('.stage');
    const scale = Math.min((stage.clientHeight - 120) / H, (stage.clientWidth - 50) / W, 0.5);
    canvas.style.width = (W * scale) + 'px'; canvas.style.height = (H * scale) + 'px';
  }
  window.addEventListener('resize', () => { if (host.classList.contains('on')) fit(); });

  function status(m, c) { const el = $('#rStatus'); el.textContent = m; el.className = 'status ' + (c || ''); }
  function aiStatus(m, c) { const el = $('#rAIStatus'); el.textContent = m; el.className = 'status ' + (c || ''); }
  function musicStatus(m, c) { const el = $('#rMusicStatus'); el.textContent = m; el.className = 'status ' + (c || ''); }

  /* ---------- timeline ---------- */
  function timeline() {
    const segs = [];
    if (state.slides.length) segs.push({ type: 'hook', slide: state.slides[0], dur: HOOK_SEC });
    state.slides.slice(1).forEach(s => segs.push({ type: 'body', slide: s, dur: BODY_SEC }));
    segs.push({ type: 'outro', dur: OUTRO_SEC });
    let t = 0; segs.forEach(s => { s.start = t; t += s.dur; });
    return { segs, total: t };
  }

  /* ---------- drawing ---------- */
  function drawSlide(c, seg, p) {
    const th = SC.THEME[state.brand];
    c.clearRect(0, 0, W, H);

    if (seg.type === 'outro') {
      c.fillStyle = th.ink; c.fillRect(0, 0, W, H);
      // subtle radial glow
      const rg = c.createRadialGradient(W / 2, H * 0.35, 40, W / 2, H * 0.35, 700);
      rg.addColorStop(0, 'rgba(255,85,0,.08)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = rg; c.fillRect(0, 0, W, H);

      const tSec = p * seg.dur;
      // logo fade in
      const tL = Math.min(1, tSec / 0.5);
      const logoAlpha = SC.easeInOut(tL);
      // The whole outro composes against the safe box, not the frame, so the
      // CTA and site line cannot land under a caption block.
      const ob = layoutBox();

      /* Centre the outro on the FRAME, not on the safe box. The safe box is not
       * horizontally symmetric on every platform — TikTok's action rail eats the
       * right side, putting its centre at x=466 — so centring on the box pushed
       * the whole brand card visibly left. Instead: centre on W/2 and cap the
       * content width to whichever side has less room, which keeps a
       * frame-centred block inside the safe box on BOTH sides. */
      const ocx = W / 2;
      const halfRoom = Math.min(ocx - ob.x, (ob.x + ob.w) - ocx);
      const safeW = Math.max(240, halfRoom * 2);

      /* The outro is a measured STACK, not fractions of the box.
       * It used to sit at 0.30 / 0.48 / 0.56 of the FRAME, which was fine at
       * 1920 tall. Re-pointing those fractions at a 978-tall safe box squeezed
       * the gaps while the logo kept its fixed ~292px height, so the divider
       * and the CTA were drawn straight over the logo. Measuring from the
       * logo's real height keeps the spacing right at any box size. */
      const GAP_LOGO = 54, DIV_H = 5, GAP_DIV = 58, GAP_SITE = 70, SITE_H = 52;
      const logoW = Math.min(190, Math.round(safeW * 0.30));
      const logoH = Math.round(logoW / SC.LOGO_REF_ASPECT);
      const ctaMaxW = Math.min(W - 440, safeW - 80);

      let ctaSize = 70, ctaLH, allLines, stackH;
      c.save(); c.direction = 'rtl';
      for (;;) {
        c.font = `${ctaSize}px ${SC.FONT_HEAD}`;
        allLines = SC.wrapThaana(c, activeCta(), ctaMaxW);
        ctaLH = Math.round(ctaSize * 1.75);          // tightened from 2.07 — at 70px the old ratio left a 145px gutter
        stackH = logoH + GAP_LOGO + DIV_H + GAP_DIV
               + allLines.length * ctaLH + GAP_SITE + SITE_H;
        if (stackH <= ob.h - 40 || ctaSize <= 34) break;
        ctaSize -= 2;
      }
      c.restore();

      const stackTop = ob.y + Math.max(20, (ob.h - stackH) / 2);
      const logoY = stackTop;
      const divY  = logoY + logoH + GAP_LOGO;
      const baseY = divY + DIV_H + GAP_DIV + Math.round(ctaSize * 0.95);

      c.save(); c.globalAlpha = logoAlpha;
      c.translate(ocx - W / 2, 0);            // drawLogoCentered centres on W/2
      SC.drawLogoCentered(c, state.brand, W, logoY, logoW);
      c.restore();

      // accent divider line
      const lineW = 120 * SC.easeInOut(tL);
      c.save(); c.globalAlpha = logoAlpha; c.fillStyle = th.accent;
      c.fillRect(ocx - lineW / 2, divY, lineW, DIV_H); c.restore();

      // Word Pop CTA — heading font
      c.save(); c.font = `${ctaSize}px ${SC.FONT_HEAD}`;
      c.direction = 'rtl'; c.textAlign = 'center'; c.fillStyle = '#fff';
      const lh = ctaLH;
      const words = activeCta().split(/\s+/).filter(Boolean);
      let wi = 0;
      allLines.forEach((ln, li) => {
        const lWords = ln.split(/\s+/);
        const totalW = c.measureText(ln).width;
        let cursor = ocx + totalW / 2;
        const spaceW = c.measureText('\u00A0').width;
        for (const w of lWords) {
          const ww = c.measureText(w + ' ').width;
          const wStart = 0.3 + wi * 0.08, wDur = 0.25;
          const wt = Math.min(1, Math.max(0, (tSec - wStart) / wDur));
          if (wt > 0) {
            c.save(); c.globalAlpha = SC.easeInOut(wt);
            const s = 0.5 + 0.5 * easeOutBack(wt);
            c.translate(cursor - ww / 2, baseY + li * lh);
            c.scale(s, s);
            c.fillText(w, 0, 0);
            c.restore();
          }
          cursor -= ww;
          wi++;
        }
      });
      c.restore();

      // site URL fade in last
      const nWords = words.length;
      const tS = Math.min(1, Math.max(0, (tSec - (0.3 + nWords * 0.08 + 0.3)) / 0.4));
      c.save(); c.globalAlpha = SC.easeInOut(tS);
      c.translate(0, (1 - SC.easeInOut(tS)) * 20);
      c.font = 'bold 52px ' + getComputedStyle(document.body).fontFamily;
      c.textAlign = 'center'; c.fillStyle = th.accent;
      c.fillText(th.site, ocx, baseY + (allLines.length - 1) * lh + GAP_SITE + SITE_H * 0.5);
      c.restore();
      return;
    }

    const idx = state.slides.indexOf(seg.slide);
    SC.drawPhotoFx(c, seg.slide.img, W, H, seg.slide.fx || (idx % 2 === 0 ? 'zoomIn' : 'zoomOut'), p, seg.slide.panX || 0, seg.slide.panY || 0);

    /* The scrim is sized to the TEXT, not to a fixed fraction of the frame.
     * It used to start at H*0.45 (y=864), which worked while the headline sat
     * at y=1700 deep in the dark end of the ramp. Once the safe zone pushed the
     * hook up to y~700 the gradient no longer reached it at all — measured
     * background under the headline was 111/255 mean, 253 at p90 (a white
     * wall), i.e. white Thaana on white. Legibility broke, not the geometry. */
    const tb = textBlock(c, seg);
    lastFit = tb;
    const fadeTop = Math.max(0, tb.top - 220);
    const span    = H - fadeTop;
    const s1 = Math.max(0, Math.min(1, (tb.top - 30 - fadeTop) / span));
    const s2 = Math.max(s1, Math.min(1, (tb.bottom + 46 - fadeTop) / span));
    const g = c.createLinearGradient(0, fadeTop, 0, H);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(s1, 'rgba(0,0,0,0.66)');   // full strength before the first line
    g.addColorStop(s2, 'rgba(0,0,0,0.66)');   // held across the block
    g.addColorStop(1, 'rgba(0,0,0,0.82)');
    c.fillStyle = g; c.fillRect(0, fadeTop, W, H - fadeTop);

    const lb = tb.box;
    SC.drawLogoTopRight(c, state.brand, W, 125, {
      dx: lb.clamped ? (lb.x + lb.w) - W : 0,
      dy: lb.clamped ? lb.y : 0,
      white: true
    });

    const tAnim = (p * seg.dur) / TEXT_ANIM_SEC;

    const anim = seg.slide.tanim || 'fadeUp';
    if (seg.type === 'hook') {
      const blockH = tb.lines.length * tb.lh;
      const be = SC.easeInOut(Math.min(1, tAnim));
      c.save();
      c.fillStyle = th.accent;
      c.fillRect(tb.barX, tb.baselineBottom - blockH + 20 + (blockH - 10) * (1 - be), 10, (blockH - 10) * be);
      c.restore();
      drawAnimText(c, state.hook, tb.right, tb.baselineBottom, tb.maxW, tb.size, tb.lh, '#ffffff', SC.FONT_HEAD, anim, tAnim);
    } else {
      drawAnimText(c, seg.slide.caption, tb.right, tb.baselineBottom, tb.maxW, tb.size, tb.lh, '#ffffff', SC.FONT_HEAD, anim, tAnim);
    }

    // progress dots
    const n = state.slides.length + 1;
    const dw = 10, gap = 14; let x0 = (W - (n * dw + (n - 1) * gap)) / 2;
    const active = seg.type === 'hook' ? 0 : idx;
    for (let i = 0; i < n; i++) {
      c.fillStyle = i === active ? th.accent : 'rgba(255,255,255,0.4)';
      c.beginPath(); c.arc(x0 + dw / 2, H - 70, dw / 2, 0, Math.PI * 2); c.fill();
      x0 += dw + gap;
    }
  }

  function drawSlideWithAlpha(c, seg, p, alpha) {
    offCtx.clearRect(0, 0, W, H);
    drawSlide(offCtx, seg, p);
    c.save(); c.globalAlpha = alpha; c.drawImage(off, 0, 0); c.restore();
  }

  function drawFrame(c, tSec, tl) {
    const { segs } = tl;
    let cur = segs[segs.length - 1];
    for (const s of segs) if (tSec >= s.start && tSec < s.start + s.dur) { cur = s; break; }
    const p = Math.min(1, Math.max(0, (tSec - cur.start) / cur.dur));
    drawSlide(c, cur, p);
    const next = segs[segs.indexOf(cur) + 1];
    if (next && (cur.start + cur.dur - tSec) < XFADE) {
      drawSlideWithAlpha(c, next, 0, 1 - (cur.start + cur.dur - tSec) / XFADE);
    }
  }

  /* ---------- music ---------- */
  let audioCtx = null, previewSrc = null, previewGain = null;
  const getAudioCtx = () => audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());

  async function loadTrackList() {
    try {
      const r = await fetch('/audio/tracks.json', { cache: 'no-store' });
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list)) return;
      state.tracks = list.filter(t => t && t.name && t.file);
      const sel = $('#rMusic');
      sel.querySelectorAll('option[data-b]').forEach(o => o.remove());
      state.tracks.forEach((t, i) => {
        const o = document.createElement('option');
        o.value = 'track:' + i; o.textContent = '\u266B ' + t.name; o.dataset.b = '1';
        sel.insertBefore(o, sel.querySelector('option[value="__upload"]'));
      });
    } catch {}
  }

  async function decodeAudio(arrayBuffer, name) {
    const kb = (arrayBuffer.byteLength / 1024).toFixed(0);
    const sniff = SC.sniffAudio(arrayBuffer);
    musicStatus(`Decoding ${sniff.fmt}, ${kb} KB\u2026`, 'work');
    if (!sniff.ok) { state.music = null; musicStatus(`This file is ${sniff.fmt} \u2014 ${kb} KB. Use a real MP3/M4A.`, 'err'); return; }
    try {
      const buf = await getAudioCtx().decodeAudioData(arrayBuffer.slice(0));
      state.music = { name, buffer: buf };
      musicStatus(`\u266B ${name} \u2014 ${sniff.fmt}, ${buf.duration.toFixed(0)}s \u2713`, 'ok');
    } catch (e) {
      state.music = null;
      musicStatus(`Decode failed (${sniff.fmt}, ${kb} KB): ${e.message || 'unsupported codec'}.`, 'err');
    }
  }

  async function pickTrack(val) {
    stopMusicPreview();
    if (!val) { state.music = null; musicStatus(''); return; }
    if (val === '__upload') { $('#rMusicFile').click(); return; }
    if (val.startsWith('track:')) {
      const t = state.tracks[+val.slice(6)]; if (!t) return;
      musicStatus('Loading ' + t.name + '\u2026', 'work');
      try {
        const r = await fetch(t.file);
        if (!r.ok) throw new Error(r.status === 404 ? `file not found \u2014 put the MP3 at public${t.file}` : 'HTTP ' + r.status);
        const ct = (r.headers.get('content-type') || '').toLowerCase();
        if (ct.includes('text/html')) throw new Error(`file not found \u2014 put the MP3 at public${t.file}`);
        await decodeAudio(await r.arrayBuffer(), t.name);
      } catch (e) { $('#rMusic').value = ''; state.music = null; musicStatus('Failed: ' + e.message, 'err'); }
    }
  }

  function startMusicPreview(offsetSec) {
    if (!state.music) return;
    stopMusicPreview();
    const c = getAudioCtx(); if (c.state === 'suspended') c.resume();
    previewSrc = c.createBufferSource();
    previewSrc.buffer = state.music.buffer; previewSrc.loop = true;
    previewGain = c.createGain(); previewGain.gain.value = state.musicVol;
    previewSrc.connect(previewGain).connect(c.destination);
    previewSrc.start(0, (offsetSec || 0) % state.music.buffer.duration);
  }
  function stopMusicPreview() {
    if (previewSrc) { try { previewSrc.stop(); } catch {} previewSrc.disconnect(); previewSrc = null; }
  }

  async function renderMusicBuffer(totalSec) {
    const SR = 48000;
    const oac = new OfflineAudioContext(2, Math.ceil(totalSec * SR), SR);
    const src = oac.createBufferSource();
    src.buffer = state.music.buffer; src.loop = true;
    const gain = oac.createGain();
    gain.gain.setValueAtTime(state.musicVol, 0);
    gain.gain.setValueAtTime(state.musicVol, Math.max(0, totalSec - 3.0));
    gain.gain.exponentialRampToValueAtTime(0.0001, totalSec);
    src.connect(gain).connect(oac.destination);
    src.start(0);
    return oac.startRendering();
  }

  async function encodeAudioBuffer(buffer, encoder) {
    const SR = buffer.sampleRate, CH = buffer.numberOfChannels, CHUNK = 9600;
    const chans = []; for (let c = 0; c < CH; c++) chans.push(buffer.getChannelData(c));
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const frames = Math.min(CHUNK, buffer.length - start);
      const data = new Float32Array(frames * CH);
      for (let c = 0; c < CH; c++) data.set(chans[c].subarray(start, start + frames), c * frames);
      const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: frames, numberOfChannels: CH, timestamp: Math.round(start / SR * 1e6), data });
      encoder.encode(ad); ad.close();
      if (encoder.encodeQueueSize > 10) await new Promise(r => setTimeout(r, 10));
    }
    await encoder.flush();
  }

  /* ---------- preview ---------- */
  let rafId = null, playStart = 0;
  function play() {
    stop();
    if (!state.slides.length) return status('Add at least one photo first', 'err');
    const tl = timeline();
    state.playing = true; playStart = performance.now();
    startMusicPreview(0);
    const loop = () => {
      const t = (performance.now() - playStart) / 1000;
      if (t >= tl.total) { state.playing = false; stopMusicPreview(); drawFrame(ctx, tl.total - 0.01, tl); return; }
      drawFrame(ctx, t, tl);
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);
  }
  function stop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; state.playing = false; stopMusicPreview(); }

  function previewSlide(i) {
    stop();
    const tl = timeline();
    const seg = tl.segs.find(s => s.slide === state.slides[i]);
    if (!seg) return;
    state.playing = true;
    const t0 = performance.now();
    const loop = () => {
      const t = seg.start + (performance.now() - t0) / 1000;
      if (t >= seg.start + seg.dur) { state.playing = false; drawFrame(ctx, seg.start + seg.dur - 0.01, tl); return; }
      drawFrame(ctx, t, tl);
      rafId = requestAnimationFrame(loop);
    };
    SC.ensureAssets().then(() => { rafId = requestAnimationFrame(loop); });
  }

  function redrawStill() {
    if (state.playing || state.exporting) return;
    if (!state.slides.length) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    const tl = timeline();
    SC.ensureAssets().then(() => {
      drawFrame(ctx, 0.7, tl);
      if (lastFit && lastFit.shrunk)
        status(`Hook auto-fitted to ${lastFit.size}px (slider ${lastFit.want}px) so it stays inside the safe zone`, '');
    });
  }
  function showSlideStill(i) {
    if (state.playing || state.exporting) return;
    const tl = timeline();
    const seg = tl.segs.find(s => s.slide === state.slides[i]);
    if (!seg) return redrawStill();
    SC.ensureAssets().then(() => drawFrame(ctx, seg.start + seg.dur * 0.5, tl));
  }

  /* ---------- export ---------- */
  function ensureMuxer() {
    return window.Mp4Muxer ? Promise.resolve() : new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = MP4MUXER_CDN; s.onload = res; s.onerror = rej; document.head.appendChild(s);
    });
  }

  async function exportMp4() {
    if (state.exporting) return;
    if (!state.slides.length) return status('Add photos first', 'err');
    if (!state.hook.trim()) return status('Write a hook headline first', 'err');
    if (!('VideoEncoder' in window)) return exportWebmFallback();
    state.exporting = true; stop();
    const btn = $('#rExport'); btn.disabled = true;
    const pbar = $('#rPbar'); pbar.classList.add('on');
    try {
      status('Loading encoder\u2026', 'work');
      await ensureMuxer(); await SC.ensureAssets();
      const tl = timeline();
      const totalFrames = Math.ceil(tl.total * FPS);
      const withAudio = !!(state.music && 'AudioEncoder' in window);
      if (state.music && !withAudio) status('AudioEncoder unavailable \u2014 exporting without music', 'work');

      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        audio: withAudio ? { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 } : undefined,
        fastStart: 'in-memory'
      });
      const encoder = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { throw e; }
      });
      encoder.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 9_000_000, framerate: FPS });

      status('Rendering frames\u2026', 'work');
      const usPerFrame = Math.round(1e6 / FPS);
      for (let i = 0; i < totalFrames; i++) {
        drawFrame(ctx, i / FPS, tl);
        const frame = new VideoFrame(canvas, { timestamp: i * usPerFrame, duration: usPerFrame });
        encoder.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();
        if (i % 10 === 0) {
          pbar.firstElementChild.style.width = Math.round((i / totalFrames) * 85) + '%';
          await new Promise(r => setTimeout(r, encoder.encodeQueueSize > 8 ? 15 : 0));
        }
      }
      status('Finalising video\u2026', 'work');
      await encoder.flush(); encoder.close();

      if (withAudio) {
        status('Mixing music\u2026', 'work');
        pbar.firstElementChild.style.width = '92%';
        const musicBuf = await renderMusicBuffer(tl.total);
        const aEnc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: e => { throw e; } });
        aEnc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
        await encodeAudioBuffer(musicBuf, aEnc);
        aEnc.close();
      }

      muxer.finalize();
      pbar.firstElementChild.style.width = '100%';
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${state.brand}-reel-${Date.now()}.mp4`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status(`Done \u2014 ${(blob.size / 1048576).toFixed(1)} MB, ${Math.round(tl.total)}s, 1080\u00d71920${withAudio ? ' + music' : ''} \u2713`, 'ok');
    } catch (err) {
      console.error(err);
      status('Export failed: ' + (err.message || err) + ' \u2014 use Chrome/Edge.', 'err');
    } finally {
      state.exporting = false; btn.disabled = false;
      setTimeout(() => { pbar.classList.remove('on'); pbar.firstElementChild.style.width = '0%'; }, 1500);
    }
  }

  function exportWebmFallback() {
    status('WebCodecs unavailable \u2014 exporting WebM in realtime (use Chrome for MP4)\u2026', 'work');
    const tl = timeline();
    const stream = canvas.captureStream(FPS);
    const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 9_000_000 });
    const chunks = [];
    rec.ondataavailable = e => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `${state.brand}-reel-${Date.now()}.webm`; a.click();
      status('WebM exported \u2014 convert to MP4 before posting.', 'ok');
    };
    rec.start();
    const t0 = performance.now();
    const loop = () => {
      const t = (performance.now() - t0) / 1000;
      if (t >= tl.total) return rec.stop();
      drawFrame(ctx, t, tl);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  /* ---------- AI ---------- */
  async function ai() {
    const text = $('#rSrc').value.trim();
    if (!text) return aiStatus('Paste an article first', 'err');
    aiStatus('Asking Claude\u2026', 'work');
    try {
      const guidelines = (window.VxdGuidelines || '').trim();
      const r = await fetch('/api/ai/reel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, slideCount: Math.max(state.slides.length - 1, 3), guidelines })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'failed');
      const f = data.fields;
      state.hook = f.hook || ''; $('#rHook').value = state.hook;
      if (f.cta) { state.cta = f.cta; $('#rCta').value = f.cta; }
      state.fbCaption = f.fbCaption || ''; $('#rFbCap').value = state.fbCaption;
      (f.captions || []).forEach((cap, i) => { const s = state.slides[i + 1]; if (s) s.caption = cap; });
      state._pendingCaptions = (f.captions || []).slice(Math.max(state.slides.length - 1, 0));
      renderSlideList(); redrawStill();
      aiStatus('Fields filled \u2713', 'ok');
    } catch (e) { aiStatus('AI failed: ' + e.message, 'err'); }
  }

  /* ---------- slide list with drag-to-reorder + move buttons + photo pan ---------- */
  let dragIdx = null;

  function renderSlideList() {
    const wrap = $('#rSlides'); wrap.innerHTML = '';
    state.slides.forEach((s, i) => {
      // defaults
      if (s.panX == null) s.panX = 0;
      if (s.panY == null) s.panY = 0;

      const row = document.createElement('div'); row.className = 'slideRow';
      row.dataset.idx = i;

      // drag handle — ONLY the handle initiates drag
      const handle = document.createElement('div');
      handle.draggable = true;
      handle.style.cssText = 'cursor:grab;color:#555;font-size:16px;line-height:1;padding:4px 6px;user-select:none;flex:none;display:flex;flex-direction:column;align-items:center;gap:2px';
      handle.innerHTML = '&#x2630;';
      handle.title = 'Drag to reorder';

      handle.addEventListener('dragstart', e => {
        dragIdx = i;
        row.style.opacity = '0.4';
        e.dataTransfer.effectAllowed = 'move';
      });
      handle.addEventListener('dragend', () => { row.style.opacity = '1'; dragIdx = null; });
      row.addEventListener('dragover', e => {
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        row.style.borderTop = '2px solid var(--accent)';
      });
      row.addEventListener('dragleave', () => { row.style.borderTop = ''; });
      row.addEventListener('drop', e => {
        e.preventDefault(); row.style.borderTop = '';
        if (dragIdx === null || dragIdx === i) return;
        const moved = state.slides.splice(dragIdx, 1)[0];
        state.slides.splice(i, 0, moved);
        renderSlideList(); redrawStill();
      });

      const thumb = document.createElement('img'); thumb.src = s.img.src;
      const col = document.createElement('div'); col.className = 'col';

      // header row: label + move buttons
      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:5px';
      const label = document.createElement('div'); label.className = 'rowlabel'; label.style.margin = '0';
      label.textContent = i === 0 ? 'Slide 1 \u2014 hook photo' : `Slide ${i + 1}`;
      const arrows = document.createElement('div');
      arrows.style.cssText = 'display:flex;gap:4px';
      if (i > 0) {
        const up = document.createElement('button');
        up.style.cssText = 'background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;border-radius:4px;width:24px;height:22px;font-size:12px;padding:0;line-height:1';
        up.textContent = '\u25B2'; up.title = 'Move up';
        up.addEventListener('click', () => { [state.slides[i-1], state.slides[i]] = [state.slides[i], state.slides[i-1]]; renderSlideList(); redrawStill(); });
        arrows.appendChild(up);
      }
      if (i < state.slides.length - 1) {
        const dn = document.createElement('button');
        dn.style.cssText = 'background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;border-radius:4px;width:24px;height:22px;font-size:12px;padding:0;line-height:1';
        dn.textContent = '\u25BC'; dn.title = 'Move down';
        dn.addEventListener('click', () => { [state.slides[i], state.slides[i+1]] = [state.slides[i+1], state.slides[i]]; renderSlideList(); redrawStill(); });
        arrows.appendChild(dn);
      }
      hdr.append(label, arrows);
      col.appendChild(hdr);

      // photo position sliders (pan X and Y)
      const panBox = document.createElement('div');
      panBox.style.cssText = 'margin-bottom:6px';
      function mkPan(lbl, prop, min, max) {
        const sr = document.createElement('div'); sr.className = 'slider-row'; sr.style.marginTop = '4px';
        const lb = document.createElement('label'); lb.textContent = lbl;
        const rng = document.createElement('input'); rng.type = 'range'; rng.min = min; rng.max = max; rng.step = 1;
        rng.value = Math.round((s[prop] || 0) * 100);
        const vl = document.createElement('span'); vl.className = 'val'; vl.textContent = rng.value;
        rng.addEventListener('input', () => { s[prop] = +rng.value / 100; vl.textContent = rng.value; showSlideStill(i); });
        sr.append(lb, rng, vl);
        return sr;
      }
      panBox.appendChild(mkPan('Pan X', 'panX', -100, 100));
      panBox.appendChild(mkPan('Pan Y', 'panY', -100, 100));
      col.appendChild(panBox);

      if (i > 0) {
        const ta = document.createElement('textarea'); ta.className = 'cap'; ta.value = s.caption || '';
        ta.addEventListener('input', () => { s.caption = ta.value; showSlideStill(i); });
        col.appendChild(ta);
        const sr = document.createElement('div'); sr.className = 'slider-row';
        const lab = document.createElement('label'); lab.textContent = 'Size';
        const rng = document.createElement('input'); rng.type = 'range'; rng.min = 36; rng.max = 96; rng.step = 2;
        rng.value = s.size || state.capSize;
        const val = document.createElement('span'); val.className = 'val'; val.textContent = rng.value;
        rng.addEventListener('input', () => { s.size = +rng.value; val.textContent = rng.value; showSlideStill(i); });
        s.size = +rng.value;
        sr.append(lab, rng, val);
        col.appendChild(sr);
      }
      const sel = document.createElement('select');
      sel.style.marginTop = '6px';
      FX_KEYS.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = 'Effect: ' + SC.FX[k]; sel.appendChild(o); });
      sel.value = s.fx || (i % 2 === 0 ? 'zoomIn' : 'zoomOut');
      s.fx = sel.value;
      sel.addEventListener('change', () => { s.fx = sel.value; previewSlide(i); });
      col.appendChild(sel);
      const tsel = document.createElement('select');
      tsel.style.marginTop = '6px';
      TANIM_KEYS.forEach(k => { const o = document.createElement('option'); o.value = k; o.textContent = 'Text: ' + TANIM[k]; tsel.appendChild(o); });
      tsel.value = s.tanim || 'fadeUp';
      s.tanim = tsel.value;
      tsel.addEventListener('change', () => { s.tanim = tsel.value; previewSlide(i); });
      col.appendChild(tsel);
      const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '\u00d7';
      rm.addEventListener('click', () => { state.slides.splice(i, 1); renderSlideList(); redrawStill(); });
      row.append(handle, thumb, col, rm);
      wrap.appendChild(row);
    });
  }

  /* ---------- wiring ---------- */
  $('#rPhotos').addEventListener('change', async e => {
    for (const file of e.target.files) {
      if (state.slides.length >= 6) break;
      const img = await SC.loadImage(URL.createObjectURL(file));
      const caption = state._pendingCaptions.shift() || '';
      state.slides.push({ img, caption });
    }
    e.target.value = '';
    renderSlideList(); redrawStill();
  });
  function activeCta() { return state.cta || state.ctaDefaults[state.brand] || ''; }

  $('#rBrand').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    $('#rBrand').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); state.brand = b.dataset.v;
    if (!state.cta) $('#rCta').value = activeCta();
    redrawStill();
  }));
  $('#rHook').addEventListener('input', e => { state.hook = e.target.value; redrawStill(); });
  $('#rHookSize').addEventListener('input', e => { state.hookSize = +e.target.value; $('#rHookSizeVal').textContent = e.target.value; redrawStill(); });
  $('#rCta').addEventListener('input', e => { state.cta = e.target.value; });
  $('#rFbCap').addEventListener('input', e => { state.fbCaption = e.target.value; });
  $('#rCopy').addEventListener('click', () => { navigator.clipboard.writeText($('#rFbCap').value); status('Caption copied \u2713', 'ok'); });
  $('#rMusic').addEventListener('change', e => pickTrack(e.target.value));
  $('#rMusicFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) { $('#rMusic').value = ''; return; }
    await decodeAudio(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  });
  $('#rMusicVol').addEventListener('input', e => {
    state.musicVol = +e.target.value / 100;
    $('#rMusicVolVal').textContent = e.target.value + '%';
    if (previewGain) previewGain.gain.value = state.musicVol;
  });

  $('#rAI').addEventListener('click', ai);
  $('#rExport').addEventListener('click', exportMp4);
  $('#rPlay').addEventListener('click', () => SC.ensureAssets().then(play));
  $('#rStop').addEventListener('click', () => { stop(); redrawStill(); });

  /* ── FB Reel one-click ── */

  /* AI caption for reel */
  $('#rAICaption').addEventListener('click', async () => {
    const btn = $('#rAICaption');
    const ta = $('#rFbCapAI');
    const hook = state.hook || '';
    const slideTexts = state.slides.map(s => s.caption || '').filter(Boolean).join('\n');
    if (!hook && !slideTexts) { ta.value = ''; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Generating\u2026';
    try {
      const r = await fetch('/api/fb-caption/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline: hook, bodyText: slideTexts, brand: state.brand })
      });
      const data = await r.json().catch(() => ({}));
      // Without the r.ok check a 500/502 parsed fine and left the box untouched.
      if (!r.ok || !data.caption) throw new Error(data.error || ('HTTP ' + r.status));
      ta.value = data.caption;
    } catch (err) {
      ta.value = hook;
      status('⚠ Caption failed (' + err.message + ') — using hook', 'err');
      console.error('[caption] generation failed:', err);
    }
    btn.disabled = false; btn.textContent = '\u2728 AI Caption';
  });

  /* One-click: Copy caption + Download MP4 */
  $('#rReadyFb').addEventListener('click', async () => {
    const caption = $('#rFbCapAI').value || state.hook || '';
    if (!caption) { status('Generate a caption first', 'err'); return; }

    // 1. Copy caption
    try { await navigator.clipboard.writeText(caption); } catch {}

    // 2. Export MP4 (reuse existing function)
    await exportMp4();

    status('\u2705 Caption copied + MP4 downloaded \u2014 upload to Facebook!', 'ok');
  });

  $('#rCta').value = activeCta();
  loadTrackList();
  SC.ensureAssets().then(() => {
    if (SC.fontsFailed.length) status('\u26A0 Font not loading: ' + SC.fontsFailed.map(f => f.file + ' (' + f.reason + ')').join(', ') + ' \u2014 check exact filenames in public/fonts/ (case-sensitive)', 'err');
  });
  if (szCtrl) {
    // Changing the destination changes the LAYOUT now, not just the overlay,
    // so the still has to be redrawn with it.
    szUI = window.SafeZones.buildControl(szCtrl, {
      label: 'Safe zones',
      onTargetChange: () => redrawStill()
    });
    $('#rSafeZone').appendChild(szUI.el);

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:8px';
    const cbx = document.createElement('input');
    cbx.type = 'checkbox'; cbx.id = 'rClampText'; cbx.checked = state.clampText;
    cbx.style.cssText = 'margin:0;accent-color:var(--accent,#ff3b18);cursor:pointer';
    const lbl = document.createElement('label');
    lbl.htmlFor = 'rClampText'; lbl.textContent = 'Keep text inside safe zone';
    lbl.style.cssText = 'margin:0;font-size:12.5px;cursor:pointer;color:var(--text)';
    row.appendChild(cbx); row.appendChild(lbl);
    szUI.el.appendChild(row);
    cbx.addEventListener('change', () => { state.clampText = cbx.checked; redrawStill(); });
  }
  redrawStill(); setTimeout(fit, 50);
})();
