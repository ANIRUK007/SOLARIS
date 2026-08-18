/**
 * play.js — prompt-driven capture session.
 *
 * The loop: a Telugu word is shown, the speaker says it in Banjara, the take
 * is filtered and graded on the device, and a verdict comes back immediately.
 * Good takes are saved and the session moves on; poor ones are re-recorded on
 * the spot, which is the only moment the speaker is still in the room.
 *
 * The transcript needs no speech-to-text here: the Telugu prompt *is* the
 * text, so the pairing is known before the speaker opens their mouth.
 */
(function () {
  'use strict';

  const CONFIG = {
    serverUrl: location.protocol.startsWith('http') ? location.origin : 'http://127.0.0.1:3001',
    targetSampleRate: 16000,
    minScore: 50,
    minDuration: 0.6,
    baseXp: 10,
    packs: ['starter.json'],
  };

  const $ = (id) => document.getElementById(id);

  const G = {
    pack: null,
    queue: [],
    index: 0,
    phase: 'bnj',            // 'bnj' or 'tel' when paired audio is enabled
    withTelugu: false,
    speaker: 'SPK001',
    session: '01',

    takes: { bnj: null, tel: null },
    results: [],             // one entry per prompt: recorded | skipped
    xp: 0,
    streak: 0,
    bestStreak: 0,
    startedAt: 0,

    isRec: false,
    starting: false,
    mr: null,
    stream: null,
    recStart: 0,
    ticker: null,
    meter: null,
    wakeLock: null,
    audio: null,
    busy: false,
  };

  let audioCtx = null;

  function getAudioContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('Web Audio is not supported here.');
    if (!audioCtx || audioCtx.state === 'closed') audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  // ── Feedback: haptics and short tones ───────────────────────────────────────
  const buzz = (pattern) => { try { navigator.vibrate && navigator.vibrate(pattern); } catch {} };

  /** Two-note blip. Synthesised rather than loaded, so there is no audio file
   *  to fetch on a phone with no signal. */
  function blip(kind) {
    try {
      const ctx = getAudioContext();
      const now = ctx.currentTime;
      const notes = kind === 'good' ? [660, 990] : kind === 'bad' ? [300, 200] : [520, 520];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + i * 0.09);
        gain.gain.exponentialRampToValueAtTime(0.14, now + i * 0.09 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.16);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + i * 0.09);
        osc.stop(now + i * 0.09 + 0.18);
      });
    } catch { /* audio feedback is optional */ }
  }

  // ── Screens ─────────────────────────────────────────────────────────────────
  function show(screen) {
    ['setup', 'play', 'done'].forEach(s => { $('screen-' + s).hidden = s !== screen; });
  }

  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  // ── Setup ───────────────────────────────────────────────────────────────────
  async function loadPacks() {
    const sel = $('setup-pack');
    sel.innerHTML = '';
    for (const file of CONFIG.packs) {
      try {
        const r = await fetch('packs/' + file, { cache: 'no-store' });
        if (!r.ok) continue;
        const pack = await r.json();
        const o = document.createElement('option');
        o.value = file;
        o.textContent = `${pack.name} · ${pack.items.length} words`;
        o._pack = pack;
        sel.appendChild(o);
      } catch { /* a missing pack should not block the others */ }
    }
    if (!sel.options.length) {
      showError('setupErr', 'No word sets could be loaded. Check that public/packs/ is present.');
      $('btnStart').disabled = true;
    }
  }

  async function checkServer() {
    const pill = $('srvState'), lbl = $('srvLbl');
    try {
      const r = await fetch(CONFIG.serverUrl + '/health', { cache: 'no-store' });
      const j = await r.json();
      if (!r.ok || j.status !== 'ok') throw new Error();
      pill.className = 'srv-state ok';
      lbl.textContent = 'server online';
    } catch {
      pill.className = 'srv-state err';
      lbl.textContent = 'offline — takes will queue on this device';
    }
  }

  function showError(id, msg) {
    const el = $(id);
    el.textContent = msg;
    el.hidden = false;
  }
  const clearError = (id) => { $(id).hidden = true; };

  function startSession() {
    clearError('setupErr');

    const speaker = $('setup-speaker').value.trim().toUpperCase();
    if (!speaker) {
      showError('setupErr', 'Enter a speaker ID before starting.');
      return;
    }

    const opt = $('setup-pack').selectedOptions[0];
    if (!opt || !opt._pack) {
      showError('setupErr', 'Pick a word set.');
      return;
    }

    G.pack = opt._pack;
    G.queue = opt._pack.items.slice();
    G.index = 0;
    G.phase = 'bnj';
    G.speaker = speaker;
    G.session = String($('setup-session').value || '1').padStart(2, '0');
    G.withTelugu = $('toggleTelugu').classList.contains('on');
    G.takes = { bnj: null, tel: null };
    G.results = [];
    G.xp = 0;
    G.streak = 0;
    G.bestStreak = 0;
    G.startedAt = Date.now();

    localStorage.setItem('solaris_spk', speaker);
    localStorage.setItem('solaris_sess', G.session);

    buildSegbar();
    show('play');
    renderPrompt(false);

    // First touch of the AudioContext has to happen inside a gesture on iOS,
    // and pressing Start is the last guaranteed one before recording.
    try { getAudioContext(); } catch {}
  }

  // ── Progress bar ────────────────────────────────────────────────────────────
  function buildSegbar() {
    const bar = $('segbar');
    bar.innerHTML = '';
    G.queue.forEach(() => {
      const s = document.createElement('span');
      s.className = 'seg';
      bar.appendChild(s);
    });
    updateSegbar();
  }

  function updateSegbar() {
    const segs = $('segbar').children;
    for (let i = 0; i < segs.length; i++) {
      const res = G.results[i];
      segs[i].className = 'seg' +
        (res === 'recorded' ? ' done' : res === 'skipped' ? ' skipped' : i === G.index ? ' current' : '');
    }
  }

  // ── Prompt rendering ────────────────────────────────────────────────────────
  function currentItem() { return G.queue[G.index]; }

  function renderPrompt(animate) {
    const item = currentItem();
    if (!item) return finish();

    const card = $('promptCard');
    const paint = () => {
      $('promptCat').textContent = item.segment || 'word';
      $('promptWord').textContent = item.te;
      $('promptTranslit').textContent = item.translit || '';
      $('promptEn').textContent = item.en ? `“${item.en}”` : '';

      const teluguPhase = G.phase === 'tel';
      $('instruction').innerHTML = teluguPhase
        ? 'Now say it in <span class="lang" style="color:var(--blue)">Telugu</span>'
        : 'Say this in <span class="lang">Banjara</span>';

      $('btnSpeak').hidden = !hasTeluguVoice();
      $('recLabel').textContent = 'Tap to record';
      $('btnRecord').classList.remove('recording');
      $('btnSkip').hidden = teluguPhase;   // the Banjara answer is what can be absent
      $('recTimer').textContent = '00:00';
      $('meterBar').style.width = '0%';
      $('meterWrap').classList.remove('show');
      clearError('playErr');

      card.classList.remove('leave');
      card.classList.add('enter');
      setTimeout(() => card.classList.remove('enter'), 400);
    };

    if (animate) {
      card.classList.add('leave');
      setTimeout(paint, 200);
    } else {
      paint();
    }
    updateSegbar();
  }

  // ── Telugu playback of the prompt ───────────────────────────────────────────
  function teluguVoice() {
    if (!('speechSynthesis' in window)) return null;
    const voices = speechSynthesis.getVoices() || [];
    return voices.find(v => /^te([-_]|$)/i.test(v.lang)) || null;
  }
  const hasTeluguVoice = () => !!teluguVoice();

  function speakPrompt() {
    const voice = teluguVoice();
    if (!voice) return;
    const u = new SpeechSynthesisUtterance(currentItem().te);
    u.voice = voice;
    u.lang = voice.lang;
    u.rate = 0.85;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  }

  // ── Recording ───────────────────────────────────────────────────────────────
  function pickMimeType() {
    if (typeof MediaRecorder === 'undefined') return null;
    const candidates = [
      'audio/webm;codecs=opus', 'audio/webm',
      'audio/mp4;codecs=mp4a.40.2', 'audio/mp4',
      'audio/aac', 'audio/ogg;codecs=opus',
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }

  async function toggleRecord() {
    // getUserMedia takes a moment to resolve, and an impatient second tap in
    // that window would open a second stream that nothing ever stops.
    if (G.busy || G.starting) return;
    if (G.isRec) stopRecording();
    else await startRecording();
  }

  async function startRecording() {
    clearError('playErr');
    G.starting = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('playErr', micMessage());
      G.starting = false;
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      showError('playErr', err && err.name === 'NotAllowedError'
        ? 'Microphone permission denied. Allow it in the browser settings, then tap record again.'
        : micMessage());
      G.starting = false;
      return;
    }

    const mime = pickMimeType();
    let mr;
    try {
      mr = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    } catch {
      stream.getTracks().forEach(t => t.stop());
      showError('playErr', 'This browser cannot record audio. Try Chrome or Safari.');
      G.starting = false;
      return;
    }

    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    mr.onstop = async () => {
      stopMeter();
      stream.getTracks().forEach(t => t.stop());
      G.stream = null;
      await processTake(new Blob(chunks, { type: mr.mimeType || 'audio/webm' }));
    };

    mr.start(200);
    G.mr = mr;
    G.stream = stream;
    G.isRec = true;
    G.starting = false;
    G.recStart = Date.now();

    $('btnRecord').classList.add('recording');
    $('recLabel').textContent = 'Tap to stop';
    $('meterWrap').classList.add('show');
    buzz(18);
    requestWakeLock();
    startMeter(stream);

    // Wall clock rather than a tick count: phones throttle timers aggressively
    // once the screen dims, and a counted interval drifts.
    G.ticker = setInterval(() => {
      const secs = Math.floor((Date.now() - G.recStart) / 1000);
      $('recTimer').textContent =
        `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`;
    }, 200);
  }

  function micMessage() {
    if (!window.isSecureContext) {
      return 'The microphone is blocked because this page is not on a secure connection.\n' +
             'Open it over https://, or use localhost.';
    }
    return 'No microphone is available on this device.';
  }

  function stopRecording() {
    if (!G.isRec) return;
    G.isRec = false;
    clearInterval(G.ticker);
    try { G.mr.stop(); } catch {}
    $('btnRecord').classList.remove('recording');
    $('recLabel').textContent = 'Processing…';
    releaseWakeLock();
    buzz(12);
  }

  async function requestWakeLock() {
    try { if ('wakeLock' in navigator) G.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
  }
  function releaseWakeLock() {
    if (G.wakeLock) { G.wakeLock.release().catch(() => {}); G.wakeLock = null; }
  }

  function startMeter(stream) {
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
        $('meterBar').style.width = Math.min(100, peak * 145) + '%';
        raf = requestAnimationFrame(tick);
      };
      tick();
      G.meter = () => { cancelAnimationFrame(raf); try { src.disconnect(); } catch {} };
    } catch {}
  }
  function stopMeter() {
    if (G.meter) { G.meter(); G.meter = null; }
    $('meterBar').style.width = '0%';
  }

  // ── Processing and grading ──────────────────────────────────────────────────
  async function processTake(blob) {
    G.busy = true;
    try {
      const { samples, sampleRate } = await decodeToMono16k(blob);
      if (!samples.length) throw new Error('The recording came back empty.');

      const { cleaned } = SolarisDSP.denoise(samples);
      const take = {
        raw: new Blob([SolarisDSP.encodeWav(samples, sampleRate)], { type: 'audio/wav' }),
        cleaned: new Blob([SolarisDSP.encodeWav(cleaned, sampleRate)], { type: 'audio/wav' }),
        samples, cleanedSamples: cleaned, sampleRate,
        duration: samples.length / sampleRate,
      };
      take.grade = grade(take);
      G.takes[G.phase] = take;
      verdict(take);
    } catch (err) {
      console.error('[TAKE]', err);
      showError('playErr', `Could not process that take: ${err.message}`);
      $('recLabel').textContent = 'Tap to record';
    } finally {
      G.busy = false;
    }
  }

  async function decodeToMono16k(blob) {
    const ctx = getAudioContext();
    const ab = await blob.arrayBuffer();

    const decoded = await new Promise((resolve, reject) => {
      // Older Safari implements only the callback form.
      const p = ctx.decodeAudioData(ab, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });

    const target = CONFIG.targetSampleRate;
    if (Math.abs(decoded.sampleRate - target) < 1) {
      return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
    }

    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    try {
      const off = new OAC(1, Math.ceil(decoded.duration * target), target);
      const src = off.createBufferSource();
      src.buffer = decoded;
      src.connect(off.destination);
      src.start();
      const rendered = await off.startRendering();
      return { samples: rendered.getChannelData(0), sampleRate: target };
    } catch {
      return { samples: decoded.getChannelData(0), sampleRate: decoded.sampleRate };
    }
  }

  /** Same scoring as the full interface, reported with a plain-language
   *  reason so a speaker who is not a sound engineer knows what to change. */
  function grade(take) {
    const d = take.cleanedSamples;
    const dur = take.duration;
    const sr = take.sampleRate;

    const durOk = dur >= CONFIG.minDuration;
    const durSc = durOk ? 25 : Math.round((dur / CONFIG.minDuration) * 25);

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

    // Noise floor from the 10th-percentile frame energy: a clip that starts on
    // silence would otherwise push the ratio to meaningless extremes.
    const frame = Math.max(1, Math.floor(sr * 0.02));
    const energies = [];
    for (let i = 0; i + frame <= d.length; i += frame) {
      let e = 0;
      for (let j = i; j < i + frame; j++) e += d[j] * d[j];
      energies.push(e / frame);
    }
    energies.sort((a, b) => a - b);
    const sP = (ss / d.length) || 1e-12;
    const nP = Math.max(energies.length ? energies[Math.floor(energies.length * 0.1)] : sP, 1e-9);
    const snr = Math.max(-20, Math.min(60, 10 * Math.log10(sP / nP)));
    const snrOk = snr > 10;
    const snrSc = snrOk ? 20 : Math.max(0, Math.round((snr / 10) * 20));

    let reason = null;
    if (!durOk)        reason = 'That was very short — hold the recording a moment longer.';
    else if (rms <= 0.01) reason = 'Almost nothing came through. Move closer to the microphone.';
    else if (!rmsOk)   reason = 'That was too loud and distorted. Pull back a little.';
    else if (!clipOk)  reason = 'The audio is clipping. Speak a little softer.';
    else if (!snrOk)   reason = 'Too much background noise around the voice.';

    return {
      score: Math.min(100, durSc + rmsSc + clipSc + snrSc),
      reason,
      metrics: [
        { l: `${dur.toFixed(1)}s`, ok: durOk },
        { l: `vol ${(rms * 100).toFixed(0)}%`, ok: rmsOk },
        { l: `clip ${(clipR * 100).toFixed(1)}%`, ok: clipOk },
        { l: `snr ${snr.toFixed(0)}dB`, ok: snrOk },
      ],
    };
  }

  // ── Verdict sheet ───────────────────────────────────────────────────────────
  function verdict(take) {
    const g = take.grade;
    const passed = g.score >= CONFIG.minScore;
    const sheet = $('sheet');

    sheet.className = 'sheet ' + (passed ? 'good' : 'bad');
    $('sheetIcon').textContent = passed ? '✓' : '↺';
    $('sheetTitle').textContent = passed ? pickPraise() : 'Let us try that again';
    $('sheetSub').textContent = passed
      ? (G.phase === 'tel' ? 'Telugu take captured.' : 'Banjara take captured.')
      : (g.reason || 'The recording did not pass the quality check.');

    $('sheetMetrics').innerHTML = '';
    g.metrics.forEach(m => {
      const el = document.createElement('span');
      el.className = 'metric' + (m.ok ? '' : ' bad');
      el.textContent = m.l;
      $('sheetMetrics').appendChild(el);
    });

    const xp = passed ? CONFIG.baseXp + Math.round(g.score / 10) + Math.min(G.streak, 5) : 0;
    take.xp = xp;
    $('sheetXp').hidden = !passed;
    $('sheetXp').textContent = `+${xp} XP`;

    $('btnContinue').hidden = !passed;
    $('btnRetry').textContent = passed ? 'Redo' : 'Record again';
    $('btnRetry').className = passed ? 'btn btn-ghost' : 'btn btn-primary';

    sheet.classList.add('show');
    blip(passed ? 'good' : 'bad');
    buzz(passed ? [14, 40, 14] : [90]);
  }

  const PRAISE = ['Nice!', 'Got it!', 'Clean take!', 'Well done!', 'Perfect!', 'Recorded!'];
  const pickPraise = () => PRAISE[Math.floor(Math.random() * PRAISE.length)];

  function hideSheet() { $('sheet').classList.remove('show'); }

  function replayTake() {
    const take = G.takes[G.phase];
    if (!take) return;
    if (G.audio) { G.audio.pause(); URL.revokeObjectURL(G.audio.src); }
    G.audio = new Audio(URL.createObjectURL(take.cleaned));
    G.audio.play().catch(() => {});
  }

  function retryTake() {
    G.takes[G.phase] = null;
    hideSheet();
    $('recLabel').textContent = 'Tap to record';
    $('recTimer').textContent = '00:00';
    $('meterWrap').classList.remove('show');
  }

  /** Continue: either move to the Telugu half of the same word, or save. */
  async function continueFlow() {
    const take = G.takes[G.phase];
    if (!take) return;

    G.xp += take.xp || 0;
    hideSheet();

    if (G.phase === 'bnj' && G.withTelugu) {
      G.phase = 'tel';
      renderPrompt(false);
      return;
    }

    await saveCurrent();
  }

  // ── Saving ──────────────────────────────────────────────────────────────────
  async function saveCurrent() {
    const item = currentItem();
    const bnj = G.takes.bnj;
    const tel = G.takes.tel;
    if (!bnj) return;

    const base = `${G.speaker}_${item.id}`;
    const record = {
      folder: `speakers/${G.speaker}/sessions/session_${G.session}/${item.id}`,
      // No speech-to-text needed: the prompt is the transcript.
      transcript: item.te,
      names: {
        banjara:    `${base}_banjara.wav`,
        telugu:     `${base}_telugu.wav`,
        transcript: `${base}_telugu.txt`,
        banjaraRaw: `${base}_banjara_raw.wav`,
        teluguRaw:  `${base}_telugu_raw.wav`,
      },
      blobs: {
        banjara:    bnj.cleaned,
        banjaraRaw: bnj.raw,
        ...(tel ? { telugu: tel.cleaned, teluguRaw: tel.raw } : {}),
      },
      meta: {
        speaker: G.speaker,
        session: G.session,
        pack: G.pack.id,
        prompt: { id: item.id, telugu: item.te, translit: item.translit, english: item.en, segment: item.segment },
        capturedAt: new Date().toISOString(),
        sampleRate: bnj.sampleRate,
        durations: { banjara: bnj.duration, telugu: tel ? tel.duration : null },
        scores: { banjara: bnj.grade.score, telugu: tel ? tel.grade.score : null },
        filter: SolarisDSP.DEFAULTS,
        client: navigator.userAgent,
      },
    };

    G.busy = true;
    try {
      const res = await SolarisStore.save(record);
      if (res.queued) toast('Saved on this device — will upload later');
    } catch (err) {
      console.error('[SAVE]', err);
      toast('Save failed: ' + err.message, 3600);
    } finally {
      G.busy = false;
    }

    G.streak++;
    G.bestStreak = Math.max(G.bestStreak, G.streak);
    $('streakVal').textContent = G.streak;
    $('streakBox').classList.add('pulse');
    setTimeout(() => $('streakBox').classList.remove('pulse'), 500);

    G.results[G.index] = 'recorded';
    advance();
  }

  function skipWord() {
    if (G.busy || G.isRec) return;
    // A word with no Banjara equivalent is a finding, not a gap — it is kept
    // in the session log rather than silently dropped.
    G.results[G.index] = 'skipped';
    G.streak = 0;
    $('streakVal').textContent = '0';
    toast('Marked as “no Banjara word”');
    hideSheet();
    advance();
  }

  function advance() {
    G.takes = { bnj: null, tel: null };
    G.phase = 'bnj';
    G.index++;
    if (G.index >= G.queue.length) finish();
    else renderPrompt(true);
  }

  // ── Finish ──────────────────────────────────────────────────────────────────
  async function finish() {
    hideSheet();
    releaseWakeLock();

    const recorded = G.results.filter(r => r === 'recorded').length;
    const skipped  = G.results.filter(r => r === 'skipped').length;
    const minutes  = Math.max(1, Math.round((Date.now() - G.startedAt) / 60000));

    $('statXp').textContent = G.xp;
    $('statRecorded').textContent = `${recorded}/${G.queue.length}`;
    $('statStreak').textContent = G.bestStreak;
    $('statTime').textContent = `${minutes}m`;

    $('doneTitle').textContent = recorded === G.queue.length ? 'Perfect session!' : 'Session complete';
    $('doneSub').textContent = skipped
      ? `${recorded} recorded, ${skipped} marked as having no Banjara word.`
      : 'Every word recorded and saved.';

    show('done');
    confetti();
    blip('good');
    buzz([20, 60, 20, 60, 40]);

    await writeSessionLog(recorded, skipped);

    const pending = await SolarisStore.pending();
    const note = $('queueNote');
    note.hidden = pending === 0;
    if (pending) note.textContent = `${pending} session(s) waiting to upload. They will send automatically when the server is reachable.`;
  }

  /** Records the order, the skips and the timing — the parts of a session that
   *  the audio files alone cannot show. */
  async function writeSessionLog(recorded, skipped) {
    const body = {
      folder: `speakers/${G.speaker}/sessions/session_${G.session}`,
      name: `session_${G.session}_log.json`,
      log: {
        speaker: G.speaker,
        session: G.session,
        pack: { id: G.pack.id, name: G.pack.name },
        withTelugu: G.withTelugu,
        startedAt: new Date(G.startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        xp: G.xp,
        bestStreak: G.bestStreak,
        totals: { prompts: G.queue.length, recorded, skipped },
        items: G.queue.map((item, i) => ({
          id: item.id,
          telugu: item.te,
          english: item.en,
          segment: item.segment,
          outcome: G.results[i] || 'not reached',
        })),
      },
    };

    try {
      await fetch(CONFIG.serverUrl + '/api/session-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // The per-word saves already carry the important data; the log is extra.
    }
  }

  function confetti() {
    const colors = ['#f5a623', '#2dd4bf', '#46d160', '#60a5fa', '#a78bfa', '#ff4d4d'];
    const layer = document.createElement('div');
    layer.className = 'confetti';
    for (let i = 0; i < 70; i++) {
      const bit = document.createElement('span');
      bit.style.left = Math.random() * 100 + 'vw';
      bit.style.background = colors[i % colors.length];
      bit.style.animationDuration = (1.9 + Math.random() * 1.5) + 's';
      bit.style.animationDelay = (Math.random() * 0.5) + 's';
      bit.style.transform = `rotate(${Math.random() * 360}deg)`;
      layer.appendChild(bit);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4200);
  }

  function quit() {
    if (G.isRec) stopRecording();
    if (G.index > 0 && !confirm('End this session? Words already recorded are saved.')) return;
    finish();
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function init() {
    SolarisStore.configure({ baseUrl: CONFIG.serverUrl });

    $('setup-speaker').value = localStorage.getItem('solaris_spk') || 'SPK001';
    $('setup-session').value = Number(localStorage.getItem('solaris_sess') || 1);

    const toggle = $('toggleTelugu');
    const flip = () => {
      const on = toggle.classList.toggle('on');
      toggle.setAttribute('aria-checked', String(on));
    };
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
    });

    $('btnStart').addEventListener('click', startSession);
    $('btnRecord').addEventListener('click', toggleRecord);
    $('btnSkip').addEventListener('click', skipWord);
    $('btnSpeak').addEventListener('click', speakPrompt);
    $('btnReplay').addEventListener('click', replayTake);
    $('btnRetry').addEventListener('click', retryTake);
    $('btnContinue').addEventListener('click', continueFlow);
    $('btnQuit').addEventListener('click', quit);
    $('btnAgain').addEventListener('click', () => {
      $('setup-session').value = Number(G.session) + 1;
      startSession();
    });
    $('btnHome').addEventListener('click', () => show('setup'));

    // Voice list loads asynchronously in most browsers.
    if ('speechSynthesis' in window) {
      speechSynthesis.onvoiceschanged = () => {
        if (!$('screen-play').hidden) $('btnSpeak').hidden = !hasTeluguVoice();
      };
    }

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && G.isRec) requestWakeLock();
    });

    window.addEventListener('online', () => { SolarisStore.flush().catch(() => {}); });

    window.addEventListener('beforeunload', (e) => {
      if (G.isRec || (G.index > 0 && !$('screen-play').hidden)) { e.preventDefault(); e.returnValue = ''; }
    });

    // Read-only handle for diagnosing a session from a phone with no devtools.
    window.__solarisGame = G;

    loadPacks();
    checkServer();
    show('setup');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
