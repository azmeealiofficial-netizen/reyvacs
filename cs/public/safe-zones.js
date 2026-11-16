/* safe-zones.js — platform UI safe zones for card + reel templates.
 *
 * IMPORTANT: the overlay is a DOM layer stacked above the canvas. Nothing is
 * ever drawn into the 2D context, because card-studio re-uses the SAME
 * #cCanvas for export (exportPng / AI caption / Viber all resize it, re-run
 * render(), then toBlob). A ctx-drawn guide would ship to Facebook.
 *
 * Coordinates are in a 1080-wide reference space and applied as percentages,
 * so they hold at any preview scale or export multiplier.
 *
 * Numbers checked 2026-08-30. TikTok is measured from the VxD reference
 * template; Meta is the unified 9:16 spec (March 2026); X is derived — X has
 * never published a safe-zone spec.
 */
(function () {
  'use strict';

  var CHECKED = '2026-08-30';

  var DATA = {
    '9:16': { w: 1080, h: 1920, def: 'meta', targets: {
      tiktok: { name: 'TikTok', top: 120, right: 50, bottom: 376, left: 48,
        cutouts: [ { x: 884, y: 956, w: 196, h: 588, label: 'action rail' },
                   { x: 310, y: 130, w: 452, h: 92,  label: 'feed tabs' } ],
        note: 'Measured off the VxD reference template. Right margin is only 50px until the action rail starts at y=956.' },
      meta: { name: 'Instagram + Facebook', top: 270, right: 65, bottom: 672, left: 65, cutouts: [],
        note: 'Meta unified 9:16 spec — one rule for FB Stories, IG Stories, FB Reels, IG Reels. The 672px bottom is the harshest band anywhere.' },
      x: { name: 'X (Twitter)', top: 110, right: 60, bottom: 430, left: 60,
        cutouts: [ { x: 900, y: 1050, w: 180, h: 440, label: 'action rail' } ],
        note: 'DERIVED, not published. Read off the immersive player. Verify on a real post before trusting it.' },
      chat: { name: 'Telegram + Viber', top: 40, right: 40, bottom: 40, left: 40, cutouts: [],
        note: 'No overlaid chrome. Corner-rounding and thumbnail-crop tolerance only.' },
      universal: { name: 'All platforms (strictest)', top: 270, right: 196, bottom: 672, left: 65, cutouts: [],
        note: 'Worst case on every edge: 819 x 978, 39% of the frame. Tight enough that per-destination renders are often the better trade.' }
    } },
    '4:5': { w: 1080, h: 1350, def: 'universal', targets: {
      meta: { name: 'Instagram + Facebook', top: 250, right: 100, bottom: 250, left: 100, cutouts: [],
        note: 'The feed is full-bleed now — profile row over the top, caption over the bottom. 250/250 is not decorative padding.' },
      x: { name: 'X (Twitter)', top: 40, right: 40, bottom: 40, left: 40, cutouts: [],
        note: 'No overlay. Watch the timeline crop instead — taller than ~4:5 gets centre-cropped until tapped.' },
      chat: { name: 'Telegram + Viber', top: 40, right: 40, bottom: 40, left: 40, cutouts: [],
        note: 'Full bleed. Keep type off the rounded corners.' },
      universal: { name: 'Feed \u2014 all destinations', top: 250, right: 100, bottom: 250, left: 100, cutouts: [],
        note: 'Meta is strictest on all four sides, so the intersection is just the Meta profile.' }
    } },
    '1:1': { w: 1080, h: 1080, def: 'universal', targets: {
      meta: { name: 'Instagram + Facebook', top: 100, right: 100, bottom: 100, left: 100, cutouts: [],
        note: '880 x 880 working area. Squares sit higher in the viewport, clear of the caption row.' },
      x: { name: 'X (Twitter)', top: 40, right: 40, bottom: 40, left: 40, cutouts: [],
        note: 'Squares show uncropped in the timeline. Safest card shape for X.' },
      chat: { name: 'Telegram + Viber', top: 40, right: 40, bottom: 40, left: 40, cutouts: [],
        note: 'Full bleed.' },
      universal: { name: 'Feed \u2014 all destinations', top: 100, right: 100, bottom: 100, left: 100, cutouts: [],
        note: 'Same as Meta — nothing else bites deeper.' }
    } }
  };

  /* Order is by how often it is the right answer, NOT by strictness. 'universal'
   * sits last because it is the union of every platform's worst edge — stricter
   * than anything real (TikTok's bottom is 376, not Meta's 672; Meta's right is
   * 65, not TikTok's 196) — and a list that opens on it teaches people the
   * templates have far less room than they do. */
  var ORDER = ['meta', 'tiktok', 'x', 'chat', 'universal'];

  /* pick the ratio bucket from actual canvas dimensions */
  function ratioKey(w, h) {
    var r = h / w;
    if (r >= 1.5) return '9:16';
    if (r >= 1.15) return '4:5';
    return '1:1';
  }

  function targetsFor(key) {
    var t = DATA[key].targets;
    return ORDER.filter(function (id) { return t[id]; })
                .map(function (id) { return { id: id, name: t[id].name }; });
  }

  /* widest rectangle that also clears every edge-hugging cut-out */
  function coreRect(p, d) {
    var x = p.left, y = p.top, r = d.w - p.right, b = d.h - p.bottom;
    (p.cutouts || []).forEach(function (k) {
      var kr = k.x + k.w, kb = k.y + k.h;
      if (kr >= d.w - p.right - 20) r = Math.min(r, k.x);
      else if (k.x <= p.left + 20) x = Math.max(x, kr);
      else if (k.y <= p.top + 20) y = Math.max(y, kb);
      else if (kb >= d.h - p.bottom - 20) b = Math.min(b, k.y);
    });
    return { x: x, y: y, w: r - x, h: b - y };
  }

  function css(el, o) { for (var k in o) el.style[k] = o[k]; return el; }

  /* ---------------------------------------------------------------- overlay */
  function attach(canvas, opts) {
    opts = opts || {};

    /* wrap the canvas once so the overlay can sit on top of it exactly */
    var wrap = canvas.parentNode;
    if (!wrap || !wrap.classList.contains('sz-wrap')) {
      wrap = document.createElement('div');
      wrap.className = 'sz-wrap';
      css(wrap, { position: 'relative', display: 'inline-block', lineHeight: '0', flex: '0 0 auto' });
      canvas.parentNode.insertBefore(wrap, canvas);
      wrap.appendChild(canvas);
    }

    var layer = document.createElement('div');
    layer.className = 'sz-layer';
    css(layer, {
      position: 'absolute', inset: '0', pointerEvents: 'none',
      borderRadius: getComputedStyle(canvas).borderRadius || '12px',
      overflow: 'hidden', display: 'none', zIndex: '3'
    });
    wrap.appendChild(layer);

    var state = { on: false, target: opts.target || null, userSet: !!opts.target };
    var onChange = null;

    /* render() is async in both studios and sets canvas.width after the click
       handler returns, so a sync() call at the call site is always one format
       behind. Watch the attributes instead. */
    var lastKey = null;
    var mo = new MutationObserver(function () {
      paint();
      var k = ratioKey(canvas.width, canvas.height);
      if (k !== lastKey) { lastKey = k; if (onChange) onChange(); }
      else if (onChange) onChange();
    });
    mo.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });

    function profile() {
      var key = ratioKey(canvas.width, canvas.height);
      var d = DATA[key];
      if (!state.target) state.target = d.def;
      var p = d.targets[state.target] || d.targets[d.def] || d.targets[Object.keys(d.targets)[0]];
      return { key: key, d: d, p: p };
    }

    function paint() {
      layer.innerHTML = '';
      if (!state.on) { layer.style.display = 'none'; return; }
      layer.style.display = 'block';

      var q = profile(), d = q.d, p = q.p;
      var px = function (v) { return (v / d.w * 100) + '%'; };
      var py = function (v) { return (v / d.h * 100) + '%'; };
      var band = 'rgba(255,45,20,.20)';
      var line = 'rgba(255,45,20,.75)';

      function add(o, extra) {
        var e = document.createElement('div');
        css(e, o); if (extra) e.textContent = extra;
        layer.appendChild(e); return e;
      }

      add({ position: 'absolute', left: '0', right: '0', top: '0', height: py(p.top), background: band });
      add({ position: 'absolute', left: '0', right: '0', bottom: '0', height: py(p.bottom), background: band });
      add({ position: 'absolute', left: '0', width: px(p.left), top: py(p.top), bottom: py(p.bottom), background: band });
      add({ position: 'absolute', right: '0', width: px(p.right), top: py(p.top), bottom: py(p.bottom), background: band });

      (p.cutouts || []).forEach(function (k) {
        add({ position: 'absolute', left: px(k.x), top: py(k.y), width: px(k.w), height: py(k.h),
              background: band, border: '1px dashed ' + line, boxSizing: 'border-box' });
      });

      add({ position: 'absolute', left: px(p.left), top: py(p.top),
            width: px(d.w - p.left - p.right), height: py(d.h - p.top - p.bottom),
            border: '1.5px dashed ' + line, boxSizing: 'border-box' });

      var core = coreRect(p, d);
      if (core.w !== d.w - p.left - p.right || core.h !== d.h - p.top - p.bottom ||
          core.x !== p.left || core.y !== p.top) {
        add({ position: 'absolute', left: px(core.x), top: py(core.y), width: px(core.w), height: py(core.h),
              border: '1px solid rgba(255,255,255,.35)', boxSizing: 'border-box' });
      }
    }

    var ctrl = {
      onChange: function (fn) { onChange = fn; return ctrl; },
      destroy: function () { mo.disconnect(); },
      show: function (v) { state.on = !!v; paint(); return ctrl; },
      toggle: function () { return ctrl.show(!state.on); },
      isOn: function () { return state.on; },
      /* fromUser distinguishes a deliberate choice from a resolved default.
       * Without it, the default picked for one ratio ('universal' at 4:5) rides
       * along into another where a different default applies, and 9:16 silently
       * opens on the strictest union nobody asked for. */
      setTarget: function (id, fromUser) {
        state.target = id;
        if (fromUser) state.userSet = true;
        paint(); return ctrl;
      },
      target: function () { return state.target; },
      isUserSet: function () { return state.userSet; },
      refresh: paint,
      info: function () {
        var q = profile(), d = q.d, p = q.p, core = coreRect(p, d);
        return { ratio: q.key, target: state.target, name: p.name, note: p.note,
                 frame: { w: d.w, h: d.h },
                 margins: { top: p.top, right: p.right, bottom: p.bottom, left: p.left },
                 safe: { x: p.left, y: p.top, w: d.w - p.left - p.right, h: d.h - p.top - p.bottom },
                 core: core, checked: CHECKED };
      },
      /* Hook for a future publish-time warning. Feed it rendered content
         rects in 1080-reference coordinates; returns the ones that break out. */
      check: function (boxes) {
        var q = profile(), s = ctrl.info().core;
        return (boxes || []).filter(function (b) {
          return b.x < s.x || b.y < s.y || b.x + b.w > s.x + s.w || b.y + b.h > s.y + s.h;
        });
      }
    };

    return ctrl;
  }

  /* -------------------------------------------------------------- control UI */
  /* Builds a sidebar block. Returns { el, sync } — call sync() whenever the
     canvas size changes so the target list matches the new aspect ratio. */
  function buildControl(ctrl, o) {
    o = o || {};
    var wrapEl = document.createElement('div');
    wrapEl.className = 'grp';
    wrapEl.style.cssText = 'margin-top:12px;border-top:1px solid var(--border);padding-top:12px';

    var lab = document.createElement('label');
    lab.textContent = o.label || 'Safe zones';
    wrapEl.appendChild(lab);

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = 'sz-on-' + Math.random().toString(36).slice(2, 8);
    cb.style.cssText = 'margin:0;accent-color:var(--accent,#ff3b18);cursor:pointer';
    var cbLab = document.createElement('label');
    cbLab.htmlFor = cb.id;
    cbLab.textContent = 'Show overlay';
    cbLab.style.cssText = 'margin:0;font-size:12.5px;cursor:pointer;color:var(--text)';
    row.appendChild(cb); row.appendChild(cbLab);
    wrapEl.appendChild(row);

    var sel = document.createElement('select');
    sel.style.cssText = 'width:100%;background:var(--field);border:1px solid var(--border);' +
                        'border-radius:var(--r-sm);padding:7px 8px;color:var(--text);' +
                        'font-family:var(--font);font-size:12.5px';
    wrapEl.appendChild(sel);

    var note = document.createElement('div');
    note.className = 'hint';
    note.style.cssText = 'font-size:10.5px;color:var(--muted);margin-top:5px;line-height:1.5';
    wrapEl.appendChild(note);

    function fillTargets() {
      var i = ctrl.info();
      var list = targetsFor(i.ratio);
      var want = ctrl.target();
      if (!want || !ctrl.isUserSet() || !list.some(function (t) { return t.id === want; })) {
        want = DATA[i.ratio].def;
        ctrl.setTarget(want);
      }
      sel.innerHTML = '';
      list.forEach(function (t) {
        var op = document.createElement('option');
        op.value = t.id; op.textContent = t.name;
        if (t.id === want) op.selected = true;
        sel.appendChild(op);
      });
    }

    function fillNote() {
      var i = ctrl.info();
      note.textContent = i.ratio + ' · safe ' + i.core.w + '×' + i.core.h +
        '  (top ' + i.margins.top + ', right ' + i.margins.right +
        ', bottom ' + i.margins.bottom + ', left ' + i.margins.left + ') — ' + i.note;
    }

    cb.addEventListener('change', function () { ctrl.show(cb.checked); });
    sel.addEventListener('change', function () {
      ctrl.setTarget(sel.value, true);
      fillNote();
      if (o.onTargetChange) o.onTargetChange();   // a studio that LAYS OUT to the zone must redraw
    });

    var syncing = false;
    function sync() {
      if (syncing) return;
      syncing = true;
      cb.checked = ctrl.isOn();
      fillTargets(); fillNote(); ctrl.refresh();
      syncing = false;
    }
    ctrl.onChange(sync);
    sync();

    return { el: wrapEl, sync: sync, checkbox: cb, select: sel };
  }

  window.SafeZones = {
    DATA: DATA, CHECKED: CHECKED,
    ratioKey: ratioKey, targetsFor: targetsFor, coreRect: coreRect,
    attach: attach, buildControl: buildControl
  };
})();
