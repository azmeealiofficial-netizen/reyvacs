/* card-studio.js — Photo Post workspace (canvas-rendered, PNG export)
 * 4 templates: Quote, Headline, Stat, News — ported from social-cards.js
 * Features: photo drag-to-reposition, AI cutout, accent picker, export res, auto-date
 */
(function () {
  const SC = window.StudioCore;

  /* Brand<->host mapping is derived from THEME so adding an outlet means one THEME
   * entry, not a new branch in every regex and if/else that touches URLs. */
  const BRAND_KEYS  = Object.keys(SC.THEME);
  const BRAND_SITES = BRAND_KEYS.map(k => SC.THEME[k].site).filter(Boolean);
  /* The link as printed in a card footer. A hosted-Fanvaiy story link
   * (dhuvas.mv/story/15-10-2026-0953-vaki-gaumegge-…, voice.mv/story/<uuid>)
   * runs off the card, so it prints as the bare host — what the relay's
   * Telegram cards do (relay/card.js shortUrl). Old numeric links
   * (dhuvas.mv/303990) stay as they were. Only the drawing uses this:
   * state.c.url keeps the full link for posting. */
  const footUrl = u => /^[^/]+\/story\//i.test(String(u || '')) ? String(u).replace(/\/.*$/, '') : (u || '');
  /* The accent bar, the "Read More" chevron and several template rules are drawn
   * with state.accent — a picker value, NOT the brand theme. That was invisible
   * while both outlets happened to be #ff5500; a brand whose accent differs
   * renders its own logo beside the other brand's accent colour.
   * Following d676a9f: a brand toggle must not silently discard a real choice, so
   * only auto-swap when the current accent is still one of the brand defaults. */
  /* Default headline size per brand and format.
   * Thaana is set at a larger em than Latin to reach the same optical size, so
   * VOICE EN reusing the Thaana brands' 60 makes an English headline wrap a line
   * further than the supplied design does. These are only DEFAULTS — the slider
   * still overrides, and a value the user has moved is left alone below. */
  const HEAD_DEFAULT_DV = { portrait: 60, square: 55, story: 90 };
  const HEAD_DEFAULTS   = { voice_en: { portrait: 50, square: 46, story: 78 },
                            reyva:    { portrait: 55, square: 50, story: 60 } };
  function defaultHeadSize(brand, size) {
    const b = HEAD_DEFAULTS[brand];
    return (b && b[size]) || HEAD_DEFAULT_DV[size] || 60;
  }
  /* Same rule as syncAccentToBrand (d676a9f): a brand toggle must not silently
   * discard a real choice, so only re-default when the current value is still one
   * of the defaults for the format in play. */
  function syncHeadSizeToBrand() {
    const cur = state.headSize;
    const isDefault = BRAND_KEYS.some(k => defaultHeadSize(k, state.size) === cur);
    if (!isDefault) return;
    state.headSize = defaultHeadSize(state.brand, state.size);
  }

  /* Voice Sports (SC.VARIANTS.voice_sport) is a VOICE story on its own card, not
   * an outlet: it only applies while VOICE is the outlet, so switching away and
   * back keeps the choice without ever painting another brand blue. */
  const SPORT = SC.VARIANTS.voice_sport;
  const sportOn = () => !!state.sport && state.brand === SPORT.brand;

  function syncAccentToBrand() {
    const defaults = BRAND_KEYS.map(k => (SC.THEME[k].accent || '').toLowerCase())
      .concat(Object.keys(SC.VARIANTS).map(k => SC.VARIANTS[k].accent.toLowerCase()));
    if (!defaults.includes((state.accent || '').toLowerCase())) return;   // bespoke, leave it
    state.accent = sportOn() ? SPORT.accent : SC.THEME[state.brand].accent;
    const inp = $('#cAccent'); if (inp) inp.value = state.accent;
  }

  /* The toggle is only offered on VOICE. Fetching a link or loading a queue item
   * sets it from the article's own section, so a sports story lands on the
   * sports card without anyone remembering to tick it. */
  function syncSportToggle() {
    const row = $('#cSportRow'), chk = $('#cSportChk');
    if (row) row.style.display = state.brand === SPORT.brand ? 'flex' : 'none';
    if (chk) chk.checked = !!state.sport;
  }
  function setSport(on) { state.sport = !!on; syncSportToggle(); syncAccentToBrand(); }

  /* Which brands actually have a Telegram channel / X account wired up. Buttons for
   * unconfigured brands are hidden rather than shown-and-failing.
   * null means "not known yet" — on a failed lookup the buttons stay visible, since
   * the server validates anyway and a transient fetch error should not silently
   * remove working DHUVAS buttons. */
  let shareTargets = null;

  function applyShareButtons() {
    const tg = $('#cShareTg'), tw = $('#cShareX'), vb = $('#cShareVb'), fb = $('#cShareFb'), row = $('#cShareRow');
    if (!tg || !tw || !vb || !fb) return;
    const t = shareTargets ? (shareTargets[state.brand] || { telegram: false, x: false, viber: false, facebook: false })
                           : { telegram: true, x: true, viber: true, facebook: true };
    tg.style.display = t.telegram ? '' : 'none';
    tw.style.display = t.x ? '' : 'none';
    vb.style.display = t.viber ? '' : 'none';
    fb.style.display = t.facebook ? '' : 'none';
    if (row) row.style.display = (t.telegram || t.x || t.viber || t.facebook) ? 'flex' : 'none';
  }

  async function loadShareTargets() {
    try {
      const r = await fetch('/api/share/targets');
      const d = await r.json();
      if (!r.ok || !d.targets) throw new Error(d.error || ('HTTP ' + r.status));
      shareTargets = d.targets;
    } catch (e) {
      console.warn('[card] share targets unavailable, leaving buttons visible:', e.message);
      shareTargets = null;
    }
    applyShareButtons();
  }

  function brandFromUrl(u) {
    const m = String(u || '').match(/^https?:\/\/(?:www\.)?([^/?#]+)/i);
    const host = m ? m[1].toLowerCase() : '';
    return BRAND_KEYS.find(k => {
      const s = (SC.THEME[k].site || '').toLowerCase();
      return s && (host === s || host.endsWith('.' + s));
    }) || null;
  }
  const SIZES = {
    portrait: { w: 1080, h: 1350, label: '4:5 Feed' },
    square:   { w: 1080, h: 1080, label: '1:1 Square' },
    story:    { w: 1080, h: 1920, label: '9:16 Story' }
  };

  // REYVA: the news card. reyva-card.js also draws Reyva's quote card; add
  // 'quote' here to offer it (parked by Azmee 2026-11-16, "later").
  const TEMPLATES = ['news'];
  const TPL_META = {
    news:     { label: 'News',     desc: 'photo + headline panel' },
    quote:    { label: 'Quote',    desc: 'photo + quote panel' }
  };

  const FIELDS = {
    quote:    [['pullQuote','Pull-quote','area'],['attrib1','Attribution role','text'],['attrib2','Attribution name','text']],
    headline: [['headline','Headline','area'],['date','Date','text'],['url','URL','ltr']],
    stat:     [['eyebrow','Eyebrow','text'],['statNumber','Number','ltr'],['statLabel','Number label','text'],['headline','Headline','area'],['bullet1','Bullet 1','area'],['bullet2','Bullet 2','area']],
    news:     [['headline','Headline','area'],['date','Date','text'],['url','Website','ltr']]
  };

  /* The editor must offer exactly the fields the card draws. VOICE EN's design has
   * a category flag and no date or URL row, so offering Date and Website there
   * would be three inputs that change nothing on screen — the kind of thing someone
   * fills in, exports, and only then notices never appeared. */
  const BRAND_FIELDS = {
    voice_en: { news: [['eyebrow','Category flag','text'],['headline','Headline','area']] },
    // REYVA: the fields reyva-card.js draws, and nothing else.
    reyva: {
      news:  [['headline','Headline','area'],['eyebrow','Category word beside the logo (optional)','text'],['url','Link','ltr']],
      quote: [['pullQuote','Quote','area'],['attrib1','Role (first small line)','text'],['attrib2','Name (second small line)','text'],['url','Link','ltr']]
    }
  };
  function fieldsFor(tpl, brand) {
    return (BRAND_FIELDS[brand] && BRAND_FIELDS[brand][tpl]) || FIELDS[tpl];
  }

  function todayDhivehi() {
    const d = new Date();
    const months = [
      '\u0796\u07AC\u0782\u07AA\u0787\u07A6\u0783\u07A9',
      '\u078A\u07AC\u0784\u07B0\u0783\u07AA\u0787\u07A6\u0783\u07A9',
      '\u0789\u07A7\u0783\u07A8\u0797\u07B0',
      '\u0787\u07AD\u0795\u07B0\u0783\u07A9\u078D\u07B0',
      '\u0789\u07AD',
      '\u0796\u07AB\u0782\u07B0',
      '\u0796\u07AA\u078D\u07A6\u0787\u07A8',
      '\u0787\u07AF\u078E\u07A6\u0790\u07B0\u0793\u07B0',
      '\u0790\u07AC\u0795\u07B0\u0793\u07AC\u0789\u07B0\u0784\u07A6\u0783\u07B0',
      '\u0787\u07AE\u0786\u07B0\u0793\u07AF\u0784\u07A6\u0783\u07B0',
      '\u0782\u07AE\u0788\u07AC\u0789\u07B0\u0784\u07A6\u0783\u07B0',
      '\u0791\u07A8\u0790\u07AC\u0789\u07B0\u0784\u07A6\u0783\u07B0'
    ];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* Malé is UTC+5 with no DST, so the browser's own clock is correct for staff in
   * the newsroom and this deliberately does not do timezone arithmetic — same
   * assumption todayDhivehi() has always made. */
  function todayEnglish() {
    const d = new Date();
    const months = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
  }

  /* Every place that stamped the card used to call todayDhivehi() directly, which
   * would have printed Thaana month names on an English card. Route them all
   * through here; anything not LTR keeps the exact previous behaviour. */
  function todayFor(brand) { return SC.isLtr(brand) ? todayEnglish() : todayDhivehi(); }

  const state = {
    brand: 'reyva', tpl: 'news', size: 'portrait', res: 2,
    accent: '#3a97cb', headSize: 55, sport: false,
    reyvaPal: 'red',    // REYVA: card colourway — 'red' (default) | 'blue'
    photo: null, photoImg: null, cut: null, cutOn: false,
    photoPos: { x: 0, y: 0 },
    fbCaption: '',
    c: {
      headline: '\u0788\u07a9 \u0787\u07ac\u0786\u07b0\u0790\u07b0 \u0791\u07a9 \u0786\u07b0\u0783\u07a8\u0787\u07ad\u0793\u07a8\u0788\u07b0 \u0790\u07b0\u0793\u07ab\u0791\u07a8\u0787\u07af \u0787\u07a6\u0781\u07b0 \u0789\u07a6\u0783\u07b0\u079a\u07a6\u0784\u07a7',
      pullQuote: '\u0783\u07A7\u0787\u07B0\u0796\u07AD\u078E\u07AC \u078C\u07A6\u0783\u07A6\u0787\u07B0\u078E\u07A9\u0787\u07A6\u0781\u07B0 \u0787\u07AC\u0782\u07B0\u0789\u07AC \u0789\u07AA\u0780\u07A8\u0787\u07B0\u0789\u07A9 \u0792\u07AA\u0788\u07A7\u0782\u07AA\u0782\u07B0\u078E\u07AC \u0784\u07A6\u0787\u07A8\u0788\u07AC\u0783\u07A8\u0788\u07AA\u0782\u07B0',
      attrib1: '\u0783\u07A6\u0787\u07A8\u0790\u07AA\u078D\u07B0\u0796\u07AA\u0789\u07B0\u0780\u07AB\u0783\u07A8\u0787\u07B0\u0794\u07A7',
      attrib2: '\u0791\u07A6\u0783. \u0789\u07AA\u0781\u07A6\u0789\u07A8\u0789\u07A6\u078B\u07AA \u0789\u07AA\u0787\u07A8\u0787\u07B0\u0792\u07AA',
      eyebrow: '\u078A\u07A6\u078C\u07AA\u0783\u07AA\u0788\u07AC\u0783\u07A8\u0786\u07A6\u0782\u07B0',
      statNumber: '1.29',
      statLabel: '\u0784\u07A8\u078D\u07A8\u0787\u07A6\u0782\u07B0 \u0791\u07AE\u078D\u07A6\u0783\u07AA',
      bullet1: '\u078A\u07AA\u0783\u07A6\u078C\u07A6\u0789\u07A6 \u0780\u07A6 \u0789\u07A6\u0780\u07AA 1.2 \u0789\u07A8\u078D\u07A8\u0787\u07A6\u0782\u07B0',
      bullet2: '\u0787\u07A7\u0789\u07B0\u078B\u07A6\u0782\u07A9 15 \u0787\u07A8\u0782\u07B0\u0790\u07A6\u0787\u07B0\u078C\u07A6',
      date: '', url: 'reyvaonline.com/news/12345'
    }
  };
  state.c.date = todayFor(state.brand);
  state.c.eyebrow = '';   // REYVA: optional category word, off by default
  window.cardState = state; // expose for engagement system

  const BRAND_STYLE = {
    // headAlign drives the news-template headline: 'right' is the RTL default the
    // two original brands use; 'center' switches to the centred pill treatment.
    dhuvas:   { bg: '#f7f2e9', ink: '#0e2438', rad: 24, rail: false, subjPanel: '#0e2438', headAlign: 'right' },
    voice:    { bg: '#ffffff', ink: '#14171c', rad: 0,  rail: true,  subjPanel: '#fff0e8', headAlign: 'right' },
    // Azmee supplied accent #024dfd and ink #151b55; bg/rad/rail/subjPanel are my
    // choices — faint cool tint so the three brands are distinguishable at a glance,
    // rounded like dhuvas, no rail (the rail reads as a VOICE signature).
    // readMoreGlyph defaults to ' ❯ ' when absent, so dhuvas and voice are untouched.
    newscast: { bg: '#f4f7ff', ink: '#151b55', rad: 24, rail: false, subjPanel: '#151b55', headAlign: 'center', footerLink: false, readMoreGlyph: ' ❯❯ ', readMoreLabel: '' },
    /* VOICE EN does NOT reuse VOICE's rail. Azmee supplied a finished design for
     * the English edition and it is a full-bleed photo card — closer to DHUVAS in
     * structure than to VOICE — so `layout` selects it explicitly rather than the
     * renderer inferring one from rail/headAlign. Anything without `layout` takes
     * the paths it always took. */
    voice_en: { bg: '#0e1116', ink: '#ffffff', rad: 0, rail: false, subjPanel: '#14171c', headAlign: 'left', layout: 'en-feature' },
    // REYVA: layout 'reyva' hands the whole card to reyva-card.js.
    reyva:    { bg: '#000621', ink: '#ffffff', rad: 0, rail: false, subjPanel: '#000621', headAlign: 'center', layout: 'reyva' }
  };

  const host = document.getElementById('tool-card');
  host.innerHTML = `
    <aside class="controls">
      <h2>Photo Post</h2><p class="sub">Reyva news cards</p>

      <div class="grp"><label>📬 Article queue</label>
        <div id="cQueue"><p class="hint">Checking for new articles\u2026</p></div></div>

      <div class="grp"><label>Article link</label>
        <div style="display:flex;gap:6px">
          <input type="text" id="cUrl" style="direction:ltr;font-family:var(--font);font-size:13px;flex:1" placeholder="${BRAND_SITES.map(function(s){return s+'/…';}).join('   ')}">
          <button class="btn-ghost" id="cFetch" style="width:auto;flex:none;padding:8px 14px;margin:0">\u{1F517} Fetch</button>
        </div>
        <div class="status" id="cFetchStatus"></div>
        <p class="hint">Paste an article URL to auto-fill the text, headline &amp; link.</p></div>

      <div class="grp"><label>Source article</label>
        <textarea id="cSrc" style="min-height:90px" placeholder=""></textarea>
        <button class="btn-ghost" id="cAI">\u2728 AI: pick key points &amp; fill fields</button>
        <div class="status" id="cAIStatus"></div></div>

      <div class="grp"><label>Colour</label>
        <div class="seg" id="cPal"><button data-v="red" class="on">Red</button><button data-v="blue">Blue</button></div></div>

      <div class="grp" style="display:none"><label>Outlet</label>
        <div class="seg" id="cBrand">${BRAND_KEYS.map(function (k, i) {
          return '<button data-v="' + k + '"' + (i === 0 ? ' class="on"' : '') + '>' + SC.THEME[k].label + '</button>';
        }).join('')}</div>
        <label id="cSportRow" style="display:none;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-top:9px">
          <input type="checkbox" id="cSportChk" style="width:16px;height:16px"> ⚽ Voice Sports template
        </label>
        <p class="hint">Ticked automatically for voice.mv sport stories.</p></div>

      <div class="grp"><label>Template</label>
        <div class="tiles" id="cTpl"></div>
</div>

      <div class="grp"><label>Format</label>
        <div class="seg" id="cSize">
          <button data-v="portrait" class="on">4:5</button>
          <button data-v="square">1:1</button>
          <button data-v="story">9:16</button>
        </div></div>

      <div class="grp"><label>Export resolution</label>
        <div class="seg" id="cRes">
          <button data-r="1">1\u00d7</button>
          <button data-r="2" class="on">2\u00d7</button>
          <button data-r="3">3\u00d7</button>
        </div>
        <p class="hint" id="cResNote"></p></div>

      <div id="cSafeZone"></div>

      <div class="grp" style="display:none"><label>Accent</label>
        <div style="display:flex;align-items:center;gap:10px">
          <input type="color" id="cAccent" value="#ff5500" style="width:40px;height:32px;border:1px solid var(--border);border-radius:6px;background:none;padding:2px;cursor:pointer">
          <span class="hint" style="margin:0">Override per post</span>
        </div></div>

      <div class="grp"><label>Photo</label>
        <label class="upload" id="cUpLabel">\ud83d\udcf7 Click to upload image<input type="file" id="cPhoto" accept="image/*" hidden></label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-top:9px">
          <input type="checkbox" id="cCutChk" style="width:16px;height:16px"> AI cutout \u2014 remove background
        </label>
        <div class="status" id="cCutStatus"></div>
        <p class="hint">Drag the photo in the preview to reframe.</p></div>

      <div id="cFields"></div>

      <div class="grp"><label>FB caption</label>
        <textarea id="cCapEdit" rows="4" style="width:100%;background:var(--field);border:1px solid var(--border);border-radius:var(--r-sm);padding:10px;color:var(--text);font-family:var(--thaana-head);font-size:14px;direction:rtl;text-align:right;resize:vertical;line-height:1.8" placeholder="AI caption will appear here\u2026"></textarea>
        <div style="display:flex;gap:6px;margin-top:6px">
          <button class="btn-ghost" id="cAICaption" style="flex:1;margin:0;font-size:11px">\u2728 AI Caption</button>
          <button class="btn-ghost" id="cCopy" style="flex:1;margin:0;font-size:11px">Copy caption</button>
        </div>
        <div id="cCapStyle" style="font-size:10px;color:var(--muted);margin-top:4px"></div>
      </div>

      <button class="btn-primary" id="cReadyFb" style="font-size:15px;padding:14px">\ud83d\udce4 Copy Caption + Download PNG</button>
      <div id="cShareRow" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
        <button class="btn-ghost" id="cShareFb" style="flex:1 1 45%;margin:0;font-size:13px">\ud83d\udcd8 Facebook</button>
        <button class="btn-ghost" id="cShareTg" style="flex:1 1 45%;margin:0;font-size:13px">\ud83d\udce2 Telegram</button>
        <button class="btn-ghost" id="cShareX" style="flex:1 1 45%;margin:0;font-size:13px">\ud83d\udc26 Twitter</button>
        <button class="btn-ghost" id="cShareVb" style="flex:1 1 45%;margin:0;font-size:13px">\ud83d\udfe3 Viber</button>
      </div>
      <button class="btn-ghost" id="cExport" style="margin-top:6px">\u2b07 Download PNG only</button>
      <div class="status" id="cStatus"></div>
    </aside>
    <div class="stage">
      <canvas class="preview" id="cCanvas"></canvas>
    </div>`;

  const $ = s => host.querySelector(s);
  const canvas = $('#cCanvas'), ctx = canvas.getContext('2d');

  /* safe-zone guide: a DOM layer above the canvas, never a ctx call.
     exportPng/AI-caption/Viber all re-render into this same canvas. */
  const szCtrl = window.SafeZones ? window.SafeZones.attach(canvas) : null;
  let szUI = null;

  /* template tiles */
  const tplBox = $('#cTpl');
  tplBox.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:6px';
  TEMPLATES.forEach(t => {
    const b = document.createElement('button');
    b.className = 'tile' + (t === state.tpl ? ' on' : '');
    b.dataset.tpl = t;
    b.style.cssText = 'text-align:left;padding:9px 10px;line-height:1.2;background:var(--field);border:1px solid var(--border);color:var(--text);border-radius:var(--r-sm);cursor:pointer;font-size:12.5px;font-family:var(--font)';
    b.innerHTML = TPL_META[t].label + '<small style="display:block;color:var(--muted);font-size:10px">' + TPL_META[t].desc + '</small>';
    tplBox.appendChild(b);
  });

  function dims() { return SIZES[state.size]; }
  function fit() {
    const { w, h } = dims();
    const stage = host.querySelector('.stage');
    const scale = Math.min((stage.clientHeight - 50) / h, (stage.clientWidth - 50) / w, 0.55);
    canvas.style.width = (w * scale) + 'px'; canvas.style.height = (h * scale) + 'px';
  }
  window.addEventListener('resize', () => { if (host.classList.contains('on')) fit(); });
  function resNote() { const {w,h}=dims(); $('#cResNote').textContent='Output: '+(w*state.res)+' \u00d7 '+(h*state.res)+'px'; }
  function sizeClass() { const r=dims().h/dims().w; return r>=1.5?'tall':(r>=1.15?'portrait':'square'); }

  /* current photo source (respects cutout) */
  function photoSrc() {
    if (!state.photo) return null;
    if (state.cutOn && state.cut && state.cut.src === state.photo) return state.cut.url;
    return state.photo;
  }

  /* ── drawing helpers ── */
  function roundRect(c2, x, y, w2, h2, r) {
    if (r <= 0) { c2.beginPath(); c2.rect(x, y, w2, h2); return; }
    c2.beginPath(); c2.moveTo(x+r,y); c2.lineTo(x+w2-r,y);
    c2.quadraticCurveTo(x+w2,y,x+w2,y+r); c2.lineTo(x+w2,y+h2-r);
    c2.quadraticCurveTo(x+w2,y+h2,x+w2-r,y+h2); c2.lineTo(x+r,y+h2);
    c2.quadraticCurveTo(x,y+h2,x,y+h2-r); c2.lineTo(x,y+r);
    c2.quadraticCurveTo(x,y,x+r,y); c2.closePath();
  }

  /* The category flag on the VOICE EN card: a rounded bar whose right end tapers
   * to a point, like a bookmark. Drawn as ONE path rather than a roundRect with a
   * triangle butted onto it — two fills meeting on a diagonal leave a hairline
   * seam that only shows up at 3× export, which is the worst time to find it. */
  function tagPath(c2, x, y, w2, h2, r, tip) {
    c2.beginPath();
    c2.moveTo(x + r, y);
    c2.lineTo(x + w2 - tip, y);
    c2.lineTo(x + w2, y + h2 / 2);
    c2.lineTo(x + w2 - tip, y + h2);
    c2.lineTo(x + r, y + h2);
    c2.quadraticCurveTo(x, y + h2, x, y + h2 - r);
    c2.lineTo(x, y + r);
    c2.quadraticCurveTo(x, y, x + r, y);
    c2.closePath();
  }

  /* Read-more affordance: filled disc with a down arrow. Drawn as geometry, not as
   * the '↓' character — the arrow in the design has a solid head and a short stem,
   * and which glyph a system font actually produces for U+2193 varies by platform. */
  function downArrowBadge(c2, cx, cy, r, fill, ink) {
    c2.save();
    c2.beginPath(); c2.arc(cx, cy, r, 0, Math.PI * 2); c2.fillStyle = fill; c2.fill();
    const s = r * 0.54;
    c2.strokeStyle = ink; c2.lineWidth = Math.max(2, r * 0.17); c2.lineCap = 'round';
    c2.beginPath(); c2.moveTo(cx, cy - s); c2.lineTo(cx, cy + s * 0.15); c2.stroke();
    c2.beginPath();
    c2.moveTo(cx, cy + s * 0.92);
    c2.lineTo(cx - s * 0.66, cy + s * 0.08);
    c2.lineTo(cx + s * 0.66, cy + s * 0.08);
    c2.closePath(); c2.fillStyle = ink; c2.fill();
    c2.restore();
  }

  function drawPhoto(c2, x, y, w2, h2, radius, isSubject) {
    const img = state.photoImg;
    c2.save();
    roundRect(c2, x, y, w2, h2, radius); c2.clip();
    if (!img) {
      c2.fillStyle = '#e9e2d2'; c2.fillRect(x, y, w2, h2);
      c2.font = '24px '+SC.FONT_BODY; c2.fillStyle='#0003'; c2.textAlign='center'; c2.textBaseline='middle';
      c2.fillText('\u078A\u07AE\u0793\u07AF', x+w2/2, y+h2/2);
    } else {
      const isCut = isSubject && state.cutOn && state.cut && state.cut.src === state.photo;
      if (isCut) {
        c2.fillStyle = BRAND_STYLE[state.brand].subjPanel; c2.fillRect(x, y, w2, h2);
        const ir=img.width/img.height, br=w2/h2; let dw,dh;
        if(ir>br){dw=w2;dh=dw/ir;}else{dh=h2;dw=dh*ir;}
        c2.drawImage(img, x+(w2-dw)/2, y+h2-dh, dw, dh);
      } else {
        const ir=img.width/img.height, br=w2/h2; let dw,dh;
        if(ir>br){dh=h2;dw=dh*ir;}else{dw=w2;dh=dw/ir;}
        const maxX=(dw-w2)/2, maxY=(dh-h2)/2;
        c2.drawImage(img, x+(w2-dw)/2+state.photoPos.x*maxX, y+(h2-dh)/2+state.photoPos.y*maxY, dw, dh);
      }
    }
    c2.restore();
  }

  function drawRail(c2, w2, h2, color) { c2.fillStyle=color; c2.fillRect(w2-26,0,26,h2); }

  /* tH is a target HEIGHT here, where studio-core's helpers take a target WIDTH.
   * SC.logoFitScale returns null for the ~1.30:1 lockups, so dhuvas and voice keep
   * the original tH/img.height maths untouched; a wider logo gets fitted into the
   * same box instead of running off the right edge of the card. */
  function logoScale(brand, tH) {
    const img = SC.logos[brand]; if(!img) return null;
    return SC.logoFitScale(img, tH * SC.LOGO_REF_ASPECT, tH) || (tH / img.height);
  }
  /* No logo file ⇒ draw the text badge instead of nothing. drawLogoTopRight has
   * always done this; this one returned silently, which is fine while every brand
   * ships a PNG and leaves a blank corner the moment one doesn't — exactly the
   * state voice_en is in until its logo lands in cs/public/img/. */
  function drawLogo(c2, brand, x, y, tH) {
    const img = SC.logos[brand];
    if(!img) return SC.drawTextBadge
      ? SC.drawTextBadge(c2, brand, x, y, 'left', (tH||74)/74)
      : undefined;
    const s = logoScale(brand, tH); c2.drawImage(img, x, y, img.width*s, img.height*s);
  }
  function logoW(brand, tH) {
    const img = SC.logos[brand]; if(!img) return 100;
    return img.width * logoScale(brand, tH);
  }

  /* ── RENDER ── */
  async function render() {
    await SC.ensureAssets();
    const { w, h } = dims();
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; fit(); }

    const th = SC.THEME[state.brand];
    const bs = BRAND_STYLE[state.brand];
    const a = state.accent, c = state.c, sc = sizeClass(), pad = 62;

    /* load photo */
    const src = photoSrc();
    if (src && (!state.photoImg || state.photoImg._src !== src)) {
      try { state.photoImg = await SC.loadImage(src); state.photoImg._src = src; } catch { state.photoImg = null; }
    } else if (!src) { state.photoImg = null; }

    ctx.clearRect(0, 0, w, h);

    /* REYVA: the whole card comes from reyva-card.js. */
    if (bs.layout === 'reyva' && window.ReyvaCard) {
      const cutOn = !!(state.cutOn && state.cut && state.cut.src === state.photo);
      await window.ReyvaCard.draw(ctx, { w, h, tpl: state.tpl, pal: state.reyvaPal, cc: c,
        headSize: state.headSize, photo: state.photoImg, photoPos: state.photoPos,
        cut: cutOn ? state.photoImg : null, photoSrc: state.photo });
      fit();
      return;
    }
    const sysFont = getComputedStyle(document.body).fontFamily;
    const rp = bs.rail ? 74 : pad; // right padding

    /* ===== QUOTE ===== */
    if (state.tpl === 'quote') {
      ctx.fillStyle = bs.bg; ctx.fillRect(0, 0, w, h);
      if (bs.rail) drawRail(ctx, w, h, a);
      const qSize = sc === 'square' ? 64 : 74;

      if (sc === 'tall') {
        drawLogo(ctx, state.brand, w - rp - logoW(state.brand,105), pad, 105);
        const phTop = pad + 105 + 24;
        const phH = Math.round(h * 0.38);
        drawPhoto(ctx, pad, phTop, w - pad - rp, phH, bs.rad, true);

        let qy = phTop + phH + 44;
        ctx.font = '190px Georgia,serif'; ctx.fillStyle = a;
        ctx.textAlign = 'right'; ctx.direction = 'rtl';
        ctx.fillText('\u201D', w - rp, qy + 50); qy += 70;

        ctx.save(); ctx.font = qSize+'px '+SC.FONT_HEAD; ctx.direction='rtl';
        const qLines = SC.wrapThaana(ctx, c.pullQuote, w - pad - rp);
        const qLH = Math.round(qSize * 1.32);
        qLines.forEach((ln,i) => { ctx.fillStyle = bs.ink; ctx.textAlign='right'; ctx.fillText(ln, w-rp, qy + (i+1)*qLH); });
        ctx.restore();

        const mb = Math.round(h * 0.10), ay = h - mb;
        ctx.fillStyle = a;
        roundRect(ctx, w - rp - (bs.rail?170:210), ay - 120, bs.rail?170:210, bs.rail?10:14, bs.rail?0:7); ctx.fill();
        SC.drawTextBlock(ctx, c.attrib1, w-rp, ay-60, w-pad-rp, 36, 42, a, SC.FONT_BODY);
        SC.drawTextBlock(ctx, c.attrib2, w-rp, ay-10, w-pad-rp, 50, 58, bs.ink, SC.FONT_HEAD);

      } else {
        const pw = Math.round(w * 0.455), pl = Math.round(w * 0.035);
        drawPhoto(ctx, pl, 56, pw, h-112, bs.rad, true);

        const rx = pw + pl + 40, rw = w - rx - rp + 40;
        drawLogo(ctx, state.brand, w - rp - logoW(state.brand,105), 58, 105);

        let qy = 58 + 105 + 58;
        ctx.font = '190px Georgia,serif'; ctx.fillStyle = a; ctx.textAlign = 'right'; ctx.direction = 'rtl';
        ctx.fillText('\u201D', w - rp + 20, qy + 40); qy += 60;

        ctx.save(); ctx.font = qSize+'px '+SC.FONT_HEAD; ctx.direction='rtl';
        const qLines = SC.wrapThaana(ctx, c.pullQuote, rw);
        const qLH = Math.round(qSize * 1.32);
        qLines.forEach((ln,i) => { ctx.fillStyle = bs.ink; ctx.textAlign='right'; ctx.fillText(ln, w-rp+20, qy+(i+1)*qLH); });
        ctx.restore();

        const mb = Math.round(h * 0.10), ay = h - mb;
        ctx.fillStyle = a;
        roundRect(ctx, w-rp-20-(bs.rail?170:210), ay-120, bs.rail?170:210, bs.rail?10:14, bs.rail?0:7); ctx.fill();
        SC.drawTextBlock(ctx, c.attrib1, w-rp+20, ay-60, rw, 36, 42, a, SC.FONT_BODY);
        SC.drawTextBlock(ctx, c.attrib2, w-rp+20, ay-10, rw, 50, 58, bs.ink, SC.FONT_HEAD);
      }
    }

    /* ===== HEADLINE ===== */
    if (state.tpl === 'headline') {
      ctx.fillStyle = bs.bg; ctx.fillRect(0, 0, w, h);
      if (bs.rail) drawRail(ctx, w, h, a);

      drawLogo(ctx, state.brand, w - rp - logoW(state.brand,74), pad, 74);
      const phTop = pad + 74 + 24;
      const hsz = state.headSize, lh = Math.round(hsz*1.5);
      ctx.save(); ctx.font = hsz+'px '+SC.FONT_HEAD; ctx.direction='rtl';
      const hLines = SC.wrapThaana(ctx, c.headline, w - pad - rp); ctx.restore();
      const headBlockH = hLines.length * lh + 60;
      const footH = 80;
      const phH = h - phTop - headBlockH - footH - 20;

      drawPhoto(ctx, pad, phTop, w - pad - rp, Math.max(phH, 120), bs.rad, false);

      let hy = phTop + Math.max(phH, 120) + 34;
      if (bs.rail) {
        ctx.fillStyle = a; ctx.fillRect(w - rp - 120, hy, 120, 10); hy += 28;
        ctx.save(); ctx.font = hsz+'px '+SC.FONT_HEAD; ctx.direction='rtl'; ctx.textAlign='right'; ctx.fillStyle=bs.ink;
        hLines.forEach((ln,i) => ctx.fillText(ln, w-rp, hy+(i+1)*lh)); ctx.restore();
      } else {
        ctx.fillStyle = a; roundRect(ctx, w/2-90, hy, 180, 12, 6); ctx.fill(); hy += 32;
        ctx.save(); ctx.font = hsz+'px '+SC.FONT_HEAD; ctx.direction='rtl'; ctx.textAlign='center'; ctx.fillStyle=bs.ink;
        hLines.forEach((ln,i) => ctx.fillText(ln, w/2, hy+(i+1)*lh)); ctx.restore();
      }

      const fy = h - 50;
      if (bs.rail) {
        ctx.fillStyle = a+'55'; ctx.fillRect(pad, fy-30, w-pad-rp, 3);
        ctx.save(); ctx.font='bold 25px '+sysFont; ctx.fillStyle=a; ctx.textAlign='left'; ctx.direction='ltr';
        ctx.fillText(footUrl(c.url), pad, fy);
        ctx.font = '24px '+SC.FONT_BODY; ctx.fillStyle=bs.ink; ctx.textAlign='right'; ctx.direction='rtl';
        ctx.fillText(c.date, w-rp, fy); ctx.restore();
      } else {
        ctx.save(); ctx.textAlign='center';
        ctx.font='bold 25px '+sysFont; ctx.fillStyle=a; ctx.direction='ltr'; ctx.fillText(footUrl(c.url), w/2, fy-18);
        ctx.font='26px '+SC.FONT_BODY; ctx.fillStyle=bs.ink; ctx.direction='rtl'; ctx.fillText(c.date, w/2, fy+14);
        ctx.restore();
      }
    }

    /* ===== STAT ===== */
    if (state.tpl === 'stat') {
      ctx.fillStyle = bs.bg; ctx.fillRect(0, 0, w, h);
      if (bs.rail) drawRail(ctx, w, h, a);

      drawLogo(ctx, state.brand, w - rp - logoW(state.brand,74), pad, 74);
      let cy = pad + 74 + 20;

      SC.drawTextBlock(ctx, c.eyebrow, w-rp, cy+30, w-pad-rp, 30, 36, a, SC.FONT_BODY);
      cy += 50;

      ctx.save(); ctx.font='800 210px '+sysFont; ctx.fillStyle=bs.rail?bs.ink:a;
      ctx.textAlign='right'; ctx.direction='ltr'; ctx.textBaseline='alphabetic';
      ctx.fillText(c.statNumber, w-rp, cy+170); ctx.restore();
      cy += 185;

      if (bs.rail) { ctx.fillStyle=a; ctx.fillRect(w-rp-130, cy, 130, 10); cy+=18; }

      SC.drawTextBlock(ctx, c.statLabel, w-rp, cy+44, w-pad-rp, 44, 52, bs.ink, SC.FONT_HEAD);
      cy += 60;

      if (!bs.rail) {
        const hsz2 = Math.round(state.headSize*0.62);
        SC.drawTextBlock(ctx, c.headline, w-rp, cy+hsz2+8, w-pad-rp, hsz2, Math.round(hsz2*1.6), bs.ink, SC.FONT_BODY);
        cy += 50;
      }

      const phTop = cy + 24;
      const bulletH = bs.rail ? 120 : 0;
      const phH = h - phTop - pad - bulletH;
      drawPhoto(ctx, pad, phTop, w-pad-rp, Math.max(phH, 120), bs.rad, false);

      if (bs.rail) {
        const by = phTop + Math.max(phH, 120) + 20;
        [c.bullet1, c.bullet2].forEach((bt, i) => {
          if (!bt) return;
          const by2 = by + i * 50;
          ctx.fillStyle = a; ctx.fillRect(w-rp-16, by2+4, 16, 16);
          SC.drawTextBlock(ctx, bt, w-rp-28, by2+34, w-pad-rp-28, 30, 36, bs.ink, SC.FONT_BODY);
        });
      }
    }

    /* ===== NEWS ===== */
    if (state.tpl === 'news') {
      if (!bs.rail) {
        /* Full-bleed photo + gradient \u2014 DHUVAS, NEWSCAST and VOICE EN */
        if (state.photoImg) {
          SC.coverDraw(ctx, state.photoImg, w, h, 1.001, state.photoPos.x, state.photoPos.y);
        } else {
          const ltrB = SC.isLtr(state.brand);
          ctx.fillStyle='#e9e2d2'; ctx.fillRect(0,0,w,h);
          ctx.font='36px '+(ltrB ? SC.FONT_BODY_LTR : SC.FONT_BODY); ctx.fillStyle='#0006'; ctx.textAlign='center';
          // The Thaana word for "photo" in a Latin-only font renders as tofu boxes,
          // which reads as a broken card rather than an empty one.
          ctx.fillText(ltrB ? 'PHOTO' : '\u078A\u07AE\u0793\u07AF', w/2, h/2); ctx.textAlign='left';
        }
        const g = ctx.createLinearGradient(0, h*0.25, 0, h);
        g.addColorStop(0,'rgba(0,0,0,0)'); g.addColorStop(0.25,'rgba(0,0,0,0.3)');
        g.addColorStop(0.55,'rgba(0,0,0,0.7)'); g.addColorStop(0.8,'rgba(0,0,0,0.88)');
        g.addColorStop(1,'rgba(0,0,0,0.94)');
        ctx.fillStyle=g; ctx.fillRect(0,0,w,h);

        if (bs.layout === 'en-feature') {
          /* ── VOICE EN — English feature card ──
           * Follows the design Azmee supplied rather than mirroring an RTL template:
           * masthead top-right, a tag-shaped category flag, a left-aligned headline
           * over the gradient, and a Read-more affordance bottom-right.
           * No date and no URL row: the design has neither, and adding them would
           * put fields on the card that were never asked for. FIELDS.voice_en below
           * matches, so the editor does not offer inputs that render nowhere. */
          const P  = Math.round(w * 0.0926);              // ~100px at 1080 — this design's own margin
          const fS = sc === 'tall' ? 1.25 : (sc === 'square' ? 0.92 : 1);

          /* Top scrim. The bottom gradient alone leaves the masthead sitting on raw
           * photo, and a WHITE knockout over a bright sky is invisible — the same
           * failure the black wordmark has over the dark half. Neither logo colour
           * is safe unaided, so the card makes its own contrast. */
          const tg = ctx.createLinearGradient(0, 0, 0, h * 0.30);
          tg.addColorStop(0, 'rgba(0,0,0,0.55)'); tg.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = tg; ctx.fillRect(0, 0, w, h * 0.30);

          /* Extra bottom scrim over the shared gradient. The shared one was tuned for
           * Thaana headlines, which sit higher and shorter; an English headline runs
           * three or four lines further down into live photo. This is what keeps
           * white text readable over a bright subject — the measles vial in the
           * supplied design happens to be dark there, and a palm-tree photo is not. */
          const bg2 = ctx.createLinearGradient(0, h * 0.42, 0, h);
          bg2.addColorStop(0, 'rgba(0,0,0,0)'); bg2.addColorStop(0.55, 'rgba(0,0,0,0.42)');
          bg2.addColorStop(1, 'rgba(0,0,0,0.62)');
          ctx.fillStyle = bg2; ctx.fillRect(0, h * 0.42, w, h * 0.58);

          /* Masthead. The VOICE. wordmark is ~3.0:1, well past LOGO_REF_ASPECT, so
           * it is fitted inside a box by BOTH axes here — scaling it by width alone
           * (what drawLogoTopRight does for the ~1.3:1 stacked lockups) would leave
           * it a third of the intended height. */
          const logo = SC.logos[state.brand];
          const boxW = Math.round(300 * fS), boxH = Math.round(96 * fS);
          if (logo) {
            const s2 = Math.min(boxW / logo.width, boxH / logo.height);
            ctx.drawImage(logo, w - P - logo.width * s2, Math.round(62 * fS), logo.width * s2, logo.height * s2);
          } else {
            // No PNG on disk yet ⇒ fall back to the domain text, which is what the
            // template carried before the wordmark existed. Never a blank corner.
            ctx.save();
            ctx.font = Math.round(27 * fS) + 'px ' + sysFont;
            ctx.fillStyle = '#ffffffdd'; ctx.textAlign = 'right'; ctx.direction = 'ltr';
            ctx.fillText(th.site, w - P, Math.round(112 * fS));
            ctx.restore();
          }

          /* Bottom stack, measured from the floor up: read-more row, headline block,
           * then the tag above it — so a headline that wraps to four lines grows
           * upward into the photo instead of pushing the footer off the card. */
          const ebTxt = (c.eyebrow || 'NEWS').toUpperCase();
          const ebFs  = Math.round(26 * fS);
          ctx.save();
          ctx.font = '800 ' + ebFs + 'px ' + sysFont; ctx.direction = 'ltr'; ctx.textAlign = 'left';
          // letterSpacing is Chrome 99+ / Safari 17+. Guarded: where it is not
          // supported the assignment is simply ignored and the tag sets tighter,
          // and because the width is measured AFTER it, the flag still fits.
          try { ctx.letterSpacing = Math.round(ebFs * 0.09) + 'px'; } catch (e) {}
          const ebW  = ctx.measureText(ebTxt).width;
          const tagH = Math.round(ebFs * 1.85);
          const tip  = Math.round(tagH * 0.42);
          const tagW = Math.round(ebW + ebFs * 1.6 + tip);

          const hsz  = state.headSize, hlh = Math.round(hsz * 1.34);
          ctx.save(); ctx.font = hsz + 'px ' + SC.FONT_HEAD_LTR; ctx.direction = 'ltr';
          const nLines = SC.wrapText(ctx, c.headline, w - P * 2); ctx.restore();

          const rmY  = h - Math.round(104 * fS);                       // read-more baseline
          const hb   = rmY - Math.round(76 * fS);                      // last headline baseline
          // Cap line of the first row: baseline of row 1, less the cap height.
          const hCap = hb - (nLines.length - 1) * hlh - Math.round(hsz * 0.74);
          const tagY = hCap - tagH - Math.round(24 * fS);

          ctx.fillStyle = a;
          tagPath(ctx, P, tagY, tagW, tagH, Math.round(tagH * 0.24), tip); ctx.fill();
          ctx.fillStyle = '#ffffff'; ctx.textBaseline = 'middle';
          ctx.fillText(ebTxt, P + Math.round(ebFs * 0.8), tagY + tagH / 2 + 1);
          ctx.restore();

          SC.drawTextBlock(ctx, c.headline, P, hb, w - P * 2, hsz, hlh, '#ffffff', SC.FONT_HEAD_LTR, 'left', 'ltr');

          const rmFs = Math.round(31 * fS), cr = Math.round(25 * fS);
          ctx.save();
          ctx.font = '700 ' + rmFs + 'px ' + sysFont;
          ctx.textAlign = 'left'; ctx.direction = 'ltr'; ctx.textBaseline = 'alphabetic';
          const rmW = ctx.measureText('Read more').width;
          const gap = Math.round(18 * fS);
          const gx  = w - P - (rmW + gap + cr * 2);
          ctx.fillStyle = '#ffffff'; ctx.fillText('Read more', gx, rmY);
          downArrowBadge(ctx, gx + rmW + gap + cr, rmY - Math.round(rmFs * 0.33), cr, a, '#ffffff');
          ctx.restore();

        } else {
          SC.drawLogoTopRight(ctx, state.brand, w, 150);

          // headline + accent bar (bar on RIGHT for RTL)
          const hb = h - 140;
          const hsz = state.headSize, hlh = Math.round(hsz*1.7);
          ctx.save(); ctx.font=hsz+'px '+SC.FONT_HEAD; ctx.direction='rtl';
          const nLines = SC.wrapThaana(ctx, c.headline, w-pad*2-30); ctx.restore();
          const blockH = nLines.length * hlh;
          // first line baseline is at (hb - blockH + hlh), glyph top ~fontSize above that
          const barTop = hb - blockH + hlh - Math.round(hsz * 0.82);
          const barBottom = hb;
          const fy = h - 42;
          const fScale = sc === 'tall' ? 1.3 : 1; // 30% bigger for 9:16
          const centred = bs.headAlign === 'center';

          if (centred) {
            /* Centred stack, top to bottom: date, accent pill, headline.
             * A right-edge rule has nothing to sit against once the text is centred,
             * so this reuses the centred pill already established by the non-rail
             * `headline` template rather than inventing a second treatment. */
            const pillTop = barTop - 40;
            ctx.fillStyle = a; roundRect(ctx, w/2-90, pillTop, 180, 12, 6); ctx.fill();

            // Date sits above the pill. Thaana hangs vowel marks ~0.34*fontSize below
            // the baseline (25f335b), so clear the descender before adding the gap or
            // the marks collide with the pill as the date font grows at 9:16.
            const dsz = Math.round(24 * fScale);
            ctx.save();
            ctx.font = dsz+'px '+SC.FONT_BODY; ctx.fillStyle='#ffffffdd';
            ctx.textAlign='center'; ctx.direction='rtl';
            ctx.fillText(c.date, w/2, pillTop - Math.round(dsz * 0.34) - 18);
            ctx.restore();

            SC.drawTextBlock(ctx, c.headline, w/2, hb, w-pad*2-30, hsz, hlh, '#ffffff', SC.FONT_HEAD, 'center');
          } else {
            ctx.fillStyle = a; ctx.fillRect(w-pad+16, barTop, 4, barBottom - barTop);
            SC.drawTextBlock(ctx, c.headline, w-pad, hb, w-pad*2-30, hsz, hlh, '#ffffff', SC.FONT_HEAD);
          }

          // footer
          // readMoreLabel: '' drops the label entirely. Undefined keeps 'Read More',
          // so dhuvas and voice are unaffected.
          ctx.save();
          // footerLink:false drops the whole Read More / glyph / URL group. NEWSCAST
          // uses it \u2014 with the date already moved above the headline, that leaves the
          // card with no footer row at all. readMoreLabel / readMoreGlyph stay
          // meaningful and are simply inert while footerLink is false.
          if (bs.footerLink !== false) {
            const rmLabel = bs.readMoreLabel !== undefined ? bs.readMoreLabel : 'Read More';
            // Without a label the glyph leads the group, so its leading space would
            // push the whole centred block visibly off-centre.
            const rawG = bs.readMoreGlyph || ' \u276F ';
            const glyph = rmLabel ? rawG : rawG.replace(/^\s+/, '');
            const fRM = '500 '+Math.round(24*fScale)+'px '+sysFont;
            const fGL = 'bold '+Math.round(20*fScale)+'px '+sysFont;
            const fURL = 'bold '+Math.round(24*fScale)+'px '+sysFont;
            ctx.textAlign='left'; ctx.direction='ltr';
            // the 6px gap is folded into wRM so the centring maths stays right when
            // the label is absent
            ctx.font=fRM;  const wRM  = rmLabel ? ctx.measureText(rmLabel).width + 6 : 0;
            ctx.font=fGL;  const wGL  = ctx.measureText(glyph).width;
            ctx.font=fURL; const wURL = ctx.measureText(footUrl(c.url)).width;
            // Centred brands run label / glyph / link as one centred group and move the
            // date up above the headline; the others keep link-left, date-right.
            let fx = centred ? Math.round(w/2 - (wRM + wGL + 4 + wURL)/2) : pad;
            if (rmLabel) { ctx.font=fRM; ctx.fillStyle='#ffffffdd'; ctx.fillText(rmLabel, fx, fy); fx += wRM; }
            ctx.font=fGL;  ctx.fillStyle=a;           ctx.fillText(glyph, fx, fy);       fx += wGL + 4;
            ctx.font=fURL; ctx.fillStyle='#ffffffdd'; ctx.fillText(footUrl(c.url), fx, fy);
          }
          if (!centred) {
            ctx.font=Math.round(24*fScale)+'px '+SC.FONT_BODY; ctx.fillStyle='#ffffffdd';
            ctx.textAlign='right'; ctx.direction='rtl';
            ctx.fillText(c.date, w-pad, fy);
          }
          ctx.restore();
        }

      } else {
        /* VOICE: structured with rail.
         * VOICE EN (maldivesvoice.mv) is the same masthead in English, so it shares
         * this branch and mirrors it rather than getting a layout of its own.
         * Everything reading direction-dependent is derived from these four locals,
         * so the RTL path is the identical expression it always was (ltr === false
         * ⇒ tX === w-rp, tAlign === 'right', tDir === 'rtl'), and there is no second
         * place to forget when a fifth masthead arrives.
         * The rail itself stays on the right in both: it is a masthead signature,
         * not a reading-order cue, and flipping it would read as a different brand. */
        const ltr    = SC.isLtr(state.brand);
        const tDir   = ltr ? 'ltr' : 'rtl';
        const tAlign = ltr ? 'left' : 'right';
        const tX     = ltr ? pad : w - rp;          // the edge text is anchored to
        const oX     = ltr ? w - rp : pad;          // and the opposite one
        const headF  = SC.headFont(state.brand);
        const bodyF  = SC.bodyFont(state.brand);

        /* Voice Sports: Azmee's supplied template. Same geometry as this card —
         * headline, photo and footer land on the same pixels — with the VOICE
         * SPORTS lockup (taller, its right edge 11px past the text edge, as
         * supplied), a grey handle, no accent bar, and a pale-blue footer rule.
         * VOICE is RTL, so the sports branch never sees ltr. */
        const sp = sportOn() && !ltr;

        ctx.fillStyle = bs.bg; ctx.fillRect(0, 0, w, h);
        drawRail(ctx, w, h, a);

        // The handle sits opposite the logo, so it follows the text edge too.
        ctx.save(); ctx.font='23px '+sysFont; ctx.fillStyle=sp ? SPORT.handleInk : bs.ink;
        ctx.textAlign=ltr ? 'right' : 'left'; ctx.direction='ltr';
        ctx.fillText(th.handle, ltr ? w-rp : pad, pad+20); ctx.restore();
        const spLogo = sp ? SC.logos.voice_sport : null;
        if (spLogo) {
          const sH = 123, sW = spLogo.width * sH / spLogo.height;
          ctx.drawImage(spLogo, w-rp+11-sW, pad+17, sW, sH);
        } else {
          drawLogo(ctx, state.brand, ltr ? pad : w-rp-logoW(state.brand,74), pad, 74);
        }

        let cy2 = pad + 74 + 30;
        // fillRect takes a LEFT x, so the RTL bar starts 120px back from its right
        // edge. Anchoring it at tX unmirrored would hang it off the canvas.
        if (!sp) { ctx.fillStyle=a; ctx.fillRect(ltr ? tX : tX-120, cy2, 120, 10); }
        cy2 += 26;

        const hsz = state.headSize, hlh = Math.round(hsz*1.45);
        ctx.save(); ctx.font=hsz+'px '+headF; ctx.direction=tDir;
        const nLines = SC.wrapText(ctx, c.headline, w-pad-rp); ctx.restore();
        ctx.save(); ctx.font=hsz+'px '+headF; ctx.direction=tDir; ctx.textAlign=tAlign; ctx.fillStyle=bs.ink;
        nLines.forEach((ln,i) => ctx.fillText(ln, tX, cy2+(i+1)*hlh)); ctx.restore();

        // cy2 + nLines*hlh is the last line's BASELINE, not its visual bottom.
        // Thaana hangs vowel marks well below the baseline, so a flat +26 left
        // roughly 8 visible px before the photo. Clear the descenders first,
        // then add the actual breathing space. Latin descenders are shallower —
        // reusing 0.34 there just opens a visible gap — hence descenderRatio.
        const descender = Math.round(hsz * SC.descenderRatio(state.brand));
        const phTop = cy2 + nLines.length*hlh + descender + 34;
        const footH = 60;
        const phH = h - phTop - pad - footH;
        drawPhoto(ctx, pad, phTop, w-pad-rp, Math.max(phH, 150), bs.rad, false);

        /* Footer. In the original VOICE card the date sits on the reading edge
         * (right, with the headline) and the URL on the trailing edge (left) — so
         * the mirror puts the date at tX and the URL at oX, NOT the other way
         * round. Anchoring the URL to tX would look reasonable and quietly move
         * VOICE's own footer across the card. */
        const fy2 = h - 40;
        ctx.fillStyle=sp ? SPORT.rule : a+'55'; ctx.fillRect(pad, fy2-34, w-pad-rp, 3);
        ctx.save();
        ctx.font='bold 24px '+sysFont; ctx.fillStyle=a;
        ctx.textAlign=ltr ? 'right' : 'left'; ctx.direction='ltr';   // a URL is LTR in both
        ctx.fillText(footUrl(c.url), oX, fy2);
        ctx.font='23px '+bodyF; ctx.fillStyle=bs.ink;
        ctx.textAlign=tAlign; ctx.direction=tDir;
        ctx.fillText(c.date, tX, fy2); ctx.restore();
      }
    }

    fit();
  }

  /* ── build dynamic content fields ── */
  function buildFields() {
    const box = $('#cFields');
    box.innerHTML = '<div class="grp"><label>Content fields</label></div>';
    const grp = box.querySelector('.grp');
    fieldsFor(state.tpl, state.brand).forEach(([k, label, type]) => {
      const d = document.createElement('div'); d.style.marginBottom = '8px';
      const isArea = type === 'area', isLtr = type === 'ltr';
      const val = (state.c[k] || '').replace(/"/g, '&quot;');
      d.innerHTML = '<label style="display:block;font-size:10.5px;color:var(--muted);margin-bottom:3px">'+label+'</label>' +
        (isArea
          ? '<textarea data-k="'+k+'" style="font-family:var(--thaana-head);font-size:15px">'+state.c[k]+'</textarea>'
          : '<input type="text" data-k="'+k+'" value="'+val+'"'+(isLtr?' style="direction:ltr;font-family:var(--font);font-size:13px"':'')+'>');
      grp.appendChild(d);
    });
    grp.querySelectorAll('[data-k]').forEach(i => {
      i.addEventListener('input', e => { state.c[e.target.dataset.k] = e.target.value; render(); if(e.target.dataset.k==='headline') updateCaption(); });
    });
    // heading size slider
    if (fieldsFor(state.tpl, state.brand).some(f => f[0] === 'headline' || f[0] === 'pullQuote')) {
      const row = document.createElement('div'); row.className = 'slider-row';
      row.innerHTML = '<label>Heading size</label><input type="range" min="30" max="90" step="1" value="'+state.headSize+'"><span class="val">'+state.headSize+'</span>';
      grp.appendChild(row);
      row.querySelector('input').addEventListener('input', e => {
        state.headSize = +e.target.value; row.querySelector('.val').textContent = e.target.value; render();
      });
    }
  }

  /* ── photo drag on canvas ── */
  canvas.addEventListener('pointerdown', e => {
    if (!state.photoImg) return;
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch {}
    const sx=e.clientX, sy=e.clientY, ox=state.photoPos.x, oy=state.photoPos.y;
    const rect = canvas.getBoundingClientRect();
    canvas.style.cursor = 'grabbing';
    const move = ev => {
      state.photoPos.x = Math.max(-1, Math.min(1, ox + (ev.clientX-sx)/rect.width*2));
      state.photoPos.y = Math.max(-1, Math.min(1, oy + (ev.clientY-sy)/rect.height*2));
      render();
    };
    const up = () => { canvas.style.cursor='grab'; window.removeEventListener('pointermove',move); window.removeEventListener('pointerup',up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  });

  /* ── AI cutout ── */
  const CUT_MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX';
  let TF=null, CUT_MODEL=null, CUT_PROC=null;
  function cutStatus(m, cl) { const e=$('#cCutStatus'); e.textContent=m||''; e.className='status '+(cl||''); }

  async function ensureCutModel() {
    if (CUT_MODEL) return;
    cutStatus('Loading cutout model (one-time)\u2026','work');
    TF = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm');
    const cfgs = [];
    if (navigator.gpu) cfgs.push({device:'webgpu',dtype:'fp16'});
    cfgs.push({device:'wasm',dtype:'q8'}); cfgs.push({device:'wasm',dtype:'fp32'});
    let lastErr=null;
    for (const cfg of cfgs) { try { CUT_MODEL=await TF.AutoModel.from_pretrained(CUT_MODEL_ID,cfg); break; } catch(e2) { lastErr=e2; CUT_MODEL=null; } }
    if (!CUT_MODEL) throw lastErr||new Error('model load failed');
    CUT_PROC = await TF.AutoProcessor.from_pretrained(CUT_MODEL_ID);
  }

  async function runCutout() {
    if (!state.photo) { cutStatus('Upload a photo first.','err'); return; }
    if (state.cut && state.cut.src === state.photo) { render(); return; }
    try {
      await ensureCutModel(); cutStatus('Removing background\u2026','work');
      const srcImg = await new Promise((res,rej)=>{const im=new Image();im.onload=()=>res(im);im.onerror=rej;im.src=state.photo;});
      const MAXD=1600; let cw2=srcImg.naturalWidth,ch2=srcImg.naturalHeight;
      if(Math.max(cw2,ch2)>MAXD){const k=MAXD/Math.max(cw2,ch2);cw2=Math.round(cw2*k);ch2=Math.round(ch2*k);}
      const cv=document.createElement('canvas');cv.width=cw2;cv.height=ch2;const x2=cv.getContext('2d');x2.drawImage(srcImg,0,0,cw2,ch2);
      const image=await TF.RawImage.fromURL(cv.toDataURL('image/png'));
      const{pixel_values}=await CUT_PROC(image);
      const{output_image}=await CUT_MODEL({input_image:pixel_values});
      const mask=await TF.RawImage.fromTensor(output_image[0].sigmoid().mul(255).to('uint8')).resize(cw2,ch2);
      const id=x2.getImageData(0,0,cw2,ch2),m=mask.data;
      for(let i=0;i<m.length;i++) id.data[i*4+3]=m[i]; x2.putImageData(id,0,0);
      state.cut={src:state.photo,url:cv.toDataURL('image/png')};
      cutStatus('Background removed \u2713','ok');
      state.photoImg=null; render();
    } catch(e) {
      const msg=(e&&e.message!=null)?String(e.message):String(e);
      const oom=/^\d+$/.test(msg)||/memory|alloc|RuntimeError|Aborted|OOM/i.test(msg);
      cutStatus(oom?'Cutout ran out of memory \u2014 try a smaller photo.':'Cutout failed: '+msg,'err');
      state.cutOn=false; $('#cCutChk').checked=false; render();
    }
  }

  /* ── URL fetch ── */
  async function fetchArticle() {
    const url = $('#cUrl').value.trim();
    const st = $('#cFetchStatus');
    if (!url) { st.textContent = 'Paste a URL first'; st.className = 'status err'; return; }
    if (!brandFromUrl(url)) {
      st.textContent = 'Only ' + BRAND_SITES.join(', ') + ' links supported'; st.className = 'status err'; return;
    }
    st.textContent = 'Fetching article\u2026'; st.className = 'status work';
    try {
      const r = await fetch('/api/fetch-article', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Failed to fetch');
      // fill source text
      if (data.text) { $('#cSrc').value = data.text; }
      // fill headline (Thaana if available)
      if (data.title) { state.c.headline = data.title; }
      // fill URL field
      try {
        const u = new URL(url);
        state.c.url = u.hostname.replace('www.','') + u.pathname;
      } catch { state.c.url = url; }
      if (data.url) state.c.url = data.url;   // REYVA: reyvaonline.com/news/<id>
      // auto-detect brand
      const detected = brandFromUrl(url);
      if (detected) {
        state.brand = detected;
        $('#cBrand').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === detected));
        syncAccentToBrand();
        syncHeadSizeToBrand();
        syncCaptionDir();
        applyShareButtons();
      }
      setSport(detected === SPORT.brand && SC.isSportSection(data.section));
      // load og:image (comes as base64 data URL from server)
      let photoLoaded = false;
      if (data.image) {
        st.textContent = 'Loading photo\u2026'; st.className = 'status work';
        try {
          await SC.loadImage(data.image); // verify it's valid
          state.photo = data.image;
          state.photoImg = null; state.cut = null; state.photoPos = { x: 0, y: 0 };
          canvas.style.cursor = 'grab';
          photoLoaded = true;
          if (state.cutOn) runCutout();
        } catch (imgErr) {
          console.warn('og:image load failed:', imgErr);
        }
      }
      state.c.date = todayFor(state.brand);
      buildFields(); render(); updateCaption();
      const parts = [];
      if (data.text) parts.push('text');
      if (data.title) parts.push('headline');
      if (photoLoaded) parts.push('photo');
      st.textContent = 'Loaded ' + parts.join(', ') + ' \u2713 \u2014 hit AI to extract fields.';
      st.className = 'status ok';
    } catch (e) { st.textContent = 'Fetch failed: ' + e.message; st.className = 'status err'; }
  }

  /* ── AI extract ── */
  async function aiExtract() {
    const text=$('#cSrc').value.trim(), st=$('#cAIStatus');
    if(!text){st.textContent='Paste an article first';st.className='status err';return;}
    st.textContent='Asking Claude\u2026';st.className='status work';
    try {
      // brand decides the OUTPUT language server-side. Without it an English
      // article came back transliterated into Thaana — a confident, wrong card
      // with no error anywhere.
      const r=await fetch('/api/ai/card',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({text,guidelines:(window.VxdGuidelines||'').trim(),template:state.tpl,brand:state.brand})});
      const data=await r.json();
      if(!r.ok||!data.ok) throw new Error(data.error||'failed');
      const f=data.fields;
      if(f.headline) state.c.headline=f.headline;
      if(f.pullQuote) state.c.pullQuote=f.pullQuote;
      if(f.attribName) state.c.attrib2=f.attribName;
      if(f.attribRole) state.c.attrib1=f.attribRole;
      if(Array.isArray(f.bullets)){if(f.bullets[0])state.c.bullet1=f.bullets[0];if(f.bullets[1])state.c.bullet2=f.bullets[1];}
      if(f.statNumber) state.c.statNumber=f.statNumber;
      if(f.statLabel) state.c.statLabel=f.statLabel;
      if(f.eyebrow) state.c.eyebrow=f.eyebrow;
      if(f.fbCaption){state.fbCaption=f.fbCaption;}
      if(f.suggestedTemplate&&TEMPLATES.includes(f.suggestedTemplate)){
        state.tpl=f.suggestedTemplate;
        tplBox.querySelectorAll('.tile').forEach(x=>{x.classList.toggle('on',x.dataset.tpl===state.tpl);
          x.style.borderColor=x.classList.contains('on')?'var(--accent)':'var(--border)';
          x.style.background=x.classList.contains('on')?'rgba(255,85,0,.12)':'var(--field)';});
      }
      state.c.date=todayFor(state.brand);
      buildFields(); st.textContent='Fields filled \u2713 \u2014 generating caption\u2026';st.className='status ok'; render(); updateCaption();
      generateCaption();
    } catch(e){st.textContent='AI failed: '+e.message;st.className='status err';}
  }

  /* ── Export ── */
  function exportPng() {
    const st=$('#cStatus'); const{w,h}=dims(); const scale=state.res;
    const prevW=canvas.width, prevH=canvas.height;
    canvas.width=w*scale; canvas.height=h*scale;
    ctx.setTransform(scale,0,0,scale,0,0);
    render().then(()=>{
      ctx.setTransform(1,0,0,1,0,0);
      canvas.toBlob(blob=>{
        canvas.width=prevW; canvas.height=prevH; render();
        const link=document.createElement('a');
        link.download=state.brand+'-'+state.tpl+'-'+(w*scale)+'x'+(h*scale)+'.png';
        link.href=URL.createObjectURL(blob); link.click();
        setTimeout(()=>URL.revokeObjectURL(link.href),5000);
        st.textContent='PNG downloaded \u2014 '+(w*scale)+'\u00d7'+(h*scale)+' \u2713';st.className='status ok';
      },'image/png');
    });
  }

  /* ── WIRING ── */
  $('#cBrand').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    $('#cBrand').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); state.brand=b.dataset.v;
    // Swap the host but KEEP the article number. This used to overwrite a real
    // URL with the /12345 placeholder every time the brand button was clicked,
    // so a loaded article lost its link the moment you corrected the brand.
    // Keep the whole path, not just a trailing number: Newscast links are
    // /story/<uuid>, which the number-only version turned into /12345.
    const path = (state.c.url || '').replace(/^https?:\/\//, '').replace(/^[^/]*/, '');
    state.c.url = SC.THEME[state.brand].site + (path && path !== '/' ? path : '/12345');
    syncSportToggle();
    syncAccentToBrand();
    syncHeadSizeToBrand();
    applyShareButtons();
    // Switching between a Dhivehi and an English masthead changes what the date
    // should say and which way the caption box reads. Re-stamp only the
    // auto-generated date — anything the user typed into the other fields is
    // theirs to keep, exactly as the URL rule above already decided.
    state.c.date = todayFor(state.brand);
    syncCaptionDir();
    buildFields(); render();
  }));

  /* The caption textarea is hardcoded RTL/Thaana in the markup above, which turns
   * an English caption into right-aligned text in a Thaana face — legible, wrong,
   * and easy to miss because the card itself renders correctly. */
  function syncCaptionDir() {
    const ta = $('#cCapEdit'); if (!ta) return;
    const ltr = SC.isLtr(state.brand);
    ta.style.direction = ltr ? 'ltr' : 'rtl';
    ta.style.textAlign = ltr ? 'left' : 'right';
    ta.style.fontFamily = ltr ? SC.FONT_BODY_LTR : 'var(--thaana-head)';
  }
  syncCaptionDir();

  tplBox.querySelectorAll('.tile').forEach(b=>b.addEventListener('click',()=>{
    tplBox.querySelectorAll('.tile').forEach(x=>{x.classList.remove('on');x.style.borderColor='var(--border)';x.style.background='var(--field)';});
    b.classList.add('on');b.style.borderColor='var(--accent)';b.style.background='rgba(255,85,0,.12)';
    state.tpl=b.dataset.tpl; state.c.date=todayFor(state.brand); buildFields(); render();
  }));
  tplBox.querySelector('.on').style.borderColor='var(--accent)';
  tplBox.querySelector('.on').style.background='rgba(255,85,0,.12)';

  $('#cSize').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    $('#cSize').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); state.size=b.dataset.v;
    // size-dependent default heading size, per brand
    state.headSize = defaultHeadSize(state.brand, state.size);
    resNote(); buildFields(); render();
  }));

  $('#cRes').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    $('#cRes').querySelectorAll('button').forEach(x=>x.classList.remove('on'));
    b.classList.add('on'); state.res=+(b.dataset.r); resNote();
  }));

  $('#cAccent').addEventListener('input',e=>{state.accent=e.target.value;render();});
  // REYVA: colourway
  $('#cPal').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{
    $('#cPal').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));
    state.reyvaPal=b.dataset.v; render();
  }));
  $('#cSportChk').addEventListener('change',e=>{setSport(e.target.checked);render();});

  $('#cPhoto').addEventListener('change',async e=>{
    const f=e.target.files[0]; if(!f)return;
    $('#cUpLabel').childNodes[0].textContent=f.name;
    state.photo=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(f);});
    state.cut=null; state.photoImg=null; state.photoPos={x:0,y:0};
    canvas.style.cursor='grab';
    if(state.cutOn)runCutout();else render();
  });

  $('#cCutChk').addEventListener('change',e=>{
    state.cutOn=e.target.checked;
    if(state.cutOn)runCutout();else{cutStatus('');state.photoImg=null;render();}
  });

  /* ── Caption ── */
  function updateCaption() {
    const ta = $('#cCapEdit');
    if (!ta.value && state.c.headline) ta.value = state.c.headline;
  }

  function getCaptionText() {
    return $('#cCapEdit').value || state.c.headline || '';
  }

  /* ── AI Caption generation (reusable) ── */
  async function generateCaption() {
    const btn = $('#cAICaption');
    const ta = $('#cCapEdit');
    const styleEl = $('#cCapStyle');
    const headline = state.c.headline || '';
    const bodyText = $('#cSrc')?.value || '';
    if (!headline) { ta.value = ''; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Generating\u2026';
    try {
      const r = await fetch('/api/fb-caption/generate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline, bodyText, brand: state.brand })
      });
      const data = await r.json().catch(() => ({}));
      // A 500/502 still parses as JSON, so without this check the failure was
      // completely silent \u2014 no caption, no error, nothing.
      if (!r.ok || !data.caption) throw new Error(data.error || ('HTTP ' + r.status));
      ta.value = data.caption;
      const names = { key_detail: '\u26A1 Key Detail', summary_short: '\ud83d\udccb Summary', context_angle: '\ud83c\udf0d Context' };
      styleEl.textContent = 'Style: ' + (names[data.style] || data.style);
    } catch (err) {
      ta.value = headline;
      styleEl.textContent = '\u26a0 Caption failed (' + err.message + ') \u2014 using headline';
      console.error('[caption] generation failed:', err);
    }
    btn.disabled = false; btn.textContent = '\u2728 AI Caption';
  }

  $('#cAICaption').addEventListener('click', generateCaption);

  /* ── One-click: Copy caption + Download PNG ── */
  $('#cReadyFb').addEventListener('click', async () => {
    const st = $('#cStatus');
    const caption = getCaptionText();
    if (!caption) { st.textContent = 'Generate a caption first'; st.className = 'status err'; return; }

    // 1. Copy caption to clipboard
    try { await navigator.clipboard.writeText(caption); } catch {}

    // 2. Export PNG
    await exportPng();

    st.textContent = '\u2705 Caption copied + PNG downloaded \u2014 paste into Facebook!';
    st.className = 'status ok';
  });

  $('#cCopy').addEventListener('click',()=>{navigator.clipboard.writeText(getCaptionText());$('#cStatus').textContent='Caption copied \u2713';$('#cStatus').className='status ok';});
  $('#cFetch').addEventListener('click',fetchArticle);
  $('#cUrl').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();fetchArticle();}});
  $('#cAI').addEventListener('click',aiExtract);
  $('#cExport').addEventListener('click',exportPng);

  /* ── Share to Telegram channel ── */
  $('#cShareTg').addEventListener('click', async () => {
    const st = $('#cStatus');
    const btn = $('#cShareTg');
    const caption = getCaptionText();
    if (!caption) { st.textContent = 'Generate a caption first'; st.className = 'status err'; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Sharing\u2026';
    try {
      // Render at 1x for Telegram (it compresses anyway, no need for 2x/3x)
      const {w, h} = dims();
      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = w; canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      await render();
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.9);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      canvas.width = prevW; canvas.height = prevH;
      render();

      const articleUrl = state.c.url || '';

      const r = await fetch('/api/telegram/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption, articleUrl, imageBase64, brand: state.brand })
      });
      const data = await r.json();
      if (data.ok) {
        st.textContent = '\u2705 Shared to Telegram channel!';
        st.className = 'status ok';
      } else {
        st.textContent = '\u274c Telegram: ' + (data.error || 'Unknown error');
        st.className = 'status err';
      }
    } catch (err) {
      st.textContent = '\u274c Telegram share failed: ' + err.message;
      st.className = 'status err';
    }
    btn.disabled = false; btn.textContent = '\ud83d\udce2 Telegram';
  });

  /* ── Post to the brand's Facebook Page ──
   * Same card as the download, rendered at 1x as JPEG (Facebook recompresses
   * anyway). The server puts the article link in the caption or as the first
   * comment, per the brand's FB_LINK_IN setting. */
  $('#cShareFb').addEventListener('click', async () => {
    const st = $('#cStatus');
    const btn = $('#cShareFb');
    const caption = getCaptionText();
    if (!caption) { st.textContent = 'Generate a caption first'; st.className = 'status err'; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Posting\u2026';
    try {
      const {w, h} = dims();
      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = w; canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      await render();
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.92);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      canvas.width = prevW; canvas.height = prevH;
      render();

      const r = await fetch('/api/facebook/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption, articleUrl: state.c.url || '', imageBase64, brand: state.brand })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      st.textContent = data.commentError
        ? '\u2705 Posted to Facebook \u2014 but ' + data.commentError
        : '\u2705 Posted to Facebook Page!' + (data.commentId ? ' Link added as first comment.' : data.linkIn === 'caption' && data.link ? ' Link in caption.' : '');
      st.className = data.commentError ? 'status err' : 'status ok';
    } catch (err) {
      st.textContent = '\u274c Facebook: ' + err.message;
      st.className = 'status err';
    }
    btn.disabled = false; btn.textContent = '\ud83d\udcd8 Facebook';
  });

  /* ── Share to Viber Channel ── */
  $('#cShareVb').addEventListener('click', async () => {
    const st = $('#cStatus');
    const btn = $('#cShareVb');
    const caption = getCaptionText();
    if (!caption) { st.textContent = 'Generate a caption first'; st.className = 'status err'; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Posting\u2026';
    try {
      /* Viber accepts JPEG only, capped at 1MB, and fetches the URL itself rather
       * than taking an upload — so render at 1x and hand the server a JPEG. */
      const {w, h} = dims();
      const prevW = canvas.width, prevH = canvas.height;
      canvas.width = w; canvas.height = h;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      await render();
      let imageBase64 = canvas.toDataURL('image/jpeg', 0.9);
      // Back off on quality rather than failing at the server's 1MB check.
      if (imageBase64.length * 0.75 > 1024 * 1024) imageBase64 = canvas.toDataURL('image/jpeg', 0.75);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      canvas.width = prevW; canvas.height = prevH;
      render();

      const articleUrl = state.c.url || '';

      const r = await fetch('/api/viber/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ caption, articleUrl, imageBase64, brand: state.brand })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || ('HTTP ' + r.status));
      st.textContent = '\u2705 Posted to Viber channel!';
      st.className = 'status ok';
    } catch (err) {
      st.textContent = '\u274c Viber: ' + err.message;
      st.className = 'status err';
    }
    btn.disabled = false; btn.textContent = '\ud83d\udfe3 Viber';
  });

  /* ── Share to Twitter/X via IFTTT ── */
  $('#cShareX').addEventListener('click', async () => {
    const st = $('#cStatus');
    const btn = $('#cShareX');
    const caption = getCaptionText();
    const articleUrl = state.c.url || '';
    if (!caption && !articleUrl) { st.textContent = 'Need caption or article URL'; st.className = 'status err'; return; }

    btn.disabled = true; btn.textContent = '\u23F3 Tweeting\u2026';
    try {
      const fullUrl = articleUrl ? (articleUrl.startsWith('http') ? articleUrl : 'https://' + articleUrl) : '';
      const r = await fetch('/api/x/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ headline: caption, articleUrl: fullUrl, brand: state.brand })
      });
      const data = await r.json();
      if (data.ok && data.manual) {
        /* This month's automatic tweets are used up: nothing was sent. Open X
         * with the caption and link filled in. The link stays in the status
         * line as well, because a browser may block a tab opened after a fetch. */
        let opened = null;
        try { opened = window.open(data.intentUrl, '_blank'); } catch (_) {}
        st.textContent = opened ? 'X opened in a new tab \u2014 press Post there. ' : 'Automatic tweets are used up for this month. ';
        const a = document.createElement('a');
        a.href = data.intentUrl; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Open X to post';
        a.style.color = 'inherit'; a.style.textDecoration = 'underline';
        st.appendChild(a);
        st.className = 'status ok';
      } else if (data.ok) {
        st.textContent = '\u2705 Sent to Twitter!';
        st.className = 'status ok';
      } else {
        st.textContent = '\u274c Twitter: ' + (data.error || 'Unknown error');
        st.className = 'status err';
      }
    } catch (err) {
      st.textContent = '\u274c Twitter failed: ' + err.message;
      st.className = 'status err';
    }
    btn.disabled = false; btn.textContent = '\ud83d\udc26 Twitter';
  });

  if (szCtrl) {
    szUI = window.SafeZones.buildControl(szCtrl, { label: 'Safe zones' });
    $('#cSafeZone').appendChild(szUI.el);
  }
  resNote(); buildFields(); render(); updateCaption(); setTimeout(fit, 50);
  loadShareTargets();   // hides Telegram/X for brands with no destination configured
  SC.ensureAssets().then(()=>{
    if(SC.fontsFailed.length){const st=$('#cStatus');st.textContent='\u26A0 Font not loading: '+SC.fontsFailed.map(f=>f.file+' ('+f.reason+')').join(', ')+' \u2014 check filenames in public/fonts/';st.className='status err';}
  });

  // Listen for articles loaded from queue
  window.addEventListener('vxd-load-article', async (e) => {
    const a = e.detail;
    if (!a) return;
    state.c.articleId = a.id; // track for FB metrics
    // fill source text
    if (a.text) $('#cSrc').value = a.text;
    // fill headline
    if (a.title) state.c.headline = a.title;
    // fill URL
    try { const u = new URL(a.url); state.c.url = u.hostname.replace('www.','')+u.pathname; } catch { state.c.url = a.url; }
    if (window.ReyvaCard) state.c.url = window.ReyvaCard.cardLink(state.c.url);   // REYVA
    // set brand
    if (BRAND_KEYS.includes(a.brand)) {
      state.brand = a.brand;
      $('#cBrand').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === a.brand));
      syncAccentToBrand();
      syncHeadSizeToBrand();
      syncCaptionDir();
      applyShareButtons();
    }
    setSport(a.brand === SPORT.brand && SC.isSportSection(a.section));
    // load image (proxy via server for base64)
    if (a.image_url) {
      try {
        // Fetch image through our proxy to get base64
        const ir = await fetch('/api/proxy-image', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ url: a.image_url }) });
        const idata = await ir.json();
        if (idata.image) {
          await SC.loadImage(idata.image);
          state.photo = idata.image;
          state.photoImg = null; state.cut = null; state.photoPos = { x: 0, y: 0 };
          canvas.style.cursor = 'grab';
        }
      } catch {}
    }
    state.c.date = todayFor(state.brand);
    buildFields(); render(); updateCaption();
    $('#cAIStatus').textContent = 'Article loaded from queue \u2713 \u2014 generating caption\u2026';
    $('#cAIStatus').className = 'status ok';
    generateCaption();
  });
})();
