/**
 * app.js — SOLARIS mobile capture flow.
 *
 * Pipeline for each of the two recordings:
 *
 *   getUserMedia -> MediaRecorder -> decode -> resample to 16 kHz mono
 *     -> background/noise removal (dsp.js) -> quality grade -> WAV
 *
 * Both the raw take and the cleaned take are kept. Discarding the original
 * recording in a language-archival project is not recoverable, so the raw
 * audio is always uploaded alongside the filtered version.
 */
(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────
  const CONFIG = {
    // Same origin as whatever served this page, so the phone talks to the
    // laptop without anybody editing an IP address by hand.
    serverUrl: location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:3001',
    targetSampleRate: 16000,
    minScore: 50,
    activeSTT: 'sarvam',
  };

  const DEFAULTS = { spk: 'SPK001', letter: 'అ', seg: 'place', sess: '01' };

  const LETTERS = [
    'అ','ఆ','ఇ','ఈ','ఉ','ఊ','ఋ','ఎ','ఏ','ఐ','ఒ','ఓ','ఔ','అం','అః',
    'క','ఖ','గ','ఘ','ఙ','చ','ఛ','జ','ఝ','ఞ',
    'ట','ఠ','డ','ఢ','ణ','త','థ','ద','ధ','న',
    'ప','ఫ','బ','భ','మ','య','ర','ల','వ',
    'శ','ష','స','హ','ళ','క్ష','జ్ఞ',
  ];

  const $ = (id) => document.getElementById(id);

  // ── State ───────────────────────────────────────────────────────────────────
  const S = {
    // Per side (B = Banjara, T = Telugu)
    rec:     { B: null, T: null },      // { raw, cleaned, samples, sampleRate, duration }
    mr:      { B: null, T: null },
    stream:  { B: null, T: null },
    startAt: { B: 0, T: 0 },
    ticker:  { B: null, T: null },
    isRec:   { B: false, T: false },
    scores:  { B: null, T: null },
    audio:   { B: null, T: null },      // HTMLAudioElement for playback
    peaks:   { B: null, T: null },
    useClean: true,
    stt: CONFIG.activeSTT,
    engines: { sarvam: false, groq: false },
    wakeLock: null,
    submitting: false,
  };

  let audioCtx = null;

  /** iOS only allows an AudioContext to start inside a user gesture. */
  function getAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not supported in this browser.');
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // ── Metadata ────────────────────────────────────────────────────────────────
  const loadMeta = (k) => localStorage.getItem('solaris_' + k) ?? DEFAULTS[k];
  const saveMeta = (k, v) => localStorage.setItem('solaris_' + k, v);

  function currentMeta() {
    const spk  = $('spk-id').value.trim() || 'SPK???';
    const lttr = $('tel-letter').value || '?';
    const seg  = $('seg-type').value || 'segment';
    const sess = String($('sess-num').value || '??').padStart(2, '0');
    const base = `${spk}_${lttr}_${seg}`;
    return {
      spk, lttr, seg, sess, base,
      // Forward slashes only; the server maps them onto whatever separator
      // the host OS uses, so a phone can write into a Windows dataset.
      folder: `speakers/${spk}/sessions/session_${sess}/${lttr}`,
      names: {
        banjara:    `${base}_banjara.wav`,
        telugu:     `${base}_telugu.wav`,
        transcript: `${base}_telugu.txt`,
        banjaraRaw: `${base}_banjara_raw.wav`,
        teluguRaw:  `${base}_telugu_raw.wav`,
      },
    };
  }

  function updateMeta() {
    const m = currentMeta();
    $('fn-b').textContent = m.names.banjara;
    $('fn-t').textContent = m.names.telugu;
    $('fn-x').textContent = m.names.transcript;
    $('savePath').textContent = m.folder;
    $('metaSummary').textContent = `${m.spk} · ${m.lttr} · S${m.sess}`;
    return m;
  }

  // ── Server health ───────────────────────────────────────────────────────────
  async function checkServer() {
    const pill = $('srvPill'), lbl = $('srvLbl');
    pill.className = 'srv-pill checking';
    lbl.textContent = 'checking…';
    try {
      const r = await fetch(CONFIG.serverUrl + '/health', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.status !== 'ok') throw new Error('bad health response');

      S.engines = j.engines || { sarvam: false, groq: false };
      pill.className = 'srv-pill ok';
      lbl.textContent = 'online';

      $('chipSarvam').disabled = !S.engines.sarvam;
      $('chipGroq').disabled   = !S.engines.groq;
      if (!S.engines[S.stt]) {
        const fallback = Object.keys(S.engines).find(k => S.engines[k]);
        if (fallback) selectSTT(fallback);
      }
      if (!S.engines.sarvam && !S.engines.groq) {
        $('tstatus').textContent = 'No STT engine configured — type the transcription manually.';
      }
    } catch {
      pill.className = 'srv-pill err';
      lbl.textContent = 'offline';
    }
    refreshQueue();
  }

  // ── Recording ───────────────────────────────────────────────────────────────
  /** Pick a container this browser will actually record. Safari has never
   *  supported WebM, so an unconditional webm mimeType throws on iPhone. */
  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/mp4;codecs=mp4a.40.2',
      'audio/mp4',
      'audio/aac',
      'audio/ogg;codecs=opus',
    ];
    for (const type of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) return type;
    }
    return '';   // let the browser choose its own default
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) S.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not fatal — the screen may just dim */ }
  }

  function releaseWakeLock() {
    if (S.wakeLock) { S.wakeLock.release().catch(() => {}); S.wakeLock = null; }
  }

  async function toggleRec(side) {
    if (S.isRec[side]) stopRec(side);
    else await startRec(side);
  }

  async function startRec(side) {
    clearAlert('err' + side);

    // Recording both at once would capture each language over the other.
    const other = side === 'B' ? 'T' : 'B';
    if (S.isRec[other]) stopRec(other);

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showAlert('err' + side, micUnavailableMessage(), 'err');
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        // The browser's own cleanup would fight our filtering and colour the
        // archive, so capture as close to raw as the device allows.
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
        },
        video: false,
      });
    } catch (err) {
      showAlert('err' + side,
        err && err.name === 'NotAllowedError'
          ? 'Microphone permission denied. Allow it in the browser settings and try again.'
          : micUnavailableMessage(),
        'err');
      return;
    }

    const mimeType = pickMimeType();
    let mr;
    try {
      mr = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      try { mr = new MediaRecorder(stream); }
      catch {
        stream.getTracks().forEach(t => t.stop());
        showAlert('err' + side, 'This browser cannot record audio. Try Chrome or Safari.', 'err');
        return;
      }
    }

    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      stopMeter(side);
      stream.getTracks().forEach(t => t.stop());
      S.stream[side] = null;
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      await processRecording(side, blob);
    };

    mr.start(200);
    S.mr[side] = mr;
    S.stream[side] = stream;
    S.isRec[side] = true;
    S.startAt[side] = Date.now();

    $('btn' + side).classList.add('active');
    $('lbl' + side).textContent = 'Stop Recording';
    $('panel' + side).classList.add('armed');
    $('player' + side).classList.remove('show');
    $('rerec' + side).classList.remove('show');
    $('check' + side).classList.remove('show');

    startMeter(side, stream);
    requestWakeLock();

    // Wall-clock, not a tick count: mobile browsers throttle timers hard when
    // the screen dims, and a counted interval silently under-reports.
    S.ticker[side] = setInterval(() => {
      const secs = Math.floor((Date.now() - S.startAt[side]) / 1000);
      const t = $('timer' + side);
      t.textContent = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
      t.classList.add('on');
    }, 250);
  }

  function micUnavailableMessage() {
    // By far the most common field failure: the phone opened the LAN address
    // over plain HTTP, and the browser silently refuses the microphone.
    if (!window.isSecureContext) {
      return 'Microphone blocked because this page is not on a secure connection.\n' +
             'Open it over https://, or run it on localhost.';
    }
    return 'Microphone unavailable on this device.';
  }

  function stopRec(side) {
    if (!S.isRec[side]) return;
    clearInterval(S.ticker[side]);
    S.isRec[side] = false;
    try { S.mr[side].stop(); } catch { /* already stopped */ }
    $('btn' + side).classList.remove('active');
    $('lbl' + side).textContent = 'Start Recording';
    $('timer' + side).classList.remove('on');
    $('panel' + side).classList.remove('armed');
    setLevel(side, 0);
    if (!S.isRec.B && !S.isRec.T) releaseWakeLock();
  }

  // ── Live input level ────────────────────────────────────────────────────────
  const meters = {};

  function startMeter(side, stream) {
    try {
      const ctx = getAudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);

      const buf = new Uint8Array(analyser.fftSize);
      let raf;
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i] - 128) / 128);
        setLevel(side, Math.min(100, peak * 140));
        raf = requestAnimationFrame(tick);
      };
      tick();
      meters[side] = { stop: () => { cancelAnimationFrame(raf); try { src.disconnect(); } catch {} } };
    } catch { /* the meter is a nicety; recording continues without it */ }
  }

  function stopMeter(side) {
    if (meters[side]) { meters[side].stop(); delete meters[side]; }
    setLevel(side, 0);
  }

  const setLevel = (side, pct) => { $('level' + side).style.width = pct + '%'; };

  // ── Decode, filter, grade ───────────────────────────────────────────────────
  async function processRecording(side, blob) {
    const status = side === 'B' ? 'Banjara' : 'Telugu';
    try {
      setBusy(side, `Processing ${status} audio…`);
      const { samples, sampleRate } = await decodeToMono16k(blob);

      if (!samples.length) throw new Error('The recording came back empty.');

      // Background/noise removal, same technique as the audio-splitter backend.
      const { cleaned } = SolarisDSP.denoise(samples);

      const rawWav     = new Blob([SolarisDSP.encodeWav(samples, sampleRate)], { type: 'audio/wav' });
      const cleanedWav = new Blob([SolarisDSP.encodeWav(cleaned, sampleRate)], { type: 'audio/wav' });

      S.rec[side] = {
        raw: rawWav,
        cleaned: cleanedWav,
        samples,
        cleanedSamples: cleaned,
        sampleRate,
        duration: samples.length / sampleRate,
      };

      drawWave(side);
      $('player' + side).classList.add('show');
      $('rerec' + side).classList.add('show');
      $('check' + side).classList.add('show');
      clearAlert('err' + side);

      grade(side);
      if (side === 'T') transcribe();
      updateSubmit();
    } catch (err) {
      console.error('[PROCESS]', err);
      showAlert('err' + side, `Could not process the recording: ${err.message}`, 'err');
      S.rec[side] = null;
      updateSubmit();
    }
  }

  /** Decode whatever container the browser produced, downmix to mono and
   *  resample to 16 kHz — the rate the dataset and both STT engines expect. */
  async function decodeToMono16k(blob) {
    const ctx = getAudioContext();
    const arrayBuffer = await blob.arrayBuffer();

    const decoded = await new Promise((resolve, reject) => {
      // Older Safari only implements the callback form and returns undefined.
      const maybePromise = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (maybePromise && typeof maybePromise.then === 'function') maybePromise.then(resolve, reject);
    });

    const target = CONFIG.targetSampleRate;
    if (Math.abs(decoded.sampleRate - target) < 1) {
      return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
    }

    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const frames = Math.ceil(decoded.duration * target);
    try {
      const off = new OAC(1, frames, target);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return { samples: rendered.getChannelData(0), sampleRate: target };
    } catch {
      // Some older Safari builds reject non-standard OfflineAudioContext
      // rates. Keeping the native rate is better than failing the take.
      return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
    }
  }

  function grade(side) {
    const rec = S.rec[side];
    if (!rec) return;

    // Grade the cleaned signal, since that is what gets archived and
    // transcribed.
    const d = rec.cleanedSamples;
    const dur = rec.duration;
    const sr = rec.sampleRate;

    const durOk = dur >= 2.0;
    const durSc = durOk ? 25 : Math.round((dur / 2.0) * 25);

    let ss = 0;
    for (let i = 0; i < d.length; i++) ss += d[i] * d[i];
    const rms = Math.sqrt(ss / d.length);
    const rmsOk = rms > 0.01 && rms < 0.95;
    const rmsSc = rmsOk ? 30 : (rms <= 0.01 ? Math.round((rms / 0.01) * 30) : 15);

    let clip = 0;
    for (let i = 0; i < d.length; i++) if (Math.abs(d[i]) >= 0.99) clip++;
    const clipR = clip / d.length;
    const clipOk = clipR < 0.01;
    const clipSc = clipOk ? 25 : Math.max(0, Math.round((1 - clipR / 0.05) * 25));

    // Compare the first 100 ms (assumed near-silent lead-in) against the
    // whole clip to approximate signal-to-noise.
    const noiseN = Math.min(Math.floor(sr * 0.1), d.length);
    let noiseS = 0;
    for (let i = 0; i < noiseN; i++) noiseS += d[i] * d[i];
    const nP = (noiseS / noiseN) || 1e-4;
    const sP = (ss / d.length) || 1e-4;
    const snr = 10 * Math.log10(sP / nP);
    const snrOk = snr > 10;
    const snrSc = snrOk ? 20 : Math.max(0, Math.round((snr / 10) * 20));

    const total = Math.min(100, durSc + rmsSc + clipSc + snrSc);
    S.scores[side] = total;

    setScore(side, total, [
      { l: `Dur ${dur.toFixed(1)}s`,          ok: durOk },
      { l: `Vol ${(rms * 100).toFixed(0)}%`,  ok: rmsOk },
      { l: `Clip ${(clipR * 100).toFixed(1)}%`, ok: clipOk },
      { l: `SNR ${snr.toFixed(0)}dB`,         ok: snrOk },
    ]);

    const bothGraded = S.scores.B !== null && S.scores.T !== null;
    if (bothGraded) {
      const pass = S.scores.B >= CONFIG.minScore && S.scores.T >= CONFIG.minScore;
      $('warnQuality').classList.toggle('show', !pass);
    }
  }

  function setScore(side, total, metrics) {
    const score = $('score' + side), bar = $('bar' + side), box = $('metrics' + side);
    if (total === null) {
      score.textContent = '—';
      score.className = 'conf-score';
      bar.style.width = '0%';
      bar.className = 'prog-bar';
      box.innerHTML = '';
      return;
    }
    const pass = total >= CONFIG.minScore;
    score.textContent = total + '%';
    score.className = 'conf-score ' + (pass ? 'pass' : 'fail');
    bar.style.width = total + '%';
    bar.className = 'prog-bar ' + (pass ? 'pass' : 'fail');
    box.innerHTML = '';
    metrics.forEach(m => {
      const span = document.createElement('span');
      span.className = 'cm ' + (m.ok ? 'ok' : 'bad');
      span.textContent = m.l;
      box.appendChild(span);
    });
  }

  // ── Waveform ────────────────────────────────────────────────────────────────
  /** Peak envelope, drawn on a canvas. Rendering this ourselves rather than
   *  pulling a CDN library keeps the app working with no uplink. */
  function computePeaks(samples, buckets) {
    const peaks = new Float32Array(buckets);
    const step = Math.max(1, Math.floor(samples.length / buckets));
    for (let b = 0; b < buckets; b++) {
      const start = b * step;
      const end = Math.min(samples.length, start + step);
      let peak = 0;
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(samples[i]));
      peaks[b] = peak;
    }
    return peaks;
  }

  function drawWave(side, progress) {
    const rec = S.rec[side];
    const canvas = $('wave' + side);
    if (!rec || !canvas) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 240;
    const cssH = canvas.clientHeight || 48;
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const barW = 2, gap = 1;
    const buckets = Math.max(8, Math.floor(cssW / (barW + gap)));
    const source = S.useClean ? rec.cleanedSamples : rec.samples;
    const peaks = computePeaks(source, buckets);

    let max = 0;
    for (let i = 0; i < peaks.length; i++) max = Math.max(max, peaks[i]);
    const norm = max > 0 ? 1 / max : 1;
    const played = progress === undefined ? 0 : progress;

    for (let i = 0; i < buckets; i++) {
      const h = Math.max(2, peaks[i] * norm * (cssH - 6));
      const x = i * (barW + gap) + 1;
      const y = (cssH - h) / 2;
      ctx.fillStyle = (i / buckets) <= played ? '#f5a623' : '#2a4870';
      ctx.fillRect(x, y, barW, h);
    }
  }

  function setupPlayer(side) {
    const btn = $('play' + side);
    btn.addEventListener('click', () => {
      const rec = S.rec[side];
      if (!rec) return;

      let audio = S.audio[side];
      const wanted = S.useClean ? rec.cleaned : rec.raw;

      if (audio && audio._blob === wanted && !audio.paused) {
        audio.pause();
        btn.textContent = '▶';
        return;
      }

      if (!audio || audio._blob !== wanted) {
        if (audio) { audio.pause(); URL.revokeObjectURL(audio.src); }
        audio = new Audio(URL.createObjectURL(wanted));
        audio._blob = wanted;
        audio.addEventListener('timeupdate', () => {
          if (audio.duration) drawWave(side, audio.currentTime / audio.duration);
        });
        audio.addEventListener('ended', () => { btn.textContent = '▶'; drawWave(side, 0); });
        S.audio[side] = audio;
      }

      audio.play().then(() => { btn.textContent = '❚❚'; }).catch(() => {});
    });
  }

  function reRecord(side) {
    stopRec(side);
    if (S.audio[side]) { S.audio[side].pause(); URL.revokeObjectURL(S.audio[side].src); S.audio[side] = null; }
    S.rec[side] = null;
    S.scores[side] = null;

    $('player' + side).classList.remove('show');
    $('rerec' + side).classList.remove('show');
    $('check' + side).classList.remove('show');
    $('timer' + side).textContent = '00:00';
    $('play' + side).textContent = '▶';
    setScore(side, null, []);
    clearAlert('err' + side);

    if (side === 'T') {
      $('trans-text').value = '';
      $('tstatus').textContent = 'Waiting for Telugu audio…';
    }
    $('warnQuality').classList.remove('show');
    updateSubmit();
  }

  // ── Transcription ───────────────────────────────────────────────────────────
  function selectSTT(engine) {
    S.stt = engine;
    $('chipSarvam').classList.toggle('on', engine === 'sarvam');
    $('chipGroq').classList.toggle('on', engine === 'groq');
  }

  async function transcribe() {
    const rec = S.rec.T;
    if (!rec) return;
    clearAlert('errTrans');

    if (!S.engines.sarvam && !S.engines.groq) {
      $('tstatus').textContent = 'No STT engine configured — type the transcription manually.';
      return;
    }

    $('tstatus').textContent = S.stt === 'sarvam'
      ? 'Transcribing with Sarvam Saarika (te-IN)…'
      : 'Transcribing with Groq Whisper (te)…';
    $('tspinner').classList.add('show');

    try {
      const fd = new FormData();
      // Send the cleaned audio — that is the point of filtering first.
      fd.append('file', rec.cleaned, 'audio.wav');
      fd.append('engine', S.stt);

      const r = await fetch(CONFIG.serverUrl + '/api/stt', { method: 'POST', body: fd });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Server returned ${r.status}`);

      $('trans-text').value = data.transcript || '';
      $('tstatus').textContent = data.transcript
        ? '✓ Done — edit if needed'
        : 'No speech detected — type it manually';
    } catch (err) {
      showAlert('errTrans', `Transcription failed: ${err.message}\nType the transcription manually.`, 'err');
      $('tstatus').textContent = 'Transcription failed — enter manually';
    } finally {
      $('tspinner').classList.remove('show');
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  function updateSubmit() {
    const btn = $('btn-submit'), lbl = $('submitLbl'), icon = $('submitIcon');
    if (S.submitting) return;

    const bothDone = !!S.rec.B && !!S.rec.T;
    const bothPass = S.scores.B !== null && S.scores.T !== null &&
                     S.scores.B >= CONFIG.minScore && S.scores.T >= CONFIG.minScore;

    if (bothDone && bothPass) {
      btn.className = 'ready';
      btn.disabled = false;
      icon.textContent = '↑';
      lbl.textContent = 'Save Session';
    } else if (bothDone) {
      btn.className = '';
      btn.disabled = true;
      icon.textContent = '⚠';
      lbl.textContent = 'Quality Too Low';
    } else {
      btn.className = '';
      btn.disabled = true;
      icon.textContent = '⊘';
      lbl.textContent = 'Awaiting Recordings';
    }
  }

  async function handleSubmit() {
    clearAlert('errSubmit');
    clearAlert('errSave');
    $('success-panel').classList.remove('show');

    const m = updateMeta();
    if (m.spk === 'SPK???' || m.lttr === '?') {
      showAlert('errSubmit', 'Fill in the session metadata before saving.', 'err');
      $('card-meta').classList.remove('collapsed');
      return;
    }
    if (!S.rec.B || !S.rec.T) {
      showAlert('errSubmit', 'Both recordings are required.', 'err');
      return;
    }

    const btn = $('btn-submit');
    S.submitting = true;
    btn.className = 'uploading';
    btn.disabled = true;
    $('submitLbl').textContent = 'Saving…';
    $('submitIcon').textContent = '↻';

    const record = {
      folder: m.folder,
      transcript: $('trans-text').value,
      names: m.names,
      blobs: {
        banjara:    S.rec.B.cleaned,
        telugu:     S.rec.T.cleaned,
        banjaraRaw: S.rec.B.raw,
        teluguRaw:  S.rec.T.raw,
      },
      meta: {
        speaker: m.spk,
        letter: m.lttr,
        segment: m.seg,
        session: m.sess,
        capturedAt: new Date().toISOString(),
        sampleRate: S.rec.T.sampleRate,
        durations: { banjara: S.rec.B.duration, telugu: S.rec.T.duration },
        scores: { banjara: S.scores.B, telugu: S.scores.T },
        filter: SolarisDSP.DEFAULTS,
        client: navigator.userAgent,
      },
    };

    try {
      const res = await SolarisStore.save(record);
      S.submitting = false;

      if (res.queued) {
        btn.className = 'done';
        $('submitLbl').textContent = 'Queued Offline';
        $('submitIcon').textContent = '⏳';
        showAlert('errSave',
          `Saved on this device and queued for upload.\nReason: ${res.reason}\nIt will upload when the server is reachable.`,
          'warn');
      } else {
        btn.className = 'done';
        $('submitLbl').textContent = 'Saved ✓';
        $('submitIcon').textContent = '✓';
        $('sfiles').innerHTML = '';
        (res.files || []).forEach(f => {
          const div = document.createElement('div');
          div.className = 'sfile';
          div.textContent = f;
          $('sfiles').appendChild(div);
        });
        $('upload-note').textContent = `Saved to: ${res.savedTo}`;
        $('success-panel').classList.add('show');
      }

      refreshQueue();
      setTimeout(() => resetForm(), 3000);
    } catch (err) {
      S.submitting = false;
      console.error('[SUBMIT]', err);
      showAlert('errSave', `Save failed: ${err.message}`, 'err');
      btn.className = 'ready';
      btn.disabled = false;
      $('submitLbl').textContent = 'Retry Save';
      $('submitIcon').textContent = '↑';
    }
  }

  function resetForm() {
    ['B', 'T'].forEach(reRecord);
    $('trans-text').value = '';
    $('tstatus').textContent = 'Waiting for Telugu audio…';
    $('success-panel').classList.remove('show');
    clearAlert('errSubmit');
    clearAlert('errSave');
    clearAlert('errTrans');

    // Speaker and session persist across takes; the letter is what changes,
    // so advance nothing and let the operator pick the next one.
    updateMeta();
    updateSubmit();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // ── Offline queue ───────────────────────────────────────────────────────────
  async function refreshQueue() {
    const n = await SolarisStore.pending();
    $('queueCount').textContent = n;
    $('queuePill').classList.toggle('show', n > 0);
  }

  async function flushQueue() {
    const pill = $('queuePill');
    pill.disabled = true;
    try {
      const res = await SolarisStore.flush();
      if (res.sent > 0) showAlert('errSave', `Uploaded ${res.sent} queued session(s).`, 'ok');
      else if (res.remaining > 0) showAlert('errSave', 'Still offline — the queue is intact and will retry.', 'warn');
    } finally {
      pill.disabled = false;
      refreshQueue();
    }
  }

  // ── Alerts ──────────────────────────────────────────────────────────────────
  function showAlert(id, msg, type) {
    const el = $(id);
    if (!el) return;
    el.textContent = msg;
    el.className = `alert ${type} show`;
  }

  function clearAlert(id) {
    const el = $(id);
    if (!el) return;
    el.textContent = '';
    el.className = 'alert';
  }

  function setBusy(side, msg) {
    showAlert('err' + side, msg, 'warn');
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function init() {
    SolarisStore.configure({ baseUrl: CONFIG.serverUrl });

    const sel = $('tel-letter');
    LETTERS.forEach(l => {
      const o = document.createElement('option');
      o.value = o.textContent = l;
      sel.appendChild(o);
    });

    $('spk-id').value     = loadMeta('spk');
    $('tel-letter').value = loadMeta('letter');
    $('seg-type').value   = loadMeta('seg');
    $('sess-num').value   = loadMeta('sess');

    const bind = (id, key) => $(id).addEventListener('input', (e) => {
      saveMeta(key, e.target.value);
      updateMeta();
    });
    bind('spk-id', 'spk');
    bind('sess-num', 'sess');
    $('tel-letter').addEventListener('change', (e) => { saveMeta('letter', e.target.value); updateMeta(); });
    $('seg-type').addEventListener('change', (e) => { saveMeta('seg', e.target.value); updateMeta(); });

    const metaCard = $('card-meta');
    const toggleMeta = () => {
      const collapsed = metaCard.classList.toggle('collapsed');
      $('metaToggle').setAttribute('aria-expanded', String(!collapsed));
    };
    $('metaToggle').addEventListener('click', toggleMeta);
    $('metaToggle').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleMeta(); }
    });

    ['B', 'T'].forEach(side => {
      $('btn' + side).addEventListener('click', () => toggleRec(side));
      $('rerec' + side).addEventListener('click', () => reRecord(side));
      setupPlayer(side);
    });

    // Cleaned/Original only changes what you hear and see; both versions are
    // uploaded either way.
    const setVersion = (clean) => {
      S.useClean = clean;
      $('segClean').classList.toggle('on', clean);
      $('segRaw').classList.toggle('on', !clean);
      ['B', 'T'].forEach(side => {
        if (!S.rec[side]) return;
        if (S.audio[side]) {
          S.audio[side].pause();
          URL.revokeObjectURL(S.audio[side].src);
          S.audio[side] = null;
          $('play' + side).textContent = '▶';
        }
        drawWave(side, 0);
      });
    };
    $('segClean').addEventListener('click', () => setVersion(true));
    $('segRaw').addEventListener('click', () => setVersion(false));

    $('chipSarvam').addEventListener('click', () => selectSTT('sarvam'));
    $('chipGroq').addEventListener('click', () => selectSTT('groq'));
    $('btn-submit').addEventListener('click', handleSubmit);
    $('queuePill').addEventListener('click', flushQueue);

    selectSTT(CONFIG.activeSTT);
    updateMeta();
    updateSubmit();
    checkServer();

    // Redraw waveforms on rotation, since the canvas is sized in device pixels.
    let resizeTimer;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => ['B', 'T'].forEach(s => S.rec[s] && drawWave(s)), 150);
    });

    // Coming back from a locked screen: re-check the server and re-arm the
    // wake lock, which the platform drops on backgrounding.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      checkServer();
      if (S.isRec.B || S.isRec.T) requestWakeLock();
    });

    window.addEventListener('online', () => { checkServer(); flushQueue(); });

    // Losing an in-progress take to a stray back-swipe is unrecoverable.
    window.addEventListener('beforeunload', (e) => {
      if (S.isRec.B || S.isRec.T || S.rec.B || S.rec.T) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    if ('serviceWorker' in navigator && location.protocol === 'https:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
