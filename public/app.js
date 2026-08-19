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
    batchSize: 10,          // prompts handed out per sitting
    tilesPerSection: 5,     // tiles between one section band and the next
  };

  const $ = (id) => document.getElementById(id);
  const ico = (name, cls) => SolarisIcons.svg(name, cls);

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

    coverage: null,          // how covered the archive is overall
    doneSince: {},           // recorded this visit, before the next server read
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
    ['auth', 'portal', 'play', 'done'].forEach(s => { $('screen-' + s).hidden = s !== screen; });
    if (screen === 'portal') paintPortal();
  }

  function hideToast() {
    const el = $('toast');
    clearTimeout(el._t);
    el.classList.remove('show');
  }

  function toast(msg, ms) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), ms || 2200);
  }

  // ── Sign in ─────────────────────────────────────────────────────────────────
  let authMode = 'login';          // or 'register'

  function paintAuthMode() {
    const registering = authMode === 'register';
    $('authLede').textContent = registering
      ? 'Create an account to record.'
      : 'Sign in to record.';
    $('btnAuthSubmit').textContent = registering ? 'Create Account' : 'Sign In';
    $('btnAuthToggle').textContent = registering ? 'I already have an account' : 'Create an account instead';
    $('authNameRow').hidden = !registering;
    $('auth-pass').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    clearError('authErr');
  }

  async function submitAuth() {
    clearError('authErr');
    const username = $('auth-user').value.trim();
    const password = $('auth-pass').value;

    if (!username || !password) {
      showError('authErr', 'Enter a username and password.');
      return;
    }

    const btn = $('btnAuthSubmit');
    btn.disabled = true;
    btn.textContent = 'Working…';

    try {
      if (authMode === 'register') {
        await SolarisAuth.register(username, password, $('auth-name').value.trim() || username);
      } else {
        await SolarisAuth.login(username, password);
      }
      $('auth-pass').value = '';
      await loadPacks();          // now that there is a token to fetch with
      show('portal');
    } catch (err) {
      showError('authErr', err.message);
    } finally {
      btn.disabled = false;
      // Only restore the label. Calling paintAuthMode() here would clear the
      // error that was just shown, leaving a failed sign-in looking like
      // nothing happened at all.
      btn.textContent = authMode === 'register' ? 'Create Account' : 'Sign In';
    }
  }

  function signOut() {
    closeDrawer();
    SolarisAuth.logout();
    authMode = 'login';
    paintAuthMode();
    show('auth');
  }

  /**
   * Where to land on open. The app always starts behind the account screen —
   * every recording is attributed to somebody, so there is no anonymous way
   * in. The only choice is whether that screen offers sign-in or sign-up.
   */
  async function decideStartScreen() {
    if (SolarisAuth.isSignedIn) {
      await SolarisAuth.refresh();
      if (SolarisAuth.isSignedIn) {
        await loadPacks();
        show('portal');
        return;
      }
    }

    // With no accounts on the server yet, the first visitor is setting it up,
    // so offer sign-up rather than a sign-in they cannot satisfy.
    const hasAccounts = await SolarisAuth.serverRequiresAuth();
    authMode = hasAccounts ? 'login' : 'register';
    paintAuthMode();
    show('auth');
  }

  // ── Portal ──────────────────────────────────────────────────────────────────
  let packs = [];                      // the categories, with progress folded in
  let currentSet = null;               // the one the path is showing

  /** Which set to show a path for: the one last worked on, else the first with
   *  anything left to do. */
  function chooseSet() {
    if (!packs.length) return null;

    const remembered = localStorage.getItem('solaris_set');
    const kept = packs.find(p => p.id === remembered);
    if (kept && packDone(kept) < kept.count) return kept;

    return packs.find(p => packDone(p) > 0 && packDone(p) < p.count)
        || packs.find(p => packDone(p) < p.count)
        || packs[0];
  }

  function setCurrentSet(pack) {
    currentSet = pack;
    if (pack) localStorage.setItem('solaris_set', pack.id);
    paintUnit();
    paintPath();
  }

  function paintUnit() {
    if (!currentSet) return;
    $('unitIcon').innerHTML = ico(currentSet.icon || 'box');
    $('unitName').textContent = currentSet.name;
    $('unitCount').textContent = `${packDone(currentSet)}/${currentSet.count}`;
  }

  /**
   * One node per batch of ten words.
   *
   * A node is a checkpoint rather than a fixed lesson: the words in a batch are
   * drawn when it is opened, weighted toward whatever the archive has least of.
   * So node three means "the third ten words you record from this set", not a
   * particular ten.
   */
  function paintPath() {
    const path = $('path');
    path.innerHTML = '';
    if (!currentSet) return;

    const done = packDone(currentSet);
    const total = currentSet.count;
    const nodes = Math.ceil(total / CONFIG.batchSize);
    const finished = Math.floor(done / CONFIG.batchSize);

    for (let i = 0; i < nodes; i++) {
      // A hundred words is ten tiles in one unbroken column, which reads as a
      // scroll with no landmarks. Breaking it every five gives the map
      // chapters, and a place to see how far along the set you are.
      if (i % CONFIG.tilesPerSection === 0) {
        const sectionNo = Math.floor(i / CONFIG.tilesPerSection) + 1;
        const from = i * CONFIG.batchSize + 1;
        const to = Math.min((i + CONFIG.tilesPerSection) * CONFIG.batchSize, total);
        const sectionDone = Math.max(0, Math.min(done - i * CONFIG.batchSize,
          (to - from + 1)));

        const header = document.createElement('div');
        header.className = 'section-band' + (sectionDone >= (to - from + 1) ? ' done' : '');
        header.innerHTML = `
          <span class="band-no">Section ${sectionNo}</span>
          <span class="band-range">Words ${from}–${to}</span>
          <span class="band-count">${sectionDone}/${to - from + 1}</span>`;
        path.appendChild(header);
      }

      const row = document.createElement('div');
      // The offsets restart with each section, so every chapter has the same
      // shape rather than the trail drifting off one side.
      row.className = `node-row off-${i % CONFIG.tilesPerSection}`;

      const node = document.createElement('button');
      node.type = 'button';
      const state = i < finished ? 'done' : i === finished ? 'live' : 'ahead';
      node.className = `node ${state}`;

      const from = i * CONFIG.batchSize + 1;
      const to = Math.min((i + 1) * CONFIG.batchSize, total);

      node.innerHTML =
        (state === 'live' ? '<span class="node-flag">Start</span>' : '') +
        ico(state === 'done' ? 'check' : 'mic') +
        `<span class="node-num">${from}–${to}</span>`;

      node.setAttribute('aria-label',
        state === 'done' ? `Words ${from} to ${to}, recorded`
          : `Record words ${from} to ${to} of ${currentSet.name}`);

      node.addEventListener('click', () => openPack(currentSet, node));
      row.appendChild(node);
      path.appendChild(row);
    }

    if (done >= total) {
      const end = document.createElement('p');
      end.className = 'path-end';
      end.textContent = `Every word in ${currentSet.name} is recorded. Pick another set below.`;
      path.appendChild(end);
    }
  }

  /**
   * Fetch the categories for the signed-in contributor.
   *
   * This needs a token, so it cannot run before sign-in — it used to, which
   * left the map empty for anyone who signed in after the page loaded: the
   * request 401'd, the list stayed empty, and nothing ever asked again.
   */
  async function loadPacks() {
    if (!SolarisAuth.isSignedIn) { packs = []; return; }

    try {
      const r = await SolarisAuth.fetch(CONFIG.serverUrl + '/api/words/categories', { cache: 'no-store' });
      if (!r.ok) throw new Error(`the word list returned ${r.status}`);
      const data = await r.json();
      packs = data.categories || [];
      G.coverage = data.coverage || null;
    } catch (err) {
      console.error('[WORDS]', err);
      packs = [];
    }
    renderPacks();
  }

  /**
   * Progress lives on the server, keyed to the account, so it follows a
   * contributor to whatever phone they pick up next. Locally we only hold
   * what the last categories call returned, plus anything recorded since.
   */
  function packDone(pack) {
    return (pack.done || 0) + (G.doneSince[pack.id] || 0);
  }
  function markProgress(packId) {
    G.doneSince[packId] = (G.doneSince[packId] || 0) + 1;
  }

  /**
   * Refresh the progress shown on the existing cards without rebuilding them.
   * Replacing the grid would detach the very node the operator is reaching
   * for, and the tap would land on nothing.
   */
  function refreshPackProgress() {
    for (const card of $('packGrid').children) {
      const pack = packs.find(p => p.id === card.dataset.pack);
      if (!pack) continue;

      const done = packDone(pack);
      const pct = pack.count ? Math.round((done / pack.count) * 100) : 0;

      card.querySelector('.pack-fill').style.width = pct + '%';
      card.querySelector('.pack-track').classList.toggle('empty', !pct);
      const meta = card.querySelector('.pack-meta');
      const next = `${done}/${pack.count}`;
      if (meta.textContent !== next) {
        meta.textContent = next;
        meta.classList.remove('bumped');
        void meta.offsetWidth;
        meta.classList.add('bumped');
      }
      card.querySelector('.pack-go').innerHTML = ico(pct >= 100 ? 'check' : 'chevron');
      card.classList.toggle('complete', pct >= 100);
      card.classList.toggle('started', done > 0 && pct < 100);
      card.setAttribute('aria-label', `${pack.name}, ${done} of ${pack.count} done`);
    }
  }

  function renderPacks() {
    const grid = $('packGrid');
    grid.innerHTML = '';

    if (!packs.length) {
      const empty = document.createElement('p');
      empty.className = 'card-hint';
      empty.textContent = 'No word sets could be loaded. Check that public/packs/ is present on the server.';
      grid.appendChild(empty);
      return;
    }

    packs.forEach((pack, index) => {
      const done = packDone(pack);
      const pct = pack.count ? Math.round((done / pack.count) * 100) : 0;

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'pack' + (pct >= 100 ? ' complete' : done > 0 ? ' started' : '');
      card.dataset.pack = pack.id;
      card.setAttribute('aria-label', `${pack.name}, ${done} of ${pack.count} done`);

      card.innerHTML = `
        <span class="pack-icon">${ico(pack.icon || 'box')}</span>
        <span class="pack-body">
          <span class="pack-top">
            <span class="pack-name">${escapeHtml(pack.name)}</span>
            <span class="pack-meta">${done}/${pack.count}</span>
          </span>
          <span class="pack-track${pct ? '' : ' empty'}"><span class="pack-fill" style="width:${pct}%"></span></span>
        </span>
        <span class="pack-go">${ico(pct >= 100 ? 'check' : 'chevron')}</span>`;

      card.style.animationDelay = `${Math.min(index * 45, 320)}ms`;
      card.style.animationDelay = `${Math.min(index * 45, 320)}ms`;
      // Choosing a set from the list points the path at it. Recording starts
      // from the path, so the choice and the commitment stay separate.
      card.addEventListener('click', () => {
        setCurrentSet(pack);
        closeSets();
      });
      grid.appendChild(card);
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function paintProfile() {
    const user = SolarisAuth.user;
    if (!user) return;

    const initial = (user.displayName || user.username).trim().charAt(0) || '?';
    $('userAvatar').textContent = initial;
    $('drawerAvatar').textContent = initial;
    $('userName').textContent = user.displayName || user.username;
    $('drawerName').textContent = user.displayName || user.username;
    $('drawerHandle').textContent = '@' + user.username;
    $('userLevel').textContent = `Level ${user.level}`;
    $('levelBadge').textContent = user.level;

    const floor = xpForLevel(user.level);
    const ceiling = xpForLevel(user.level + 1);
    const into = Math.max(0, user.stats.xp - floor);
    const span = Math.max(1, ceiling - floor);

    $('xpNow').textContent = `${user.stats.xp} XP`;
    $('xpNext').textContent = `${Math.max(0, ceiling - user.stats.xp)} XP to level ${user.level + 1}`;
    $('levelFill').style.width = Math.min(100, (into / span) * 100) + '%';

    $('wordsDone').textContent = user.stats.words;
    $('drawerStreak').textContent = user.stats.streak || 0;
    $('drawerBest').textContent = user.stats.bestStreak || 0;

    const days = user.stats.streak || 0;
    $('portalStreakVal').textContent = days;
    $('portalStreak').classList.toggle('cold', !days);
    $('portalStreak').title = days
      ? `${days} day${days === 1 ? '' : 's'} in a row` +
        (user.stats.contributedToday ? '' : ' — record today to keep it')
      : 'Record a word to start a streak';
  }

  /** Per-set totals, listed in the profile drawer. */
  function paintDrawerSets() {
    const box = $('drawerSets');
    box.innerHTML = '';

    for (const pack of packs) {
      const done = packDone(pack);
      const pct = pack.count ? Math.round((done / pack.count) * 100) : 0;

      const row = document.createElement('div');
      row.className = 'contrib-row';
      row.innerHTML = `
        <span class="contrib-name">${escapeHtml(pack.name)}</span>
        <span class="contrib-bar"><span class="contrib-fill" style="width:${pct}%"></span></span>
        <span class="contrib-count">${done}/${pack.count}</span>`;
      box.appendChild(row);
    }
  }

  async function paintPortal() {
    paintProfile();

    // Whatever route got us here, the portal cannot draw without them.
    if (!packs.length) await loadPacks();

    if ($('packGrid').children.length) refreshPackProgress();
    else renderPacks();
    setCurrentSet(currentSet && packs.find(p => p.id === currentSet.id) || chooseSet());
    refreshQueue();
  }

  // ── Sets panel ──────────────────────────────────────────────────────────────
  let setsOpen = false;

  function openSets() {
    if (setsOpen) return;
    setsOpen = true;
    renderPacks();
    $('setsScrim').hidden = false;
    $('setsPanel').hidden = false;
    requestAnimationFrame(() => {
      $('setsScrim').classList.add('show');
      $('setsPanel').classList.add('show');
    });
  }

  function closeSets() {
    if (!setsOpen) return;
    setsOpen = false;
    $('setsScrim').classList.remove('show');
    $('setsPanel').classList.remove('show');
    setTimeout(() => {
      $('setsScrim').hidden = true;
      $('setsPanel').hidden = true;
    }, 340);
    setTab('learn');
  }

  function setTab(which) {
    for (const [name, el] of [['learn', $('tabLearn')], ['sets', $('tabSets')], ['you', $('tabYou')]]) {
      el.classList.toggle('is-on', name === which);
    }
  }

  // ── Profile drawer ──────────────────────────────────────────────────────────
  let drawerOpen = false;

  function openDrawer() {
    if (drawerOpen) return;
    drawerOpen = true;

    paintProfile();
    paintDrawerSets();

    $('drawerScrim').hidden = false;
    $('drawer').hidden = false;
    // A frame between unhiding and animating, or the transition never runs.
    requestAnimationFrame(() => {
      $('drawerScrim').classList.add('show');
      $('drawer').classList.add('show');
    });
    $('btnCloseDrawer').focus();
  }

  function closeDrawer() {
    if (!drawerOpen) return;
    drawerOpen = false;
    setTab('learn');

    $('drawerScrim').classList.remove('show');
    $('drawer').classList.remove('show');
    setTimeout(() => {
      $('drawerScrim').hidden = true;
      $('drawer').hidden = true;
    }, 360);
    $('btnProfile').focus();
  }

  /** Mirrors the server's curve so the portal can draw a progress bar without
   *  another round trip. Keep the two in step. */
  function xpForLevel(level) {
    return Math.pow(Math.max(0, level - 1), 2) * 120;
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

  /**
   * The index carries only a summary per set; the words themselves live in a
   * separate file and are fetched on the first tap, then kept for the rest of
   * the visit.
   */
  /**
   * Ask the server for a batch of prompts from this category.
   *
   * Drawn fresh every time rather than cached: the server excludes what this
   * contributor has already answered and favours words nobody has covered, so
   * two people working at once are not handed the same list.
   */
  async function openPack(entry, card) {
    if (!readSpeaker()) {
      toast('Sign in first');
      return;
    }

    card.classList.add('loading');
    try {
      const url = `${CONFIG.serverUrl}/api/words/batch?category=${encodeURIComponent(entry.id)}&count=${CONFIG.batchSize}`;
      const r = await SolarisAuth.fetch(url, { cache: 'no-store' });
      if (!r.ok) throw new Error(`the word list returned ${r.status}`);

      const data = await r.json();
      if (!data.words || !data.words.length) {
        toast(`Nothing left in ${entry.name} — every word is done`, 3200);
        return;
      }

      entry.items = data.words;
      entry.remaining = data.remaining;
      startSession(entry);
    } catch (err) {
      console.error('[BATCH]', err);
      toast(`Could not open ${entry.name}: ${err.message}`, 3600);
    } finally {
      card.classList.remove('loading');
    }
  }

  /**
   * The contributor is the speaker. There is no separate speaker field: the
   * person signed in is the one whose Banjara is being recorded, so their
   * account is the identity the archive files it under.
   */
  function readSpeaker() {
    return SolarisAuth.user ? SolarisAuth.user.username : '';
  }

  function startSession(pack) {
    const speaker = readSpeaker();
    if (!speaker) {
      toast('Sign in first');
      return;
    }

    G.speaker = speaker;

    // The batch is already filtered to words this contributor has not
    // answered, so it is played as given.
    G.pack = pack;
    G.queue = pack.items.slice();

    G.index = 0;
    G.phase = 'bnj';
    G.withTelugu = false;          // contributors record Banjara only
    G.takes = { bnj: null, tel: null };
    G.results = [];
    G.xp = 0;

    // The streak is a run of days, held on the account. A sitting displays it
    // but does not change it: recording twice in one afternoon is one day.
    G.streak = (SolarisAuth.user && SolarisAuth.user.stats.streak) || 0;
    G.bestStreak = G.streak;
    G.startedAt = Date.now();

    $('streakVal').textContent = G.streak;
    $('streakBox').classList.toggle('cold', !G.streak);

    buildSegbar();
    show('play');
    renderPrompt(false);

    // iOS only starts an AudioContext inside a gesture, and this tap is the
    // last guaranteed one before recording begins.
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
    if (!item) return finish('completed');

    const card = $('promptCard');
    const paint = () => {
      $('promptCat').textContent = (G.pack && G.pack.name) || item.category || 'word';
      $('promptWord').textContent = item.te;
      $('promptTranslit').textContent = item.translit || '';
      $('promptEn').textContent = item.en ? `“${item.en}”` : '';

      const teluguPhase = G.phase === 'tel';
      $('instruction').innerHTML = teluguPhase
        ? 'Now say it in <span class="lang" style="color:var(--blue)">Telugu</span>'
        : 'Say this in <span class="lang">Banjara</span>';

      $('btnSpeak').hidden = !hasTeluguVoice();
      $('recLabel').textContent = 'Tap to record';
      $('recGlyph').innerHTML = ico('mic');
      $('btnRecord').classList.remove('recording');
      $('btnSkip').hidden = teluguPhase;   // the Banjara answer is what can be absent
      $('promptPos').textContent = `${G.index + 1} of ${G.queue.length}`;
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
    $('recGlyph').innerHTML = ico('pause');
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
    $('recGlyph').innerHTML = ico('mic');
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
      $('recGlyph').innerHTML = ico('mic');
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
    $('sheetIcon').innerHTML = ico(passed ? 'check' : 'rotate');
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
    $('btnReplay').innerHTML = ico('pause');
    G.audio.addEventListener('ended', () => { $('btnReplay').innerHTML = ico('play'); });
    G.audio.play().catch(() => {});
  }

  function retryTake() {
    G.takes[G.phase] = null;
    hideSheet();
    $('recLabel').textContent = 'Tap to record';
    $('recGlyph').innerHTML = ico('mic');
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

    const base = `${G.speaker}_${item.id}`;   // the id repeats in the filename so a file stands alone
    const record = {
      // Filed under the contributor and the set. Opening a set is not a
      // numbered sitting, so there is no session folder in the path.
      folder: `contributors/${G.speaker}/${G.pack.id}/${item.id}`,
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
        contributor: G.speaker,
        pack: G.pack.id,
        prompt: { id: item.id, telugu: item.te, translit: item.translit, english: item.en, segment: item.segment },
        capturedAt: new Date().toISOString(),
        sampleRate: bnj.sampleRate,
        durations: { banjara: bnj.duration, telugu: tel ? tel.duration : null },
        scores: { banjara: bnj.grade.score, telugu: tel ? tel.grade.score : null },
        filter: SolarisDSP.DEFAULTS,
        client: navigator.userAgent,
        // Claimed here for convenience; the server stamps the authoritative
        // value from the token.
        recordedBy: SolarisAuth.user ? SolarisAuth.user.username : null,
      },
    };

    G.busy = true;
    try {
      const res = await SolarisStore.save(record);
      if (res.queued) {
        toast('Saved on this device — will upload later');
      } else if (res.profile) {
        // Credited word by word, so a contributor who records one word and
        // stops still sees it counted.
        SolarisAuth.updateUser(res.profile);
        celebrateXp(res.xp);
        paintProfile();

        // The day streak may have just gone up; the session header shows it.
        const days = res.profile.stats.streak || 0;
        $('streakVal').textContent = days;
        $('streakBox').classList.toggle('cold', !days);
      }
    } catch (err) {
      console.error('[SAVE]', err);
      toast('Save failed: ' + err.message, 3600);
    } finally {
      G.busy = false;
    }

    $('streakBox').classList.add('pulse');
    setTimeout(() => $('streakBox').classList.remove('pulse'), 500);

    G.results[G.index] = 'recorded';
    markProgress(G.pack.id);
    advance();
  }

  function skipWord() {
    if (G.busy || G.isRec) return;
    // A word with no Banjara equivalent is a finding, not a gap — it is kept
    // in the session log rather than silently dropped.
    G.results[G.index] = 'skipped';
    markProgress(G.pack.id);
    // A skip does not break a day streak: it is an answer, and the streak is
    // about turning up rather than about never saying "no word for this".

    // Tell the server too: a word with no Banjara form should not come back
    // to this contributor, and it is a finding worth keeping.
    const wordId = currentItem().id;
    SolarisAuth.fetch(CONFIG.serverUrl + '/api/words/skip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wordId }),
    }).catch(() => {});


    toast('Marked as “no Banjara word”');
    hideSheet();
    advance();
  }

  function advance() {
    G.takes = { bnj: null, tel: null };
    G.phase = 'bnj';
    G.index++;
    if (G.index >= G.queue.length) finish('completed');
    else renderPrompt(true);
  }

  /** How many sessions are waiting to upload, shown on the portal. */
  async function refreshQueue() {
    const n = await SolarisStore.pending();
    const note = $('portalQueue');
    if (!note) return;
    note.hidden = n === 0;
    if (n) note.textContent = `${n} session(s) waiting to upload. They send automatically once the server is reachable.`;
  }

  /** A floating +XP over the record button, a ring around the avatar, and a
   *  nudge on the level bar. Progress should be felt where it happened. */
  function celebrateXp(xp) {
    if (!xp) return;

    const anchor = $('btnRecord').getBoundingClientRect();
    const float = document.createElement('div');
    float.className = 'xp-float';
    float.textContent = `+${xp} XP`;
    float.style.left = `${anchor.left + anchor.width / 2}px`;
    float.style.top = `${anchor.top - 8}px`;
    document.body.appendChild(float);
    setTimeout(() => float.remove(), 1300);

    const avatar = $('btnProfile');
    avatar.classList.remove('pulse');
    void avatar.offsetWidth;          // restart the animation
    avatar.classList.add('pulse');

    const fill = $('levelFill');
    fill.classList.remove('bumped');
    void fill.offsetWidth;
    fill.classList.add('bumped');
  }

  // ── Finish ──────────────────────────────────────────────────────────────────
  /**
   * End the sitting.
   *
   * @param {'completed'|'quit'} how  Whether every prompt was answered, or
   *        the contributor closed the set part-way. Leaving early is a normal
   *        thing to do — the phone rings, the speaker has to go — and it
   *        should not be dressed up as an achievement. The work is saved
   *        either way; only the celebration is earned.
   */
  async function finish(how = 'completed') {
    hideSheet();
    // A toast from the last action would land on top of the completion
    // screen's buttons.
    hideToast();
    releaseWakeLock();

    const recorded = G.results.filter(r => r === 'recorded').length;
    const skipped  = G.results.filter(r => r === 'skipped').length;
    const minutes  = Math.max(1, Math.round((Date.now() - G.startedAt) / 60000));

    // The log is written either way: what was recorded belongs to the archive
    // regardless of how the sitting ended.
    const logging = writeSessionLog(recorded, skipped);

    if (how === 'quit') {
      G.doneSince = {};
      await loadPacks();
      show('portal');
      toast(recorded
        ? `Stopped — ${recorded} word${recorded === 1 ? '' : 's'} saved`
        : 'Stopped — nothing recorded yet');
      await logging;
      return;
    }

    $('statXp').textContent = G.xp;
    $('statRecorded').textContent = `${recorded}/${G.queue.length}`;
    $('statStreak').textContent = G.bestStreak;
    $('statTime').textContent = `${minutes}m`;

    const setName = (G.pack && G.pack.name) || 'this set';
    const setFinished = typeof G.pack?.remaining === 'number' &&
      G.pack.remaining - (recorded + skipped) <= 0;

    $('doneTitle').textContent = setFinished
      ? `${setName} complete!`
      : recorded === G.queue.length ? 'Every word recorded!' : 'Batch complete';
    $('doneSub').textContent = skipped
      ? `${recorded} recorded, ${skipped} marked as having no Banjara word.`
      : `${recorded} word${recorded === 1 ? '' : 's'} added to the archive.`;

    G.doneSince = {};
    loadPacks();            // re-read progress from the server
    show('done');
    confetti();
    blip('good');
    buzz([20, 60, 20, 60, 40]);

    await logging;

    const pending = await SolarisStore.pending();
    const note = $('queueNote');
    note.hidden = pending === 0;
    if (pending) note.textContent = `${pending} session(s) waiting to upload. They will send automatically when the server is reachable.`;
  }

  /** Records the order, the skips and the timing — the parts of a session that
   *  the audio files alone cannot show. */
  async function writeSessionLog(recorded, skipped) {
    const body = {
      folder: `contributors/${G.speaker}/logs`,
      name: `${new Date(G.startedAt).toISOString().replace(/[:.]/g, '-')}.json`,
      log: {
        contributor: G.speaker,
        pack: { id: G.pack.id, name: G.pack.name },
        withTelugu: G.withTelugu,
        startedAt: new Date(G.startedAt).toISOString(),
        finishedAt: new Date().toISOString(),
        xp: G.xp,
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
      const r = await SolarisAuth.fetch(CONFIG.serverUrl + '/api/session-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      // The server folds this session into the account's lifetime totals and
      // hands back the updated profile, so the level shown stays truthful.
      const data = await r.json().catch(() => ({}));
      if (data && data.profile) {
        SolarisAuth.updateUser(data.profile);
        $('doneSub').textContent += ` Level ${data.profile.level} · ${data.profile.stats.xp} XP total.`;
      }
    } catch {
      // The per-word saves already carry the important data; the log is extra.
    }
  }

  function confetti() {
    const colors = ['#e4322b', '#ffc24d', '#34c77b', '#5cc8ff', '#ff6f91', '#dfe6f2'];
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
    const done = G.results.filter(Boolean).length;
    if (done > 0 && !confirm('Stop here? The words you have recorded are saved.')) return;
    // Closing part-way returns to the portal rather than the completion
    // screen — nothing has been completed.
    finish('quit');
  }

  // ── Wiring ──────────────────────────────────────────────────────────────────
  function init() {
    SolarisStore.configure({ baseUrl: CONFIG.serverUrl });

    $('btnAuthSubmit').addEventListener('click', submitAuth);
    $('btnAuthToggle').addEventListener('click', () => {
      authMode = authMode === 'login' ? 'register' : 'login';
      paintAuthMode();
    });
    $('auth-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
    $('btnSignOut').addEventListener('click', signOut);
    $('btnProfile').addEventListener('click', openDrawer);
    $('unitBanner').addEventListener('click', openSets);
    $('btnCloseSets').addEventListener('click', closeSets);
    $('setsScrim').addEventListener('click', closeSets);

    $('tabLearn').addEventListener('click', () => { closeSets(); closeDrawer(); setTab('learn'); });
    $('tabSets').addEventListener('click', () => { setTab('sets'); openSets(); });
    $('tabYou').addEventListener('click', () => { setTab('you'); openDrawer(); });
    $('btnCloseDrawer').addEventListener('click', closeDrawer);
    $('drawerScrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawerOpen) closeDrawer(); });

    // Swiping the drawer to the right should dismiss it, the way a sheet does.
    let swipeFrom = null;
    $('drawer').addEventListener('touchstart', (e) => { swipeFrom = e.touches[0].clientX; }, { passive: true });
    $('drawer').addEventListener('touchend', (e) => {
      if (swipeFrom === null) return;
      if (e.changedTouches[0].clientX - swipeFrom > 70) closeDrawer();
      swipeFrom = null;
    }, { passive: true });

    $('btnRecord').addEventListener('click', toggleRecord);
    $('btnSkip').addEventListener('click', skipWord);
    $('btnSpeak').addEventListener('click', speakPrompt);
    $('btnReplay').addEventListener('click', replayTake);
    $('btnRetry').addEventListener('click', retryTake);
    $('btnContinue').addEventListener('click', continueFlow);
    $('btnQuit').addEventListener('click', quit);
    $('btnHome').addEventListener('click', () => show('portal'));

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

    SolarisIcons.mount();

    // Icons that never change, painted once.
    $('streakIcon').innerHTML = ico('flame');
    $('streakIconPlay').innerHTML = ico('flame');
    $('speakIcon').innerHTML = ico('volume');
    $('skipIcon').innerHTML = ico('ban');
    $('recGlyph').innerHTML = ico('mic');
    $('btnQuit').innerHTML = ico('close');
    $('btnCloseSets').innerHTML = ico('close');
    $('unitSwitch').innerHTML = ico('chevron');
    $('tabLearnIcon').innerHTML = ico('mic');
    $('tabSetsIcon').innerHTML = ico('box');
    $('tabYouIcon').innerHTML = ico('user');
    $('btnCloseDrawer').innerHTML = ico('close');
    $('btnReplay').innerHTML = ico('play');
    $('trophy').innerHTML = ico('award');

    SolarisAuth.configure({ baseUrl: CONFIG.serverUrl });
    checkServer();
    decideStartScreen();     // loads the categories once there is a session
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
