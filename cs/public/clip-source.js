/* clip-source.js — video clip ingest, preview seeking, and sequential export decode.
 *
 * Standalone: depends only on mp4box (global MP4Box + DataStream) and WebCodecs.
 * Does not touch StudioCore. Lives in /lab/ until video-studio.js is ready for it.
 *
 * Design, settled by probing real footage:
 *   PREVIEW  → <video> element. Keyframe spacing varies 28–136 frames across real
 *              sources, so decode-based scrubbing has unpredictable cost. The browser's
 *              own seek is approximate but uniformly fast, which is what a trim handle needs.
 *   EXPORT   → WebCodecs, one sequential forward pass. Frame-accurate, pays the
 *              keyframe penalty once on entry instead of once per frame.
 *
 * window.ClipSource = { open, drawClip, VERSION }
 */
(function () {
  'use strict';

  const VERSION = 'clip-source v1.1';
  const TARGET_W = 1080, TARGET_H = 1920;
  const MP4BOX_CDN = 'https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js';

  /* mp4box is only needed for the export path, so it loads on first video ingest
     rather than on app start — keeps the main bundle unchanged. */
  let demuxerLoad = null;
  function ensureDemuxer() {
    if (window.MP4Box) return Promise.resolve(true);
    if (demuxerLoad) return demuxerLoad;
    demuxerLoad = new Promise(res => {
      const s = document.createElement('script');
      s.src = MP4BOX_CDN;
      s.onload = () => res(!!window.MP4Box);
      s.onerror = () => res(false);
      document.head.appendChild(s);
    });
    return demuxerLoad;
  }

  const getDataStream = () =>
    window.DataStream || (window.MP4Box && window.MP4Box.DataStream) || null;

  /* ────────────────────────────── probe ────────────────────────────── */

  function sniff(buf) {
    const b = new Uint8Array(buf.slice(0, 16));
    const a = String.fromCharCode.apply(null, b);
    if (a.slice(4, 8) === 'ftyp') return { fmt: 'MP4/MOV (' + a.slice(8, 12).trim() + ')', demuxable: true };
    if (b[0] === 0x1a && b[1] === 0x45) return { fmt: 'Matroska/WebM', demuxable: false };
    if (a.startsWith('RIFF')) return { fmt: 'AVI', demuxable: false };
    return { fmt: 'unknown', demuxable: false };
  }

  function matrixRotation(m) {
    if (!m || m.length < 4) return 0;
    const a = m[0] / 65536, b = m[1] / 65536;
    const deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
    return ((deg % 360) + 360) % 360;
  }

  function extractDescription(file, trackId) {
    const DS = getDataStream();
    if (!DS) throw new Error('DataStream global not found (mp4box.all not loaded?)');
    const trak = file.getTrackById(trackId);
    if (!trak) throw new Error('track ' + trackId + ' not found');
    const stsd = trak.mdia && trak.mdia.minf && trak.mdia.minf.stbl && trak.mdia.minf.stbl.stsd;
    if (!stsd || !stsd.entries) throw new Error('no stsd box — malformed file');
    for (const e of stsd.entries) {
      const box = e.avcC || e.hvcC || e.vpcC || e.av1C;
      if (box) {
        const ds = new DS(undefined, 0, DS.BIG_ENDIAN);
        box.write(ds);
        // write() emits the 8-byte box header; the decoder wants payload only
        return { data: new Uint8Array(ds.buffer, 8), kind: e.avcC ? 'avcC' : e.hvcC ? 'hvcC' : e.vpcC ? 'vpcC' : 'av1C' };
      }
    }
    throw new Error('no codec description box inside sample entry');
  }

  function demux(buffer) {
    return new Promise((resolve, reject) => {
      const mp4 = MP4Box.createFile();
      mp4.onError = e => reject(new Error(String(e)));
      mp4.onReady = info => resolve({ mp4, info });
      buffer.fileStart = 0;
      mp4.appendBuffer(buffer);
      mp4.flush();
    });
  }

  function readSamples(mp4, track) {
    return new Promise(resolve => {
      const out = [];
      mp4.setExtractionOptions(track.id, null, { nbSamples: 200000 });
      mp4.onSamples = (id, user, samples) => {
        for (const s of samples) {
          out.push({
            cts: s.cts / s.timescale,
            dts: s.dts / s.timescale,
            dur: (s.duration || 0) / s.timescale,
            key: !!s.is_sync,
            data: s.data
          });
        }
      };
      mp4.start();
      // NOTE: deliberately NOT sorted. mp4box delivers samples in DECODE order,
      // which is what VideoDecoder requires. With B-frames (any Main/High profile
      // clip) decode order != presentation order, and sorting by cts makes the
      // decoder wait forever for reference frames it will never receive.
      setTimeout(() => resolve(out), 60);
    });
  }

  /* How much this clip has to be enlarged to fill a 1080x1920 frame.
     >1.4 starts to look soft; the Telegram-recompressed case lands near 2.3. */
  function qualityAssessment(w, h, rotation) {
    const sw = (rotation === 90 || rotation === 270) ? h : w;
    const sh = (rotation === 90 || rotation === 270) ? w : h;
    const scaleCover = Math.max(TARGET_W / sw, TARGET_H / sh);   // cover: fills, crops
    const scaleFit = Math.min(TARGET_W / sw, TARGET_H / sh);     // fit: no crop
    let verdict = 'good', note = 'Native resolution or better.';
    if (scaleCover > 2.0) { verdict = 'poor'; note = 'Heavy upscale — will look soft next to photo slides.'; }
    else if (scaleCover > 1.4) { verdict = 'fair'; note = 'Noticeable upscale. Fit mode keeps it sharper.'; }
    else if (scaleCover > 1.05) { verdict = 'good'; note = 'Mild upscale, should hold up.'; }
    return { scaleCover: +scaleCover.toFixed(2), scaleFit: +scaleFit.toFixed(2), verdict, note };
  }

  /* ─────────────────────────── export reader ─────────────────────────── */
  /* Sequential, monotonic. frameAt(t) expects non-decreasing t; going backwards
     costs a re-seek to the preceding keyframe, which is exactly what export never does. */

  function createExportReader(clip, log) {
    const samples = clip._samples;          // DECODE order — do not sort
    const cfg = clip._decoderConfig;
    const avgDur = clip.info.duration / Math.max(samples.length, 1);

    let dec = null, queue = [], feedIdx = 0;
    let seeks = 0, decoded = 0, fed = 0, closed = false;
    /* VideoDecoder rejects a delta chunk as the first input after configure() or
       flush(). needKey tracks that state; when it is set and the next sample is a
       delta, feedOne backs up to the GOP's keyframe and re-decodes, dropping any
       output at or before resyncFloor (frames the decoder already handed us). */
    let needKey = true, lastOutTs = -Infinity, resyncFloor = -Infinity;

    const fStart = f => f.timestamp / 1e6;
    const fEnd = f => fStart(f) + (f.duration ? f.duration / 1e6 : avgDur);

    function dropQueue() {
      for (const f of queue) { try { f.close(); } catch (_) {} }
      queue = [];
    }

    function openDecoder() {
      dec = new VideoDecoder({
        output: f => {
          decoded++;
          if (f.timestamp <= resyncFloor) { try { f.close(); } catch (_) {} return; }
          if (f.timestamp > lastOutTs) lastOutTs = f.timestamp;
          queue.push(f);
          // decoders emit in presentation order, but keep this honest regardless —
          // the queue is capped at 16 so the sort is free
          queue.sort((a, b) => a.timestamp - b.timestamp);
        },
        error: e => { if (!closed && log) log('decoder error: ' + e.message, 'er'); }
      });
      dec.configure(cfg);
      needKey = true;
      lastOutTs = -Infinity;
      resyncFloor = -Infinity;
    }

    /* Latest keyframe whose presentation time is at or before t, returned as its
       DECODE-order index. Scans by cts because the array is in decode order. */
    function keyframeIdxBefore(t) {
      let bestIdx = 0, bestCts = -Infinity;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.key && s.cts <= t + 1e-6 && s.cts > bestCts) { bestCts = s.cts; bestIdx = i; }
      }
      if (bestCts === -Infinity) {
        // nothing at or before t (composition offset puts the first keyframe's cts
        // slightly above 0): start at the first keyframe in decode order, never at a delta
        const first = samples.findIndex(s => s.key);
        return first < 0 ? 0 : first;
      }
      return bestIdx;
    }

    function feedOne() {
      if (needKey && !samples[feedIdx].key) {
        let k = feedIdx;
        while (k > 0 && !samples[k].key) k--;
        if (!samples[k].key) {                       // no keyframe behind: skip ahead to one
          k = feedIdx;
          while (k < samples.length && !samples[k].key) k++;
        }
        if (k >= samples.length) { feedIdx = samples.length; return; }
        resyncFloor = Math.max(resyncFloor, lastOutTs);
        feedIdx = k;
      }
      const s = samples[feedIdx++];
      needKey = false;
      fed++;
      dec.decode(new EncodedVideoChunk({
        type: s.key ? 'key' : 'delta',
        timestamp: Math.round(s.cts * 1e6),
        duration: Math.round((s.dur || avgDur) * 1e6),
        data: s.data
      }));
    }

    async function seekTo(t) {
      seeks++;
      dropQueue();
      if (dec) { try { dec.close(); } catch (_) {} dec = null; }
      openDecoder();
      feedIdx = keyframeIdxBefore(t);
    }

    /* Returns the best available VideoFrame for t. The frame stays owned by the
       reader — draw it immediately, never hold or close it. */
    async function frameAt(t) {
      if (closed) throw new Error('reader is closed');
      if (!dec) await seekTo(t);
      if (queue.length && t < fStart(queue[0]) - 0.25) await seekTo(t);   // real jump backwards

      let spins = 0, flushed = false;
      while (spins++ < 400) {
        while (queue.length > 1 && fEnd(queue[0]) <= t + 1e-6) {
          try { queue.shift().close(); } catch (_) {}
        }
        // covers t, or is the nearest frame ahead of it — either is better than spinning
        if (queue.length && fEnd(queue[0]) > t + 1e-6) return queue[0];

        if (feedIdx < samples.length) {
          while (feedIdx < samples.length && dec.decodeQueueSize < 12 && queue.length < 16) feedOne();
        } else if (!flushed) {
          flushed = true; await dec.flush(); needKey = true; continue;
        } else {
          return queue[0] || null;                    // past the end — hold the last frame
        }

        // decoder swallowing input without emitting anything: force it to drain
        if (spins > 24 && queue.length === 0 && !flushed) {
          flushed = true;
          if (log) log('no decoder output after ' + fed + ' chunks — forcing flush', 'wa');
          await dec.flush();
          needKey = true;                             // next chunk must be a keyframe
          continue;
        }
        await new Promise(r => setTimeout(r, 0));
      }
      throw new Error('frameAt stalled at t=' + t.toFixed(3) +
        ' [state=' + (dec && dec.state) + ' fed=' + fed +
        ' inQueue=' + (dec && dec.decodeQueueSize) + ' decoded=' + decoded +
        ' held=' + queue.length + ']');
    }

    function close() {
      closed = true;
      dropQueue();
      if (dec) { try { dec.close(); } catch (_) {} dec = null; }
    }

    return { frameAt, seekTo, close, stats: () => ({ seeks, decoded, fed }) };
  }

  /* ───────────────────────────── clip object ───────────────────────────── */

  async function open(file, log) {
    const say = (m, c) => { if (log) log(m, c); };
    const buffer = await file.arrayBuffer();

    const sn = sniff(buffer);
    say('container: ' + sn.fmt, sn.demuxable ? 'ok' : 'wa');

    const info = {
      name: file.name, size: file.size, container: sn.fmt,
      demuxable: sn.demuxable, exportPath: 'element'
    };

    /* preview element — always created, this is the scrubbing path for every clip */
    const url = URL.createObjectURL(file);
    const el = document.createElement('video');
    el.src = url; el.muted = true; el.playsInline = true; el.preload = 'auto';
    await new Promise((res, rej) => {
      el.addEventListener('loadedmetadata', res, { once: true });
      el.addEventListener('error', () => rej(new Error('browser cannot play this file')), { once: true });
      setTimeout(() => rej(new Error('metadata load timed out')), 15000);
    });
    info.duration = el.duration;
    info.elementW = el.videoWidth;
    info.elementH = el.videoHeight;
    say('element ready: ' + el.videoWidth + '×' + el.videoHeight + ' · ' + el.duration.toFixed(2) + 's', 'ok');

    const clip = {
      info, el, file,
      _samples: null, _decoderConfig: null, _audio: null,
      previewDrawable: el
    };

    /* preview seek — one in flight at a time, later requests supersede earlier ones */
    let seeking = false, pending = null;
    clip.previewSeek = function (t) {
      const target = Math.max(0, Math.min(t, (info.duration || 0) - 0.001));
      if (seeking) { pending = target; return Promise.resolve(); }
      seeking = true;
      return new Promise(res => {
        const done = () => {
          el.removeEventListener('seeked', done);
          seeking = false;
          if (pending != null) { const p = pending; pending = null; clip.previewSeek(p).then(res); }
          else res();
        };
        el.addEventListener('seeked', done);
        el.currentTime = target;
      });
    };

    /* audio — decodeAudioData handles MP4/M4A directly and resamples to the
       context rate, which is already the 48k the muxer wants */
    clip.decodeAudio = async function (ctx) {
      if (clip._audio) return clip._audio;
      try {
        const ac = ctx || new (window.AudioContext || window.webkitAudioContext)();
        clip._audio = await ac.decodeAudioData(buffer.slice(0));
        say('audio decoded: ' + clip._audio.duration.toFixed(2) + 's, ' +
            clip._audio.numberOfChannels + 'ch @ ' + clip._audio.sampleRate + 'Hz', 'ok');
        if (!ctx) ac.close();
      } catch (e) {
        clip._audio = null;
        say('audio decode failed: ' + (e.message || 'unsupported'), 'wa');
      }
      return clip._audio;
    };

    /* demux + decoder config — only needed for the export path */
    if (sn.demuxable && 'VideoDecoder' in window && await ensureDemuxer()) {
      try {
        const { mp4, info: mi } = await demux(buffer);
        const vt = mi.videoTracks && mi.videoTracks[0];
        if (!vt) throw new Error('no video track');
        const at = mi.audioTracks && mi.audioTracks[0];

        info.codec = vt.codec;
        info.codedW = vt.video.width;
        info.codedH = vt.video.height;
        info.rotation = matrixRotation(vt.matrix);
        info.nbSamples = vt.nb_samples;
        info.fps = +(vt.nb_samples / (vt.duration / vt.timescale)).toFixed(2);
        info.hasAudio = !!at;
        info.audioCodec = at ? at.codec : null;

        const desc = extractDescription(mp4, vt.id);
        const cfg = {
          codec: vt.codec,
          codedWidth: info.codedW,
          codedHeight: info.codedH,
          description: desc.data
        };
        const sup = await VideoDecoder.isConfigSupported(cfg);
        info.supported = !!sup.supported;

        if (info.supported) {
          clip._decoderConfig = cfg;
          clip._samples = await readSamples(mp4, vt);
          const keys = clip._samples.filter(s => s.key).length;
          info.keyframes = keys;
          info.gop = +(clip._samples.length / Math.max(keys, 1)).toFixed(1);
          info.exportPath = 'webcodecs';
          say('export path: WebCodecs · ' + vt.codec + ' · ' + clip._samples.length +
              ' samples, ' + keys + ' keyframes (GOP ' + info.gop + ')', 'ok');
        } else {
          say('export path: element — ' + vt.codec + ' not configurable here', 'wa');
        }
      } catch (e) {
        say('demux failed (' + e.message + ') — element path only', 'wa');
      }
    } else if (!('VideoDecoder' in window)) {
      say('VideoDecoder missing — element path only', 'wa');
    }

    /* Rotation asymmetry, worth being loud about:
       the <video> element applies the display matrix itself, so videoWidth/Height are
       already rotated. A VideoFrame does NOT — it hands back coded dimensions. */
    info.rotation = info.rotation || 0;
    if (info.rotation) {
      say('rotation ' + info.rotation + '° — element auto-rotates, VideoFrame does not', 'wa');
    }

    info.quality = qualityAssessment(
      info.codedW || info.elementW,
      info.codedH || info.elementH,
      info.rotation
    );

    clip.createExportReader = function (l) {
      if (info.exportPath !== 'webcodecs') throw new Error('no WebCodecs path for this clip');
      return createExportReader(clip, l || log);
    };

    clip.close = function () {
      try { el.pause(); } catch (_) {}
      el.removeAttribute('src'); el.load();
      URL.revokeObjectURL(url);
      clip._samples = null; clip._audio = null;
    };

    return clip;
  }

  /* ───────────────────────────── drawing ───────────────────────────── */

  function dims(src, rotation, isFrame) {
    let w = src.displayWidth || src.videoWidth || src.width;
    let h = src.displayHeight || src.videoHeight || src.height;
    // only VideoFrames need manual rotation; the element already did it
    if (isFrame && (rotation === 90 || rotation === 270)) { const t = w; w = h; h = t; }
    return { w, h };
  }

  const isVideoFrame = s => typeof VideoFrame !== 'undefined' && s instanceof VideoFrame;

  /* fitMode: 'cover' crops to fill · 'fit' letterboxes over a blurred backdrop */
  function drawClip(c, src, cw, ch, opts) {
    const o = opts || {};
    const rotation = o.rotation || 0;
    const frame = isVideoFrame(src);
    const { w: sw, h: sh } = dims(src, rotation, frame);
    if (!sw || !sh) return false;

    const zoom = o.zoom == null ? 1 : o.zoom;
    const panX = o.panX || 0, panY = o.panY || 0;
    const ir = sw / sh, cr = cw / ch;

    c.save();
    c.clearRect(0, 0, cw, ch);

    const place = (scale, px, py) => {
      const dw = sw * scale, dh = sh * scale;
      const maxX = Math.max(0, (dw - cw) / 2), maxY = Math.max(0, (dh - ch) / 2);
      const x = (cw - dw) / 2 + px * maxX, y = (ch - dh) / 2 + py * maxY;
      if (frame && rotation) {
        c.save();
        c.translate(cw / 2, ch / 2);
        c.rotate(rotation * Math.PI / 180);
        // after rotating, draw in the source's own orientation
        const rw = (rotation === 90 || rotation === 270) ? dh : dw;
        const rh = (rotation === 90 || rotation === 270) ? dw : dh;
        c.drawImage(src, -rw / 2, -rh / 2, rw, rh);
        c.restore();
      } else {
        c.drawImage(src, x, y, dw, dh);
      }
    };

    if (o.fitMode === 'fit') {
      const fitScale = Math.min(cw / sw, ch / sh);
      const coverScale = Math.max(cw / sw, ch / sh);
      // blurred backdrop from the same frame, overscanned so the blur has no edge
      c.save();
      c.filter = 'blur(38px)';
      place(coverScale * 1.25, 0, 0);
      c.restore();
      c.save();
      c.fillStyle = 'rgba(0,0,0,0.25)';
      c.fillRect(0, 0, cw, ch);
      c.restore();
      place(fitScale * zoom, 0, 0);
    } else {
      const coverScale = (ir > cr ? ch / sh : cw / sw) * zoom;
      place(coverScale, panX, panY);
    }

    c.restore();
    return true;
  }

  window.ClipSource = { open, drawClip, qualityAssessment, VERSION };
})();
