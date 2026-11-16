/* video-studio.js — Video workspace: photo + video clips → 1080x1920 MP4 (WebCodecs)
 *
 * Preview draws through the <video> element; export decodes through WebCodecs.
 * Keyframe spacing in real footage ranges ~28–136 frames, so decode-based scrubbing
 * has unpredictable cost while sequential export decode is a flat ~4ms/frame.
 *
 * Requires: studio-core.js, clip-source.js
 */
(function () {
  const SC = window.StudioCore;
  const W = 1080, H = 1920, FPS = 30;
  const PHOTO_SEC = 4.0, OUTRO_SEC = 2.5, XFADE = 0.5;
  const TEXT_ANIM_SEC = 0.9;
  const MP4MUXER_CDN = 'https://cdn.jsdelivr.net/npm/mp4-muxer@5.1.5/build/mp4-muxer.min.js';
  const MAX_SLIDES = 8;

  const dbg = (m) => { try { console.log('[video] ' + m); } catch (_) {} };

  /* ───────── text animations (Video mode keeps its own copy so reel-studio.js
       stays untouched; fold both into studio-core.js when this settles) ───────── */
  const TANIM = {
    fadeUp: 'Fade up', fade: 'Fade in', slideRight: 'Slide from right',
    pop: 'Pop', word: 'Word by word', type: 'Typewriter', blur: 'Blur in', none: 'None'
  };
  const segmenter = ('Segmenter' in Intl) ? new Intl.Segmenter('dv', { granularity: 'grapheme' }) : null;
  const graphemes = s => segmenter ? Array.from(segmenter.segment(s), x => x.segment) : Array.from(s);
  const easeOutBack = t => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); };

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
        c.globalAlpha = e; lines.forEach((l, i) => c.fillText(l, x, lineY(i))); break;
      case 'fadeUp':
        c.globalAlpha = e; c.translate(0, (1 - e) * 60); lines.forEach((l, i) => c.fillText(l, x, lineY(i))); break;
      case 'slideRight':
        c.globalAlpha = Math.min(1, e * 1.4); c.translate((1 - e) * 160, 0);
        lines.forEach((l, i) => c.fillText(l, x, lineY(i))); break;
      case 'pop': {
        const s = 0.6 + 0.4 * easeOutBack(t);
        c.globalAlpha = Math.min(1, t * 2.5);
        const cx = x - maxWidth / 2, cy = yBottom - totalH / 2;
        c.translate(cx, cy); c.scale(s, s); c.translate(-cx, -cy);
        lines.forEach((l, i) => c.fillText(l, x, lineY(i))); break;
      }
      case 'blur':
        c.filter = `blur(${(1 - e) * 10}px)`; c.globalAlpha = e;
        lines.forEach((l, i) => c.fillText(l, x, lineY(i))); c.filter = 'none'; break;
      case 'word': {
        const allWords = lines.map(l => l.split(' '));
        const nWords = allWords.reduce((a, w) => a + w.length, 0);
        const spaceW = c.measureText('\u00A0').width;
        let wi = 0;
        allWords.forEach((words, li) => {
          let cursor = x; const y = lineY(li);
          for (const w of words) {
            const start = wi / nWords, span = 1.6 / nWords;
            const wt = Math.min(1, Math.max(0, (t - start * 0.8) / span));
            if (wt > 0) {
              c.globalAlpha = wt; c.save(); c.translate(0, (1 - SC.easeInOut(wt)) * 26);
              c.fillText(w, cursor, y); c.restore();
            }
            cursor -= c.measureText(w).width + spaceW; wi++;
          }
        });
        c.globalAlpha = 1; break;
      }
      case 'type': {
        const perLine = lines.map(l => graphemes(l));
        const totalG = perLine.reduce((a, g) => a + g.length, 0);
        let remain = Math.floor(e * totalG);
        perLine.forEach((g, li) => {
          if (remain <= 0) return;
          const take = Math.min(g.length, remain);
          const shown = g.slice(0, take).join('');
          const y = lineY(li);
          c.fillText(shown, x, y);
          if (take < g.length || (li === perLine.length - 1 && e < 0.98)) {
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

  /* ───────── state ───────── */
  const state = {
    brand: 'reyva',
    hook: '', hookSize: 120, capSize: 90,
    textPos: 1,          // 1 = original bottom placement, 0 = highest (just under the logo)
    shade: 'dark',       // text backdrop: 'dark' (black shade, white text) or 'light' (white shade, dark text)
    cta: '',
    ctaDefaults: {
      // REYVA: the outro line is "follow <Reyva> for the latest news". Reyva's
      // Thaana spelling isn't confirmed yet — empty renders no CTA, as for newscast.
      reyva: '',
      dhuvas: '\u078c\u07a7\u0792\u07a7 \u079a\u07a6\u0784\u07a6\u0783\u07a7\u0787\u07a8 \u0789\u07a6\u07a2\u07aa\u078d\u07ab\u0789\u07a7\u078c\u07a6\u0781\u07b0 \u078b\u07aa\u0788\u07a6\u0790\u07b0 \u078a\u07ae\u078d\u07af \u0786\u07ae\u0781\u07b0\u078d\u07a6\u0787\u07b0\u0788\u07a7',
      voice: '\u078c\u07a7\u0792\u07a7 \u079a\u07a6\u0784\u07a6\u0783\u07a7\u0787\u07a8 \u0789\u07a6\u07a2\u07aa\u078d\u07ab\u0789\u07a7\u078c\u07a6\u0781\u07b0 \u0788\u07ae\u0787\u07a8\u0790\u07b0 \u078a\u07ae\u078d\u07af \u0786\u07ae\u0781\u07b0\u078d\u07a6\u0787\u07b0\u0788\u07a7',
      // TODO(Azmee): see the same note in reel-studio.js \u2014 Thaana spelling of
      // "Newscast" not supplied, so this is left empty rather than guessed.
      newscast: ''
    },
    slides: [],
    music: null, musicVol: 0.35,
    playing: false, exporting: false
  };
  const activeCta = () => state.cta || state.ctaDefaults[state.brand] || '';

  /* ───────── brand outro clips ─────────
     A brand listed here ends on its own supplied sting instead of the drawn
     logo + CTA outro. The clip is loaded once through ClipSource, so preview,
     frame-accurate export decode and audio all use the same path as a video
     slide. Square clips are centred and the bands above and below are filled
     with the clip's own edge colour, sampled every frame, so a sting that
     changes background (VOICE's goes black → light grey) fills the full frame. */
  const OUTRO_CLIPS = { voice: '/outros/voice.mp4' };
  const outros = {};                   // brand → { clip, audioBuf, ... } once loaded
  const outroLoads = {};               // brand → in-flight promise
  function ensureOutro(brand) {
    if (!OUTRO_CLIPS[brand] || outros[brand]) return Promise.resolve(outros[brand] || null);
    if (outroLoads[brand]) return outroLoads[brand];
    outroLoads[brand] = (async () => {
      try {
        const r = await fetch(OUTRO_CLIPS[brand]);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const file = new File([await r.blob()], brand + '-outro.mp4', { type: 'video/mp4' });
        const clip = await ClipSource.open(file, dbg);
        if (clip.info.exportPath !== 'webcodecs') { clip.close(); throw new Error('not decodable for export'); }
        const audioBuf = await clip.decodeAudio(getCtx());
        outros[brand] = {
          type: 'video', clip, audioBuf, outro: true,
          trimStart: 0, trimEnd: clip.info.duration, muted: false, gain: 1
        };
        dbg(brand + ' outro: ' + clip.info.duration.toFixed(2) + 's');
      } catch (e) {
        dbg(brand + ' outro failed, using drawn outro: ' + (e.message || e));
      }
      delete outroLoads[brand];
      return outros[brand] || null;
    })();
    return outroLoads[brand];
  }
  /* the video source behind a segment: a video slide or a loaded brand outro */
  const vsrc = seg => seg.slide || seg.outro || null;

  /* ───────── brand overlays ─────────
     A brand listed here gets its own full-width transparent artwork in place of
     the drawn top-right logo. VOICE's is a 1080×1080 square (voice.mv top-left,
     outlined logo top-right, faint centred watermark) built for square posts;
     centring it vertically in the 9:16 frame is how VOICE places it on its own
     Reels, putting the mark about a quarter of the way down. Not drawn on the
     outro, which carries its own branding. */
  const OVERLAYS = { voice: '/img/voice-overlay.png' };
  const overlays = {};
  const overlayLoads = {};
  function ensureOverlay(brand) {
    if (!OVERLAYS[brand] || overlays[brand]) return Promise.resolve(overlays[brand] || null);
    if (!overlayLoads[brand]) {
      overlayLoads[brand] = SC.loadImage(OVERLAYS[brand])
        .then(img => { overlays[brand] = img; return img; })
        .catch(e => { dbg(brand + ' overlay failed, using drawn logo: ' + (e && e.message || e)); return null; })
        .finally(() => { delete overlayLoads[brand]; });
    }
    return overlayLoads[brand];
  }
  /* everything brand-specific a frame may need, loaded before drawing */
  const ensureBrand = brand => Promise.all([ensureOutro(brand), ensureOverlay(brand)]).then(r => r[0]);

  /* ───────── markup ───────── */
  const host = document.getElementById('tool-video');
  if (!host) return;

  if (!document.getElementById('vVideoStyles')) {
    const st = document.createElement('style');
    st.id = 'vVideoStyles';
    st.textContent = `
      #tool-video .slideRow.vidRow{border-left:3px solid var(--accent)}
      #tool-video .slideRow canvas.thumb{width:44px;height:78px;border-radius:5px;flex:none;background:#000;object-fit:cover}
      #tool-video .miniseg{display:flex;gap:4px;margin-top:6px}
      #tool-video .miniseg button{flex:1;background:var(--field);border:1px solid var(--border);color:var(--muted);padding:5px;border-radius:5px;cursor:pointer;font-size:10.5px;font-family:var(--font)}
      #tool-video .miniseg button.on{border-color:var(--accent);color:#fff;background:rgba(255,85,0,.12)}
      #tool-video .vKind{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:9.5px;color:var(--accent)}
      #tool-video .vArrows{display:flex;gap:4px}
      #tool-video .vArrows button{background:none;border:1px solid var(--border);color:var(--muted);cursor:pointer;border-radius:4px;width:22px;height:20px;font-size:11px;padding:0;line-height:1}
    `;
    document.head.appendChild(st);
  }

  host.innerHTML = `
    <aside class="controls">
      <h2>Video</h2><p class="sub">photo + video clips \u2192 vertical MP4</p>

      <div class="grp"><label>Outlet</label>
        <!-- Data-driven from THEME so a new masthead cannot be missing here while
             it exists in card-studio — a hidden button means the grant filter in
             index.html finds nothing to select, leaves DHUVAS active, and the
             person publishes a reel under the wrong masthead without being told.
             NOTE: the LTR text path is built for CARDS only so far. voice_en
             renders here with the Thaana right-to-left layout; the English reel
             and video layouts are still to be built. -->
        <div class="seg" id="vBrand">${Object.keys(SC.THEME).map(function (k, i) {
          return '<button data-v="' + k + '"' + (i === 0 ? ' class="on"' : '') + '>' + SC.THEME[k].label + '</button>';
        }).join('')}</div></div>

      <div class="grp"><label>Hook headline (slide 1)</label>
        <textarea id="vHook"></textarea>
        <div class="slider-row"><label>Size</label><input type="range" id="vHookSize" min="48" max="160" step="2" value="120"><span class="val" id="vHookSizeVal">120</span></div></div>

      <div class="grp"><label>Text position</label>
        <div class="slider-row"><label>Top</label><input type="range" id="vTextPos" min="0" max="100" step="1" value="100"><span class="val" id="vTextPosVal">Bottom</span></div>
        <p class="hint">Or drag up/down on the preview. Applies to the hook and every caption.</p>
        <label style="margin-top:10px">Text shade</label>
        <div class="seg" id="vShade"><button data-v="dark" class="on">Black</button><button data-v="light">White</button></div>
        <p class="hint">White shade switches the text to black so it stays readable.</p></div>

      <div class="grp"><label>Slides (max ${MAX_SLIDES})</label>
        <label class="upload">\u{1F4F7} Add photos<input type="file" id="vPhotos" accept="image/*" multiple hidden></label>
        <label class="upload">\u{1F3AC} Add video clips<input type="file" id="vVideos" accept="video/*" multiple hidden></label>
        <div id="vSlides" style="margin-top:9px"></div>
        <div class="status" id="vAddStatus"></div>
        <p class="hint">Video slides are orange-edged \u2014 trim sets their length. Photos use the duration slider.</p></div>

      <div class="grp"><label>Music</label>
        <select id="vMusic"><option value="">No music</option><option value="__upload">Upload MP3\u2026</option></select>
        <input type="file" id="vMusicFile" accept="audio/*" hidden>
        <div class="slider-row"><label>Volume</label><input type="range" id="vMusicVol" min="0" max="100" step="5" value="35"><span class="val" id="vMusicVolVal">35%</span></div>
        <div class="status" id="vMusicStatus"></div>
        <p class="hint">Music plays at this level throughout, with a 3s fade at the end. Set each clip's own level on its slide.</p></div>

      <div class="grp"><label>Outro CTA</label><textarea id="vCta"></textarea>
        <p class="hint" id="vOutroHint" hidden>VOICE ends on its own animated sting, so this CTA is not shown.</p></div>

      <button class="btn-primary" id="vExport">\u2B07 Export MP4</button>
      <div class="status" id="vStatus"></div>
    </aside>

    <div class="stage">
      <canvas id="vCanvas" width="${W}" height="${H}"></canvas>
      <div class="pbar" id="vPbar"><div></div></div>
      <div class="seg" style="width:260px">
        <button id="vPlay">\u25B6 Preview</button>
        <button id="vStop">\u23F9 Stop</button>
      </div>
    </div>`;

  const $ = s => host.querySelector(s);
  const canvas = $('#vCanvas'), ctx = canvas.getContext('2d');
  const off = document.createElement('canvas'); off.width = W; off.height = H;
  const offCtx = off.getContext('2d');

  function fit() {
    const stage = host.querySelector('.stage');
    const scale = Math.min((stage.clientHeight - 120) / H, (stage.clientWidth - 50) / W, 0.5);
    canvas.style.width = (W * scale) + 'px'; canvas.style.height = (H * scale) + 'px';
  }
  window.addEventListener('resize', () => { if (host.classList.contains('on')) fit(); });

  const status = (m, c) => { const el = $('#vStatus'); el.textContent = m; el.className = 'status ' + (c || ''); };
  const addStatus = (m, c) => { const el = $('#vAddStatus'); el.textContent = m; el.className = 'status ' + (c || ''); };
  const musicStatus = (m, c) => { const el = $('#vMusicStatus'); el.textContent = m; el.className = 'status ' + (c || ''); };

  /* ───────── timeline ───────── */
  function slideDur(s) {
    if (s.type === 'video') return Math.max(0.2, s.trimEnd - s.trimStart);
    return s.dur || PHOTO_SEC;
  }
  function timeline() {
    const segs = [];
    state.slides.forEach((s, i) => segs.push({ type: i === 0 ? 'hook' : 'body', slide: s, dur: slideDur(s) }));
    const oc = outros[state.brand];
    segs.push(oc ? { type: 'outro', outro: oc, dur: oc.trimEnd } : { type: 'outro', dur: OUTRO_SEC });
    let t = 0; segs.forEach(s => { s.start = t; t += s.dur; });
    return { segs, total: t };
  }

  /* Two segments are visible during a crossfade — which is why frames are resolved
     before drawing rather than inside it. */
  function visibleAt(tSec, tl) {
    const segs = tl.segs;
    let cur = segs[segs.length - 1];
    for (const s of segs) if (tSec >= s.start && tSec < s.start + s.dur) { cur = s; break; }
    const out = [{ seg: cur, local: Math.max(0, tSec - cur.start) }];
    const next = segs[segs.indexOf(cur) + 1];
    if (next && (cur.start + cur.dur - tSec) < XFADE) out.push({ seg: next, local: 0 });
    return out;
  }

  async function resolveAt(tSec, tl, mode) {
    for (const { seg, local } of visibleAt(tSec, tl)) {
      const s = vsrc(seg);
      if (!s || s.type !== 'video') continue;
      const lt = Math.min(s.trimStart + local, s.trimEnd - 0.001);
      if (mode === 'export') {
        // opened on first use and released once the segment is behind us —
        // seven simultaneous decoders is a lot of held memory for a sequential pass
        if (!s._reader) s._reader = s.clip.createExportReader(dbg);
        s._draw = await s._reader.frameAt(lt);
      } else { await s.clip.previewSeek(lt); s._draw = s.clip.el; }
    }
  }

  /* ───────── text placement ─────────
     textPos interpolates the block's last baseline between its original spot
     (pos 1 — exactly the old constants, so existing videos look unchanged) and
     the highest spot where the first line's upper marks still clear the logo.
     The range is computed per block, so a long hook and a one-line caption both
     use the full slider without either leaving the frame. */
  const TEXT_TOP_LIMIT = 290;          // logo mark sits ~65–220px from the top
  function textGeom(c, seg) {
    const isHook = seg.type === 'hook';
    const text = (isHook ? state.hook : seg.slide.caption) || '';
    const size = isHook ? state.hookSize : (seg.slide.size || state.capSize);
    const lh = Math.round(size * (isHook ? 1.55 : 1.64));
    const maxW = isHook ? W - 220 : W - 180;
    const defBottom = isHook ? H - 220 : H - 200;
    c.save(); c.font = `${size}px ${SC.FONT_HEAD}`; c.direction = 'rtl';
    const lines = text.trim() ? SC.wrapThaana(c, text, maxW) : [];
    c.restore();
    const blockH = lines.length * lh;
    const minBottom = Math.min(defBottom, TEXT_TOP_LIMIT + blockH - lh + size * 0.95);
    const bottom = Math.round(minBottom + (defBottom - minBottom) * state.textPos);
    return {
      isHook, size, lh, maxW, lines, blockH, defBottom, minBottom, bottom,
      top: lines.length ? bottom - blockH + lh - size * 0.95 : bottom
    };
  }
  let lastGeom = null;                 // geometry of the slide last drawn on the visible canvas

  /* Shade colours. White text sits on a black shade; on a white shade the text
     turns near-black, and the shade runs a little stronger because dark text
     on a busy photo needs more backing than white text does. */
  const SHADE = {
    dark:  { rgb: '0,0,0',       hold: 0.66, edge: 0.82, text: '#ffffff' },
    light: { rgb: '255,255,255', hold: 0.80, edge: 0.90, text: '#111111' }
  };
  const shade = () => SHADE[state.shade] || SHADE.dark;

  function drawScrim(c, g) {
    const sh = shade(), a = x => `rgba(${sh.rgb},${x})`;
    if (state.textPos >= 1 || !g.lines.length) {
      const lg = c.createLinearGradient(0, H * 0.45, 0, H);
      lg.addColorStop(0, a(0)); lg.addColorStop(1, a(sh.edge));
      c.fillStyle = lg; c.fillRect(0, H * 0.45, W, H * 0.55);
      return;
    }
    /* A band sized to the text: ramp in above, hold behind, ramp out below —
       or run on to the bottom edge when the block is close enough to it. */
    const top = Math.max(0, g.top - 220);
    const textBot = g.bottom + g.size * 0.34;
    const toEdge = textBot + 260 >= H;
    const end = toEdge ? H : textBot + 260;
    const span = end - top;
    const s1 = Math.max(0, Math.min(1, (g.top - 30 - top) / span));
    const s2 = Math.max(s1, Math.min(1, (textBot + 46 - top) / span));
    const lg = c.createLinearGradient(0, top, 0, end);
    lg.addColorStop(0, a(0));
    lg.addColorStop(s1, a(sh.hold));
    lg.addColorStop(s2, a(sh.hold));
    lg.addColorStop(1, toEdge ? a(sh.edge) : a(0));
    c.fillStyle = lg; c.fillRect(0, top, W, end - top);
  }

  /* ───────── drawing (synchronous — see resolveAt) ───────── */
  function drawSlide(c, seg, p) {
    const th = SC.THEME[state.brand];
    c.clearRect(0, 0, W, H);

    if (seg.type === 'outro' && seg.outro) {
      const o = seg.outro, src = o._draw;
      if (!src) { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); return; }
      const sw = src.displayWidth || src.videoWidth || o.clip.info.elementW;
      const sh = src.displayHeight || src.videoHeight || o.clip.info.elementH;
      const dh = Math.round(W * sh / sw), top = Math.round((H - dh) / 2);
      c.drawImage(src, 0, top, W, dh);
      if (top > 0) {
        // fill each band with the clip's own edge colour so the sting reads full-frame
        const edge = y => { const d = c.getImageData(W / 2, y, 1, 1).data; return `rgb(${d[0]},${d[1]},${d[2]})`; };
        c.fillStyle = edge(top + 2); c.fillRect(0, 0, W, top);
        c.fillStyle = edge(top + dh - 3); c.fillRect(0, top + dh, W, H - top - dh);
      }
      return;
    }

    if (seg.type === 'outro') {
      c.fillStyle = th.ink; c.fillRect(0, 0, W, H);
      const rg = c.createRadialGradient(W / 2, H * 0.35, 40, W / 2, H * 0.35, 700);
      rg.addColorStop(0, 'rgba(255,85,0,.08)'); rg.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = rg; c.fillRect(0, 0, W, H);

      const tSec = p * seg.dur;
      const la = SC.easeInOut(Math.min(1, tSec / 0.5));
      c.save(); c.globalAlpha = la; SC.drawLogoCentered(c, state.brand, W, H * 0.30, 380); c.restore();
      c.save(); c.globalAlpha = la; c.fillStyle = th.accent;
      c.fillRect((W - 120 * la) / 2, H * 0.48, 120 * la, 5); c.restore();

      c.save(); c.font = '58px ' + SC.FONT_HEAD; c.direction = 'rtl'; c.textAlign = 'center'; c.fillStyle = '#fff';
      const lines = SC.wrapThaana(c, activeCta(), W - 440);
      const lh = 120, baseY = H * 0.56;
      let wi = 0;
      lines.forEach((ln, li) => {
        const words = ln.split(/\s+/).filter(Boolean);
        let cursor = W / 2 + c.measureText(ln).width / 2;
        for (const w of words) {
          const ww = c.measureText(w + ' ').width;
          const wt = Math.min(1, Math.max(0, (tSec - (0.3 + wi * 0.08)) / 0.25));
          if (wt > 0) {
            c.save(); c.globalAlpha = SC.easeInOut(wt);
            const s = 0.5 + 0.5 * easeOutBack(wt);
            c.translate(cursor - ww / 2, baseY + li * lh); c.scale(s, s); c.fillText(w, 0, 0); c.restore();
          }
          cursor -= ww; wi++;
        }
      });
      c.restore();

      const nW = activeCta().split(/\s+/).filter(Boolean).length;
      const tS = Math.min(1, Math.max(0, (tSec - (0.3 + nW * 0.08 + 0.3)) / 0.4));
      c.save(); c.globalAlpha = SC.easeInOut(tS); c.translate(0, (1 - SC.easeInOut(tS)) * 20);
      c.font = 'bold 52px ' + getComputedStyle(document.body).fontFamily;
      c.textAlign = 'center'; c.fillStyle = th.accent;
      c.fillText(th.site, W / 2, baseY + lines.length * lh + 70);
      c.restore();
      return;
    }

    const s = seg.slide, idx = state.slides.indexOf(s);

    if (s.type === 'video') {
      if (s._draw) {
        ClipSource.drawClip(c, s._draw, W, H, {
          rotation: s.clip.info.rotation, fitMode: s.fitMode,
          zoom: s.zoom || 1, panX: s.panX || 0, panY: s.panY || 0
        });
      } else { c.fillStyle = '#000'; c.fillRect(0, 0, W, H); }
    } else {
      SC.drawPhotoFx(c, s.img, W, H, s.fx || (idx % 2 === 0 ? 'zoomIn' : 'zoomOut'), p, s.panX || 0, s.panY || 0);
    }

    const tg = textGeom(c, seg);
    if (c === ctx) lastGeom = tg;
    drawScrim(c, tg);

    const ov = overlays[state.brand];
    if (ov) {
      const oh = Math.round(W * ov.naturalHeight / ov.naturalWidth);
      c.drawImage(ov, 0, Math.round((H - oh) / 2), W, oh);
    } else SC.drawLogoTopRight(c, state.brand, W, 200);

    const tAnim = (p * seg.dur) / TEXT_ANIM_SEC;
    if (seg.type === 'hook') {
      // accent bar measures the same wrap as the text (it used W-160 and could miscount lines)
      const blockH = tg.blockH, be = SC.easeInOut(Math.min(1, tAnim));
      if (blockH) {
        c.save(); c.fillStyle = SC.THEME[state.brand].accent;
        c.fillRect(W - 88, tg.bottom - blockH + 20 + (blockH - 10) * (1 - be), 10, (blockH - 10) * be);
        c.restore();
      }
      drawAnimText(c, state.hook, W - 110, tg.bottom, tg.maxW, tg.size, tg.lh, shade().text, SC.FONT_HEAD, s.tanim || 'fadeUp', tAnim);
    } else {
      drawAnimText(c, s.caption, W - 90, tg.bottom, tg.maxW, tg.size, tg.lh, shade().text, SC.FONT_HEAD, s.tanim || 'fadeUp', tAnim);
    }

    const n = state.slides.length + 1;
    const dw = 10, gap = 14; let x0 = (W - (n * dw + (n - 1) * gap)) / 2;
    const active = seg.type === 'hook' ? 0 : idx;
    for (let i = 0; i < n; i++) {
      c.fillStyle = i === active ? SC.THEME[state.brand].accent : (state.shade === 'light' ? 'rgba(17,17,17,0.35)' : 'rgba(255,255,255,0.4)');
      c.beginPath(); c.arc(x0 + dw / 2, H - 70, dw / 2, 0, Math.PI * 2); c.fill();
      x0 += dw + gap;
    }
  }

  function drawFrame(c, tSec, tl) {
    const vis = visibleAt(tSec, tl);
    const cur = vis[0];
    drawSlide(c, cur.seg, Math.min(1, cur.local / cur.seg.dur));
    if (vis[1]) {
      const alpha = 1 - (cur.seg.start + cur.seg.dur - tSec) / XFADE;
      offCtx.clearRect(0, 0, W, H);
      drawSlide(offCtx, vis[1].seg, 0);
      c.save(); c.globalAlpha = alpha; c.drawImage(off, 0, 0); c.restore();
    }
  }

  /* ───────── preview ───────── */
  let raf = null, playT0 = 0, activeVid = null;
  const stopVids = () => { if (activeVid) { try { activeVid.clip.el.pause(); } catch (_) {} activeVid = null; } };

  async function play() {
    stop();
    if (!state.slides.length) return status('Add a slide first', 'err');
    await SC.ensureAssets(); await ensureBrand(state.brand);
    const tl = timeline();
    state.playing = true; playT0 = performance.now(); stillT = null;
    startMusic();
    const loop = async () => {
      if (!state.playing) return;
      const t = (performance.now() - playT0) / 1000;
      if (t >= tl.total) { stop(); await resolveAt(tl.total - 0.01, tl, 'preview'); drawFrame(ctx, tl.total - 0.01, tl); return; }

      const vis = visibleAt(t, tl);
      const cur = vsrc(vis[0].seg);
      if (cur && cur.type === 'video') {
        if (activeVid !== cur) {
          stopVids(); activeVid = cur;
          cur.clip.el.currentTime = cur.trimStart + vis[0].local;
          cur.clip.el.muted = !!cur.muted;
          // HTMLMediaElement.volume caps at 1, so >100% only shows up in the export
          cur.clip.el.volume = Math.max(0, Math.min(1, cur.gain == null ? 1 : cur.gain));
          cur.clip.el.play().catch(() => {});
        }
        cur._draw = cur.clip.el;
      } else if (activeVid) stopVids();

      const nx = vis[1] && vsrc(vis[1].seg);
      if (nx && nx.type === 'video') {
        await nx.clip.previewSeek(nx.trimStart);
        nx._draw = nx.clip.el;
      }

      drawFrame(ctx, t, tl);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function stop() {
    state.playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null; stopVids(); stopMusic();
  }

  async function redrawStill() {
    if (state.playing || state.exporting) return;
    if (!state.slides.length) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H); return; }
    await SC.ensureAssets(); await ensureBrand(state.brand);
    const tl = timeline();
    await resolveAt(0.7, tl, 'preview');
    drawFrame(ctx, 0.7, tl);
    stillT = 0.7;
  }

  /* Redraw the current still without seeking — the frames resolved for it are
     still on each slide's _draw, so a drag can repaint every animation frame. */
  let stillT = null;
  function repaintStill() {
    if (state.playing || state.exporting || stillT == null || !state.slides.length) return;
    drawFrame(ctx, stillT, timeline());
  }

  async function showSlide(i) {
    if (state.playing || state.exporting) return;
    await SC.ensureAssets(); await ensureBrand(state.brand);
    const tl = timeline();
    const seg = tl.segs.find(s => s.slide === state.slides[i]);
    if (!seg) return redrawStill();
    const t = seg.start + Math.min(seg.dur * 0.5, 1.2);
    await resolveAt(t, tl, 'preview');
    drawFrame(ctx, t, tl);
    stillT = t;
  }

  /* ───────── audio ───────── */
  let audioCtx = null, previewSrc = null, previewGain = null;
  const getCtx = () => audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());

  async function decodeMusic(buf, name) {
    const sn = SC.sniffAudio(buf);
    if (!sn.ok) { state.music = null; return musicStatus('Not audio: ' + sn.fmt, 'err'); }
    try {
      const b = await getCtx().decodeAudioData(buf.slice(0));
      state.music = { name, buffer: b };
      musicStatus('\u266B ' + name + ' \u2014 ' + b.duration.toFixed(0) + 's \u2713', 'ok');
    } catch (e) { state.music = null; musicStatus('Decode failed: ' + e.message, 'err'); }
  }
  function startMusic() {
    if (!state.music) return;
    stopMusic();
    const c = getCtx(); if (c.state === 'suspended') c.resume();
    previewSrc = c.createBufferSource(); previewSrc.buffer = state.music.buffer; previewSrc.loop = true;
    previewGain = c.createGain(); previewGain.gain.value = state.musicVol;
    previewSrc.connect(previewGain).connect(c.destination);
    previewSrc.start(0);
  }
  function stopMusic() {
    if (previewSrc) { try { previewSrc.stop(); } catch (_) {} previewSrc.disconnect(); previewSrc = null; }
  }

  /* Music sits at a flat level with a 3s tail fade. Per-clip levels are set on each
     slide instead of being ducked automatically — automatic ducking collapsed to near
     silence on reels where clips cover most of the timeline. */
  function applyMusicGain(param, total) {
    const vol = Math.max(0.0001, state.musicVol);
    const FADE = Math.min(3.0, total * 0.4);
    param.setValueAtTime(vol, 0);
    if (total > FADE) {
      param.setValueAtTime(vol, total - FADE);
      param.exponentialRampToValueAtTime(0.0001, total);
    }
  }

  async function renderAudio(total, tl) {
    const SR = 48000;
    const oac = new OfflineAudioContext(2, Math.ceil(total * SR), SR);
    let any = false;

    if (state.music && state.musicVol > 0) {
      const src = oac.createBufferSource();
      src.buffer = state.music.buffer; src.loop = true;
      const g = oac.createGain();
      applyMusicGain(g.gain, total);
      src.connect(g).connect(oac.destination);
      src.start(0); any = true;
      dbg('music: ' + state.music.name + ' at ' + Math.round(state.musicVol * 100) + '%');
    }
    for (const seg of tl.segs) {
      const s = vsrc(seg);
      if (!s || s.type !== 'video' || s.muted || !s.audioBuf) continue;
      const gain = s.gain == null ? 1 : s.gain;
      if (gain <= 0) continue;
      const src = oac.createBufferSource(); src.buffer = s.audioBuf;
      const g = oac.createGain(); g.gain.value = gain;
      src.connect(g).connect(oac.destination);
      try {
        src.start(seg.start, s.trimStart, seg.dur); any = true;
        dbg('clip audio at ' + seg.start.toFixed(1) + 's, ' + Math.round(gain * 100) + '%');
      } catch (e) { dbg('clip audio skipped: ' + e.message); }
    }
    if (!any) return null;
    return oac.startRendering();
  }

  async function encodeAudioBuffer(buffer, encoder) {
    const SR = buffer.sampleRate, CH = buffer.numberOfChannels, CHUNK = 9600;
    const chans = []; for (let c = 0; c < CH; c++) chans.push(buffer.getChannelData(c));
    for (let start = 0; start < buffer.length; start += CHUNK) {
      const frames = Math.min(CHUNK, buffer.length - start);
      const data = new Float32Array(frames * CH);
      for (let c = 0; c < CH; c++) data.set(chans[c].subarray(start, start + frames), c * frames);
      const ad = new AudioData({
        format: 'f32-planar', sampleRate: SR, numberOfFrames: frames,
        numberOfChannels: CH, timestamp: Math.round(start / SR * 1e6), data
      });
      encoder.encode(ad); ad.close();
      if (encoder.encodeQueueSize > 10) await new Promise(r => setTimeout(r, 10));
    }
    await encoder.flush();
  }

  /* ───────── export ───────── */
  const ensureMuxer = () => window.Mp4Muxer ? Promise.resolve() : new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = MP4MUXER_CDN; s.onload = res; s.onerror = rej;
    document.head.appendChild(s);
  });

  async function exportMp4() {
    if (state.exporting) return;
    if (!state.slides.length) return status('Add slides first', 'err');
    if (!state.hook.trim()) return status('Write a hook headline first', 'err');
    if (!('VideoEncoder' in window)) return status('WebCodecs unavailable \u2014 use Chrome or Edge', 'err');

    const bad = state.slides.find(s => s.type === 'video' && s.clip.info.exportPath !== 'webcodecs');
    if (bad) return status('A clip cannot be decoded for export \u2014 remove it or re-encode as H.264', 'err');

    state.exporting = true; stop();
    const btn = $('#vExport'); btn.disabled = true;
    const pbar = $('#vPbar'); pbar.classList.add('on');

    const outro = await ensureBrand(state.brand);
    const releaseReaders = () => {
      for (const s of state.slides.concat(outro ? [outro] : [])) {
        if (s._reader) { try { s._reader.close(); } catch (_) {} s._reader = null; }
      }
    };

    try {
      status('Loading encoder\u2026', 'work');
      await ensureMuxer(); await SC.ensureAssets();
      const tl = timeline();
      const totalFrames = Math.ceil(tl.total * FPS);

      const hasClipAudio = state.slides.concat(outro ? [outro] : []).some(s => s.type === 'video' && !s.muted && s.audioBuf && (s.gain == null || s.gain > 0));
      const withAudio = !!(((state.music && state.musicVol > 0) || hasClipAudio) && 'AudioEncoder' in window);

      const muxer = new Mp4Muxer.Muxer({
        target: new Mp4Muxer.ArrayBufferTarget(),
        video: { codec: 'avc', width: W, height: H },
        audio: withAudio ? { codec: 'aac', sampleRate: 48000, numberOfChannels: 2 } : undefined,
        fastStart: 'in-memory'
      });

      /* Errors thrown from inside an encoder callback become unhandled rejections and
         the try/catch never sees them — flush() would then hang forever. Capture instead. */
      let encError = null;
      const enc = new VideoEncoder({
        output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
        error: e => { encError = encError || e; }
      });
      enc.configure({ codec: 'avc1.640028', width: W, height: H, bitrate: 9_000_000, framerate: FPS });

      status('Rendering frames\u2026', 'work');
      const usPerFrame = Math.round(1e6 / FPS);
      const t0 = performance.now();

      for (let i = 0; i < totalFrames; i++) {
        if (encError) throw encError;
        const t = i / FPS;
        await resolveAt(t, tl, 'export');
        drawFrame(ctx, t, tl);
        const frame = new VideoFrame(canvas, { timestamp: i * usPerFrame, duration: usPerFrame });
        enc.encode(frame, { keyFrame: i % (FPS * 2) === 0 });
        frame.close();

        /* Bound the encoder queue every frame. Without this the loop races ahead,
           leaves ~1000 undrained frames resident, and all the real encoding lands
           inside flush() where nothing reports progress. */
        while (enc.encodeQueueSize > 6) {
          await new Promise(r => setTimeout(r, 4));
          if (encError) throw encError;
        }

        if (i % 5 === 0) {
          const pct = Math.round((i / totalFrames) * 100);
          pbar.firstElementChild.style.width = Math.round(pct * 0.85) + '%';
          status('Rendering \u2014 ' + pct + '%', 'work');
          // release decoders for slides fully behind the playhead
          for (const seg of tl.segs) {
            const s = vsrc(seg);
            if (s && s._reader && t > seg.start + seg.dur + 0.2) {
              try { s._reader.close(); } catch (_) {}
              s._reader = null;
            }
          }
          await new Promise(r => setTimeout(r, 0));
        }
      }
      dbg('video pass: ' + ((performance.now() - t0) / 1000).toFixed(1) + 's for ' + totalFrames + ' frames');
      releaseReaders();

      status('Finalising video\u2026', 'work');
      const flushing = enc.flush();
      const poll = setInterval(() => {
        status('Finalising \u2014 ' + enc.encodeQueueSize + ' frames left', 'work');
      }, 300);
      await flushing;
      clearInterval(poll);
      if (encError) throw encError;
      enc.close();

      if (withAudio) {
        status('Mixing audio\u2026', 'work');
        pbar.firstElementChild.style.width = '92%';
        const buf = await renderAudio(tl.total, tl);
        if (buf) {
          const aEnc = new AudioEncoder({ output: (c, m) => muxer.addAudioChunk(c, m), error: e => { throw e; } });
          aEnc.configure({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
          await encodeAudioBuffer(buf, aEnc);
          aEnc.close();
          dbg('audio mixed: music ' + (state.music ? 'yes' : 'no') + ', clip audio ' + (hasClipAudio ? 'yes' : 'no'));
        }
      }

      muxer.finalize();
      pbar.firstElementChild.style.width = '100%';
      const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = state.brand + '-video-' + Date.now() + '.mp4';
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      status('Done \u2014 ' + (blob.size / 1048576).toFixed(1) + ' MB, ' + Math.round(tl.total) + 's \u2713', 'ok');
    } catch (err) {
      console.error(err);
      status('Export failed: ' + (err.message || err), 'err');
    } finally {
      releaseReaders();
      state.exporting = false; btn.disabled = false;
      setTimeout(() => { pbar.classList.remove('on'); pbar.firstElementChild.style.width = '0%'; }, 1500);
    }
  }

  /* ───────── slide list ───────── */
  let building = false;
  const touch = i => { if (!building) showSlide(i); };

  function mkRange(label, min, max, val, step, oninput) {
    const r = document.createElement('div'); r.className = 'slider-row';
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input');
    i.type = 'range'; i.min = min; i.max = max; i.step = step || 1; i.value = val;
    const v = document.createElement('span'); v.className = 'val';
    const upd = () => v.textContent = oninput(+i.value);
    i.addEventListener('input', upd); upd();
    r.append(l, i, v); return r;
  }

  function renderSlides() {
    building = true;
    const wrap = $('#vSlides'); wrap.innerHTML = '';
    state.slides.forEach((s, i) => {
      const row = document.createElement('div');
      row.className = 'slideRow' + (s.type === 'video' ? ' vidRow' : '');

      let thumb;
      if (s.type === 'photo') { thumb = document.createElement('img'); thumb.className = 'thumb'; thumb.src = s.img.src; }
      else { thumb = s.thumbCanvas; thumb.className = 'thumb'; }

      const col = document.createElement('div');
      col.style.cssText = 'flex:1;min-width:0';

      const hdr = document.createElement('div');
      hdr.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:5px';
      const lab = document.createElement('div');
      lab.style.cssText = 'font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em';
      const labelText = () => (i === 0 ? 'Slide 1 \u2014 hook' : 'Slide ' + (i + 1)) +
        ' <span class="vKind">' + (s.type === 'video' ? 'VIDEO ' + slideDur(s).toFixed(1) + 's' : 'PHOTO') + '</span>';
      lab.innerHTML = labelText();

      const arrows = document.createElement('div'); arrows.className = 'vArrows';
      if (i > 0) {
        const up = document.createElement('button'); up.textContent = '\u25B2';
        up.addEventListener('click', () => { [state.slides[i - 1], state.slides[i]] = [state.slides[i], state.slides[i - 1]]; renderSlides(); redrawStill(); });
        arrows.appendChild(up);
      }
      if (i < state.slides.length - 1) {
        const dn = document.createElement('button'); dn.textContent = '\u25BC';
        dn.addEventListener('click', () => { [state.slides[i], state.slides[i + 1]] = [state.slides[i + 1], state.slides[i]]; renderSlides(); redrawStill(); });
        arrows.appendChild(dn);
      }
      hdr.append(lab, arrows); col.appendChild(hdr);

      if (s.type === 'video') {
        const d = s.clip.info.duration;
        col.appendChild(mkRange('In', 0, Math.round(d * 100), Math.round(s.trimStart * 100), 1, v => {
          s.trimStart = Math.min(v / 100, s.trimEnd - 0.2);
          lab.innerHTML = labelText(); touch(i);
          return s.trimStart.toFixed(2) + 's';
        }));
        col.appendChild(mkRange('Out', 0, Math.round(d * 100), Math.round(s.trimEnd * 100), 1, v => {
          s.trimEnd = Math.max(v / 100, s.trimStart + 0.2);
          lab.innerHTML = labelText(); touch(i);
          return s.trimEnd.toFixed(2) + 's';
        }));

        const seg = document.createElement('div'); seg.className = 'miniseg';
        [['cover', 'Cover'], ['fit', 'Fit + blur']].forEach(([v, t]) => {
          const b = document.createElement('button'); b.textContent = t;
          if (s.fitMode === v) b.classList.add('on');
          b.addEventListener('click', () => { s.fitMode = v; renderSlides(); showSlide(i); });
          seg.appendChild(b);
        });
        const mute = document.createElement('button');
        mute.textContent = s.muted ? '\u{1F507} Muted' : '\u{1F50A} Audio';
        if (!s.muted) mute.classList.add('on');
        mute.addEventListener('click', () => { s.muted = !s.muted; renderSlides(); });
        seg.appendChild(mute);
        col.appendChild(seg);

        if (s.audioBuf) {
          col.appendChild(mkRange('Vol', 0, 150, Math.round((s.gain == null ? 1 : s.gain) * 100), 5, v => {
            s.gain = v / 100;
            return v + '%';
          }));
        }
      } else {
        col.appendChild(mkRange('Secs', 15, 90, Math.round((s.dur || PHOTO_SEC) * 10), 1, v => {
          s.dur = v / 10; lab.innerHTML = labelText(); return (v / 10).toFixed(1) + 's';
        }));
        const fx = document.createElement('select'); fx.style.marginTop = '6px';
        Object.keys(SC.FX).forEach(k => {
          const o = document.createElement('option'); o.value = k; o.textContent = 'Effect: ' + SC.FX[k]; fx.appendChild(o);
        });
        fx.value = s.fx || (i % 2 === 0 ? 'zoomIn' : 'zoomOut'); s.fx = fx.value;
        fx.addEventListener('change', () => { s.fx = fx.value; showSlide(i); });
        col.appendChild(fx);
      }

      col.appendChild(mkRange('Pan X', -100, 100, (s.panX || 0) * 100, 1, v => { s.panX = v / 100; touch(i); return v; }));
      col.appendChild(mkRange('Pan Y', -100, 100, (s.panY || 0) * 100, 1, v => { s.panY = v / 100; touch(i); return v; }));

      if (i > 0) {
        const ta = document.createElement('textarea');
        ta.value = s.caption || ''; ta.style.marginTop = '6px';
        ta.addEventListener('input', () => { s.caption = ta.value; showSlide(i); });
        col.appendChild(ta);
        col.appendChild(mkRange('Size', 36, 96, s.size || state.capSize, 2, v => { s.size = v; touch(i); return v; }));
      }

      const tsel = document.createElement('select'); tsel.style.marginTop = '6px';
      Object.keys(TANIM).forEach(k => {
        const o = document.createElement('option'); o.value = k; o.textContent = 'Text: ' + TANIM[k]; tsel.appendChild(o);
      });
      tsel.value = s.tanim || 'fadeUp'; s.tanim = tsel.value;
      tsel.addEventListener('change', () => { s.tanim = tsel.value; showSlide(i); });
      col.appendChild(tsel);

      const rm = document.createElement('button');
      rm.style.cssText = 'background:none;border:none;color:var(--err);cursor:pointer;font-size:15px;padding:2px 4px;flex:none';
      rm.textContent = '\u00D7';
      rm.addEventListener('click', () => {
        if (s.type === 'video') s.clip.close();
        state.slides.splice(i, 1); renderSlides(); redrawStill();
      });

      row.append(thumb, col, rm);
      wrap.appendChild(row);
    });
    building = false;
  }

  /* ───────── ingest ───────── */
  $('#vPhotos').addEventListener('change', async e => {
    for (const f of e.target.files) {
      if (state.slides.length >= MAX_SLIDES) break;
      const img = await SC.loadImage(URL.createObjectURL(f));
      state.slides.push({ type: 'photo', img, caption: '', dur: PHOTO_SEC, panX: 0, panY: 0 });
    }
    e.target.value = ''; renderSlides(); redrawStill();
  });

  $('#vVideos').addEventListener('change', async e => {
    for (const f of e.target.files) {
      if (state.slides.length >= MAX_SLIDES) { addStatus('Slide limit reached', 'err'); break; }
      addStatus('Reading ' + f.name + '\u2026', 'work');
      try {
        const clip = await ClipSource.open(f, dbg);
        const audioBuf = await clip.decodeAudio(getCtx());

        const thumb = document.createElement('canvas'); thumb.width = 88; thumb.height = 156;
        await clip.previewSeek(Math.min(0.5, clip.info.duration / 2));
        ClipSource.drawClip(thumb.getContext('2d'), clip.el, thumb.width, thumb.height,
          { rotation: clip.info.rotation, fitMode: 'cover' });

        const q = clip.info.quality;
        state.slides.push({
          type: 'video', clip, audioBuf, thumbCanvas: thumb,
          trimStart: 0, trimEnd: Math.min(clip.info.duration, 5),
          fitMode: q.verdict === 'poor' ? 'fit' : 'cover',
          muted: false, gain: 1, panX: 0, panY: 0, zoom: 1,
          caption: '', tanim: 'fadeUp'
        });

        if (clip.info.exportPath !== 'webcodecs') {
          addStatus(f.name + ' \u2014 cannot be decoded for export. Re-encode as H.264.', 'err');
        } else if (q.verdict !== 'good') {
          addStatus(f.name + ' \u2014 ' + q.scaleCover + '\u00D7 enlargement. ' + q.note, q.verdict === 'poor' ? 'err' : '');
        } else {
          addStatus(f.name + ' added \u2713', 'ok');
        }
      } catch (err) {
        console.error(err);
        addStatus('Could not read ' + f.name + ': ' + (err.message || err), 'err');
      }
    }
    e.target.value = ''; renderSlides(); redrawStill();
  });

  /* ───────── wiring ───────── */
  $('#vBrand').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    $('#vBrand').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); state.brand = b.dataset.v;
    if (!state.cta) $('#vCta').value = activeCta();
    $('#vOutroHint').hidden = !OUTRO_CLIPS[state.brand];
    redrawStill();
  }));
  $('#vShade').querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    $('#vShade').querySelectorAll('button').forEach(x => x.classList.remove('on'));
    b.classList.add('on'); state.shade = b.dataset.v;
    repaintStill();
  }));
  $('#vHook').addEventListener('input', e => { state.hook = e.target.value; redrawStill(); });
  $('#vHookSize').addEventListener('input', e => {
    state.hookSize = +e.target.value; $('#vHookSizeVal').textContent = e.target.value; redrawStill();
  });
  /* text position — slider and canvas drag write the same value */
  const posLabel = v => v >= 100 ? 'Bottom' : v <= 0 ? 'Top' : v + '%';
  let repaintQueued = false;
  function setTextPos(v) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    state.textPos = v / 100;
    $('#vTextPos').value = v; $('#vTextPosVal').textContent = posLabel(v);
    if (repaintQueued) return;
    repaintQueued = true;
    requestAnimationFrame(() => { repaintQueued = false; repaintStill(); });
  }
  $('#vTextPos').addEventListener('input', e => setTextPos(+e.target.value));

  canvas.style.cursor = 'ns-resize';
  canvas.style.touchAction = 'none';    // a finger drag moves the text, not the page
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    if (state.playing || state.exporting || !state.slides.length) return;
    if (stillT == null) { redrawStill(); return; }
    const g = lastGeom;
    if (!g || g.defBottom <= g.minBottom) return;   // block already fills its whole range
    drag = {
      id: e.pointerId, y0: e.clientY, bottom0: g.bottom, g,
      scale: H / canvas.getBoundingClientRect().height
    };
    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const b = drag.bottom0 + (e.clientY - drag.y0) * drag.scale;
    setTextPos((b - drag.g.minBottom) / (drag.g.defBottom - drag.g.minBottom) * 100);
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  $('#vCta').addEventListener('input', e => { state.cta = e.target.value; });
  $('#vMusicVol').addEventListener('input', e => {
    state.musicVol = +e.target.value / 100; $('#vMusicVolVal').textContent = e.target.value + '%';
    if (previewGain) previewGain.gain.value = state.musicVol;
  });
  $('#vMusicFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    await decodeMusic(await f.arrayBuffer(), f.name.replace(/\.[^.]+$/, ''));
    e.target.value = '';
  });
  $('#vMusic').addEventListener('change', async e => {
    const v = e.target.value;
    if (v === '__upload') return $('#vMusicFile').click();
    if (!v) { state.music = null; return musicStatus(''); }
    if (v.startsWith('f:')) {
      musicStatus('Loading\u2026', 'work');
      try {
        const r = await fetch(v.slice(2));
        await decodeMusic(await r.arrayBuffer(), e.target.selectedOptions[0].textContent.replace('\u266B ', ''));
      } catch (err) { musicStatus('Failed: ' + err.message, 'err'); }
    }
  });
  $('#vExport').addEventListener('click', exportMp4);
  $('#vPlay').addEventListener('click', play);
  $('#vStop').addEventListener('click', () => { stop(); redrawStill(); });

  async function loadTrackList() {
    try {
      const r = await fetch('/audio/tracks.json', { cache: 'no-store' });
      if (!r.ok) return;
      const list = await r.json();
      if (!Array.isArray(list)) return;
      const sel = $('#vMusic'), up = sel.querySelector('option[value="__upload"]');
      list.forEach(t => {
        if (!t || !t.name || !t.file) return;
        const o = document.createElement('option');
        o.value = 'f:' + t.file; o.textContent = '\u266B ' + t.name;
        sel.insertBefore(o, up);
      });
    } catch (_) {}
  }

  $('#vCta').value = activeCta();
  $('#vOutroHint').hidden = !OUTRO_CLIPS[state.brand];
  loadTrackList();
  SC.ensureAssets().then(redrawStill);
  setTimeout(fit, 50);
})();
