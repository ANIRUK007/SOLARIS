/**
 * End-to-end test of the whole app at phone size: sign-up, the portal, a
 * word session, and what lands on disk.
 * Run with: npm run test:e2e
 *
 * Drives the real loop with Chrome's fake microphone: start a session,
 * record a couple of prompts, skip one, finish, and confirm what landed on
 * disk — including the session log that records the skip.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');

const PORT = 3196;
const BASE = `http://127.0.0.1:${PORT}`;
const DATASET = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-play-')));
const SHOTS = path.join(__dirname, 'screenshots');

function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const builds = fs.readdirSync(cache)
    .filter(d => d.startsWith('chromium-') && fs.existsSync(path.join(cache, d, 'INSTALLATION_COMPLETE')))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const dir of ['chrome-mac-arm64', 'chrome-mac']) {
      for (const app of ['Google Chrome for Testing', 'Chromium']) {
        const exe = path.join(cache, build, dir, `${app}.app`, 'Contents', 'MacOS', app);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
}

/**
 * Poll a predicate in the page.
 *
 * Playwright's waitForFunction evaluates a string, which the app's content
 * security policy refuses — it forbids unsafe-eval precisely so an injected
 * script cannot run. Rather than turning the policy off for the tests, which
 * would stop them exercising what real browsers enforce, this polls with
 * page.evaluate.
 */
async function waitFor(page, fn, arg, timeout = 20000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return true;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${fn.toString().slice(0, 80)}`);
    await page.waitForTimeout(120);
  }
}

const walk = (dir) => fs.existsSync(dir)
  ? fs.readdirSync(dir, { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])
  : [];

(async function run() {
  console.log('\nword session (mobile viewport)');
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SOLARIS_DATASET_DIR: DATASET,
      SARVAM_API_KEY: '', GROQ_API_KEY: '',
      // Force the file backend. Without this a developer's .env would point
      // the tests at the live project and they would write to it.
      SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
      SOLARIS_USERS_FILE: path.join(DATASET, 'users.json'),
      SOLARIS_WORD_INDEX: path.join(DATASET, 'word-index.json'),
      SSL_CERT: path.join(DATASET, 'none'), SSL_KEY: path.join(DATASET, 'none'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const page = await context.newPage();

  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  page.on('dialog', d => d.accept());          // the quit confirmation

  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });

    // ── The app opens behind the account screen ──────────────────────────────
    check('the app opens on the account screen, not the portal',
      await page.isVisible('#screen-auth') && !(await page.isVisible('#screen-portal')));

    check('the username field does not suggest a real-looking value',
      (await page.getAttribute('#auth-user', 'placeholder')) === 'Choose a username',
      await page.getAttribute('#auth-user', 'placeholder'));

    check('with no accounts yet, sign-up is offered rather than sign-in',
      (await page.textContent('#btnAuthSubmit')).includes('Create'),
      await page.textContent('#btnAuthSubmit'));

    check('the account screen reaches the server',
      (await page.textContent('#srvLbl')).includes('online'),
      await page.textContent('#srvLbl'));

    const authOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow on the account screen', authOverflow <= 0, `overflows by ${authOverflow}px`);

    await page.screenshot({ path: path.join(SHOTS, '01-auth.png') });

    // A weak password must be refused by the server, with the reason shown.
    await page.fill('#auth-user', 'fieldworker');
    await page.fill('#auth-pass', 'short');
    await page.click('#btnAuthSubmit');
    await waitFor(page, () => !document.querySelector('#authErr').hidden, null, 10000);
    check('a weak password is rejected with a readable reason',
      /10 characters/i.test(await page.textContent('#authErr')),
      await page.textContent('#authErr'));

    // That rejection is a deliberate 400, which the browser logs as a failed
    // resource load. Drop exactly that one so it cannot mask a real error.
    for (const e of errors.filter(e => /400/.test(e) && /Failed to load resource/.test(e))) {
      errors.splice(errors.indexOf(e), 1);
    }

    await page.fill('#auth-pass', 'field-pass-2026');
    await page.fill('#auth-name', 'Field Worker');
    await page.click('#btnAuthSubmit');
    await page.waitForSelector('#screen-portal:not([hidden])', { timeout: 15000 });

    // ── Portal ───────────────────────────────────────────────────────────────
    check('creating an account lands on the portal',
      await page.isVisible('#screen-portal'));
    check('the portal greets the user by display name',
      (await page.textContent('#userName')).includes('Field Worker'),
      await page.textContent('#userName'));
    check('the portal shows the level beside the name',
      (await page.textContent('#userLevel')).includes('Level 1'),
      await page.textContent('#userLevel'));

    check('the streak sits at the top with its flame', await page.isVisible('#portalStreak'));

    // Containment, not visibility: a bar at 0% has no size and would read as
    // hidden wherever it sat.
    check('the progress bar is not on the portal — it lives in the profile',
      await page.evaluate(() => !document.querySelector('#screen-portal #levelFill')));

    // ── Profile drawer ───────────────────────────────────────────────────────
    await page.click('#btnProfile');
    await page.waitForTimeout(500);

    check('tapping the avatar slides the profile in', await page.isVisible('#drawer'));
    check('the profile carries the XP loader',
      await page.evaluate(() => !!document.querySelector('#drawer #levelFill')) &&
      (await page.textContent('#xpNow')).includes('0 XP') &&
      (await page.textContent('#wordsDone')).trim() === '0',
      `${await page.textContent('#xpNow')} / ${await page.textContent('#wordsDone')}`);

    const drawerIn = await page.evaluate(() => {
      const d = document.querySelector('#drawer').getBoundingClientRect();
      return d.right <= window.innerWidth + 1 && d.left >= -1;
    });
    check('the drawer sits fully within the viewport', drawerIn);

    check('the profile lists every word set',
      await page.evaluate(() => document.querySelectorAll('#drawerSets .contrib-row').length) === 15);

    await page.screenshot({ path: path.join(SHOTS, '02b-profile.png') });

    // Tapping the scrim dismisses it, the way a drawer should.
    await page.click('#drawerScrim', { position: { x: 20, y: 300 } });
    await page.waitForTimeout(500);
    check('tapping outside closes the drawer', !(await page.isVisible('#drawer')));

    check('there is no separate speaker field — the contributor is the account',
      await page.evaluate(() => !document.querySelector('#portal-speaker')));

    // The map is the whole archive: one road, a section per word set.
    const bands = await page.evaluate(() =>
      [...document.querySelectorAll('#path .section-band .band-no')].map(e => e.textContent.trim()));
    check('every word set appears as a section of the map',
      bands.length === 15, `${bands.length} sections: ${bands.slice(0, 3).join(', ')}…`);
    check('the sections are named after the word sets',
      bands[0] === 'Places' && bands.includes('Animals'), bands.slice(0, 3).join(', '));

    // The categories need a token, so they cannot be fetched before sign-in.
    // They used to be, which left the map empty for anyone who signed in after
    // the page had loaded — the request 401'd and nothing asked again.
    check('the map is populated straight after signing in',
      await page.evaluate(() => document.querySelectorAll('#path .node').length) > 0);

    // 1,482 words at five per tile.
    const nodes = await page.evaluate(() => document.querySelectorAll('#path .node').length);
    check('there is a tile for every five words in the archive',
      nodes === 297, `found ${nodes} tiles`);

    check('each section says how many words its set holds',
      /\d+ words/.test(await page.textContent('#path .section-band')),
      await page.textContent('#path .section-band'));

    check('a road is drawn between the tiles',
      await page.evaluate(() => !!document.querySelector('#path .trail path')));

    // A fixed pattern per section made the second half look like the first
    // stamped again.
    const offsets = await page.evaluate(() =>
      [...document.querySelectorAll('#path .node-row')]
        .map(r => Math.round(r.getBoundingClientRect().left)));
    const repeats = offsets.slice(0, 5).every((v, i) => Math.abs(v - offsets[5 + i]) < 3);
    check('the road wanders rather than repeating the same shape per section',
      !repeats, `offsets: ${offsets.join(', ')}`);

    check('no tile is pushed off the side of the screen',
      await page.evaluate(() => [...document.querySelectorAll('#path .node')]
        .every(n => {
          const r = n.getBoundingClientRect();
          return r.left >= 0 && r.right <= window.innerWidth;
        })));

    check('a set with nothing done opens at the start of the road',
      await page.evaluate(() =>
        document.querySelector('#screen-portal .portal-body').scrollTop < 40));


    check('exactly one node is the live one',
      await page.evaluate(() => document.querySelectorAll('#path .node.live').length) === 1);

    check('the live node is the one that invites a start',
      await page.evaluate(() => !!document.querySelector('#path .node.live .node-flag')));

    check('there is no separate sets tab — the sets are the map',
      await page.evaluate(() => !document.querySelector('#tabSets')));



    const portalOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow on the portal', portalOverflow <= 0, `overflows by ${portalOverflow}px`);

    await page.screenshot({ path: path.join(SHOTS, '02-portal.png'), fullPage: true });

    // ── Returning lands on the tile they are up to ───────────────────────────
    // Sixty words answered the way the app answers them, so the map has real
    // progress behind it rather than a number poked into the page.
    await page.evaluate(async () => {
      // The first section of the map, which is where the road starts.
      const r = await window.SolarisAuth.fetch('/api/words/categories');
      const set = (await r.json()).categories[0];

      for (let round = 0; round < 2; round++) {
        const b = await window.SolarisAuth.fetch(
          `/api/words/batch?category=${set.id}&count=30`);
        for (const w of (await b.json()).words) {
          await window.SolarisAuth.fetch('/api/words/skip', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wordId: w.id }),
          });
        }
      }
    });

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('#screen-portal:not([hidden])', { timeout: 15000 });
    await page.waitForTimeout(900);

    const resumed = await page.evaluate(() => {
      const body = document.querySelector('#screen-portal .portal-body');
      const live = document.querySelector('#path .node.live');
      if (!live) return { ok: false, why: 'no live tile' };

      const b = body.getBoundingClientRect();
      const l = live.getBoundingClientRect();
      return {
        ok: l.top >= b.top && l.bottom <= b.bottom,
        scrollTop: Math.round(body.scrollTop),
        done: document.querySelectorAll('#path .node.done').length,
        // Position of the live tile among all tiles, which is what "the next
        // one along" means now the per-tile labels are gone.
        index: [...document.querySelectorAll('#path .node')].indexOf(live),
      };
    });

    check('returning scrolls to the tile after the last one contributed',
      resumed.ok && resumed.scrollTop > 0, JSON.stringify(resumed));
    check('the tiles already answered are marked done',
      resumed.done === 12, `${resumed.done} done`);
    check('the live tile is the one straight after the finished ones',
      resumed.index === resumed.done, `live at ${resumed.index}, ${resumed.done} done`);

    // ── Start a session from the path ────────────────────────────────────────
    await page.click('#path .node.live');
    await page.waitForSelector('#screen-play:not([hidden])');

    const promptWord = await page.textContent('#promptWord');
    check('tapping the live node opens a session on its first Telugu prompt',
      promptWord.trim().length > 0 && promptWord !== '—', `showed "${promptWord}"`);

    check('the instruction asks for Banjara',
      (await page.textContent('#instruction')).includes('Banjara'));

    const segCount = await page.evaluate(() => document.querySelectorAll('#segbar .seg').length);
    check('a sitting is one tile: five prompts', segCount === 5, `found ${segCount} segments`);

    // The words handed out must come from the database, not be invented.
    const promptId = await page.evaluate(() => window.__solarisGame.queue[0].id);
    check('the prompt comes from the imported word database',
      /^tel_[a-z]+_\d+$/.test(promptId), promptId);

    const fits = await page.evaluate(() => {
      const rec = document.querySelector('#btnRecord').getBoundingClientRect();
      const skip = document.querySelector('#btnSkip').getBoundingClientRect();
      return rec.bottom <= window.innerHeight + 1 && skip.bottom <= window.innerHeight + 1;
    });
    check('record and skip controls fit on screen without scrolling', fits);

    const playOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow during a session', playOverflow <= 0, `overflows by ${playOverflow}px`);

    await page.screenshot({ path: path.join(SHOTS, '03-prompt.png') });

    // ── Record the first prompt ──────────────────────────────────────────────
    const recordPrompt = async () => {
      await page.click('#btnRecord');
      // Wait for the stream to actually open before asking it to stop —
      // getUserMedia resolves asynchronously.
      await waitFor(page, () => window.__solarisGame && window.__solarisGame.isRec, null, 15000);
      await page.waitForTimeout(1600);
      await page.click('#btnRecord');
      await waitFor(page, () => document.querySelector('#sheet').classList.contains('show'), null, 20000);
      return page.evaluate(() => document.querySelector('#sheet').className);
    };

    let sheetClass = await recordPrompt();
    check('a verdict sheet appears after recording', sheetClass.includes('show'), sheetClass);

    // Retry until the fake microphone lands on a loud enough stretch; a human
    // would do exactly the same.
    for (let i = 0; i < 3 && !sheetClass.includes('good'); i++) {
      await page.click('#btnRetry');
      await page.waitForTimeout(300);
      sheetClass = await recordPrompt();
    }
    check('a good take is accepted', sheetClass.includes('good'), sheetClass);

    // The verdict sheet must not push its own buttons off the bottom of the
    // screen — that would leave the session with no way forward. Measured
    // after the slide-up transition settles, not during it.
    await page.waitForTimeout(500);
    const sheetFits = await page.evaluate(() => {
      const cont = document.querySelector('#btnContinue').getBoundingClientRect();
      const retry = document.querySelector('#btnRetry').getBoundingClientRect();
      return {
        ok: cont.bottom <= window.innerHeight + 1 && retry.bottom <= window.innerHeight + 1,
        detail: `continue bottom ${Math.round(cont.bottom)}, viewport ${window.innerHeight}`,
      };
    });
    check('the verdict sheet keeps its buttons on screen', sheetFits.ok, sheetFits.detail);

    const xpText = await page.textContent('#sheetXp');
    check('XP is awarded for a good take', /\+\d+ XP/.test(xpText), xpText);

    await page.screenshot({ path: path.join(SHOTS, '04-verdict.png') });

    await page.click('#btnContinue');
    await page.waitForTimeout(700);

    check('the session advances to the second prompt',
      await page.evaluate(() => window.__solarisGame.index) === 1);
    check('the first segment is marked done',
      await page.evaluate(() => document.querySelectorAll('#segbar .seg.done').length) === 1);
    check('the streak counter incremented',
      (await page.textContent('#streakVal')).trim() === '1');

    // ── Skip the second prompt ───────────────────────────────────────────────
    await page.click('#btnSkip');
    await page.waitForTimeout(600);
    check('skipping advances and marks the segment',
      await page.evaluate(() => document.querySelectorAll('#segbar .seg.skipped').length) === 1);
    // A day streak is about turning up, not about never saying "no word for
    // this" — so a skip must not break it.
    check('skipping does not break the day streak',
      (await page.textContent('#streakVal')).trim() === '1',
      await page.textContent('#streakVal'));

    // ── Closing part-way must not celebrate ──────────────────────────────────
    await page.click('#btnQuit');
    await page.waitForSelector('#screen-portal:not([hidden])', { timeout: 10000 });

    check('closing a set part-way returns to the portal, not the completion screen',
      await page.isVisible('#screen-portal') && !(await page.isVisible('#screen-done')));

    check('the words recorded before closing are still counted',
      await page.evaluate(() => window.SolarisAuth.user.stats.words) === 1,
      JSON.stringify(await page.evaluate(() => window.SolarisAuth.user.stats)));

    // ── Finishing every prompt does celebrate ────────────────────────────────
    await page.click('#path .node.live');
    await page.waitForSelector('#screen-play:not([hidden])');

    // Answer the whole batch. Skipping is a real answer and is instant, which
    // keeps the test to the behaviour being checked rather than the recorder.
    const batchSize = await page.evaluate(() => window.__solarisGame.queue.length);
    for (let i = 0; i < batchSize; i++) {
      await page.click('#btnSkip');
      await page.waitForTimeout(320);
    }

    await page.waitForSelector('#screen-done:not([hidden])', { timeout: 15000 });
    check('answering every prompt in the batch shows the completion screen',
      await page.isVisible('#screen-done'));

    // This batch was answered entirely with "no Banjara word", which is a
    // valid outcome that earns nothing — the screen should report zero rather
    // than invent a reward.
    check('the completion screen reports the XP actually earned',
      (await page.textContent('#statXp')).trim() === '0',
      await page.textContent('#statXp'));

    check('the completion screen counts what was answered',
      /^\d+\/\d+$/.test((await page.textContent('#statRecorded')).trim()),
      await page.textContent('#statRecorded'));

    check('the completion screen does not claim recordings that were not made',
      !/added to the archive/i.test(await page.textContent('#doneSub')) ||
      /0 words/.test(await page.textContent('#doneSub')),
      await page.textContent('#doneSub'));

    check('the session is attributed to the signed-in account',
      await page.evaluate(() => window.__solarisGame && window.SolarisAuth.user.username) === 'fieldworker');

    await page.waitForTimeout(800);

    // Every stat tile must stack its value above its label. A generic class
    // name once collided with the top-bar streak pill and turned one tile
    // into a flex row, which only showed up by eye.
    const tiles = await page.evaluate(() => [...document.querySelectorAll('.stat')].map(s => {
      const v = s.querySelector('.v').getBoundingClientRect();
      const k = s.querySelector('.k').getBoundingClientRect();
      return { cls: s.className, stacked: k.top >= v.bottom - 1, sameLeft: Math.abs(k.left - v.left) < 2 };
    }));
    check('every completion stat stacks its value above its label',
      tiles.every(t => t.stacked && t.sameLeft),
      tiles.filter(t => !t.stacked || !t.sameLeft).map(t => t.cls).join(', '));

    // Nothing may cover the primary button on the completion screen.
    const buttonClear = await page.evaluate(() => {
      const btn = document.querySelector('#btnHome').getBoundingClientRect();
      const mid = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
      return mid && (mid.id === 'btnHome' || mid.closest('#btnHome')) ? null : (mid ? mid.className || mid.id : 'nothing');
    });
    check('nothing overlaps the return-to-portal button', buttonClear === null, `covered by ${buttonClear}`);

    await page.screenshot({ path: path.join(SHOTS, '05-complete.png') });

    // ── What landed on disk ──────────────────────────────────────────────────
    const files = walk(DATASET).map(f => path.relative(DATASET, f));

    check('the take is filed under the contributor and the word set',
      files.some(f => /contributors[\\/]fieldworker[\\/][\w-]+[\\/]tel_\w+[\\/]\w+_banjara\.wav$/.test(f)),
      files.join(', '));
    check('the raw take was archived alongside it',
      files.some(f => /_banjara_raw\.wav$/.test(f)), files.join(', '));
    check('no Telugu audio was saved, since only Banjara was requested',
      !files.some(f => /_telugu\.wav$/.test(f)), files.join(', '));

    const txt = walk(DATASET).find(f => f.endsWith('.txt'));
    check('the transcript holds the Telugu prompt, with no speech-to-text involved',
      txt && fs.readFileSync(txt, 'utf8').trim() === promptWord.trim(),
      txt ? `"${fs.readFileSync(txt, 'utf8')}" vs prompt "${promptWord}"` : 'no transcript written');

    const meta = walk(DATASET).find(f => f.endsWith('session.json'));
    check('the saved session records who was signed in',
      meta && JSON.parse(fs.readFileSync(meta, 'utf8')).recordedBy === 'fieldworker',
      meta ? JSON.stringify(JSON.parse(fs.readFileSync(meta, 'utf8')).recordedBy) : 'no session.json');

    // Logs are filed per contributor and named by when the sitting started.
    const logPath = walk(DATASET).find(f => /contributors[\\/]\w+[\\/]logs[\\/].+\.json$/.test(f));
    check('a session log was written', !!logPath, files.join(', '));

    if (logPath) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      check('the log records the skipped word as a finding',
        log.items.some(i => i.outcome === 'skipped'),
        JSON.stringify(log.totals));
      // Which set gets offered is decided at runtime, so the check is that a
      // real one was recorded, not a particular one.
      check('the log records the contributor and the word set',
        log.contributor === 'fieldworker' && !!(log.pack && log.pack.id),
        JSON.stringify({ contributor: log.contributor, pack: log.pack }));
    }

    // ── Back to the portal ───────────────────────────────────────────────────
    await page.click('#btnHome');
    await page.waitForSelector('#screen-portal:not([hidden])');

    // One recorded plus one marked as having no Banjara word: both are
    // answered, so both count as done and neither comes back next session.
    // Everything answered so far, read back from the server rather than from
    // anything held on the device.
    const answered = await page.evaluate(() =>
      [...document.querySelectorAll('#path .section-band .band-count')]
        .map(e => Number(e.textContent.split('/')[0]))
        .reduce((a, b) => a + b, 0));
    check('the map reflects the words answered, read back from the server',
      answered >= 6, `totals ${answered}`);

    // Only recordings are credited; skips are answers, not contributions.
    await page.click('#btnProfile');
    await page.waitForTimeout(500);

    check('the XP loader moved with the word contributed',
      !/^0 XP$/.test((await page.textContent('#xpNow')).trim()) &&
      (await page.textContent('#wordsDone')).trim() === '1',
      `${await page.textContent('#xpNow')} / ${await page.textContent('#wordsDone')} words`);

    check('a single contributed word is enough to register',
      await page.evaluate(() => window.SolarisAuth.user.stats.words) === 1,
      JSON.stringify(await page.evaluate(() => window.SolarisAuth.user.stats)));

    await page.screenshot({ path: path.join(SHOTS, '07-profile-after.png') });
    await page.click('#btnCloseDrawer');
    await page.waitForTimeout(450);

    check('opening a word set was not counted as a session',
      await page.evaluate(() => !('sessions' in window.SolarisAuth.user.stats)),
      JSON.stringify(await page.evaluate(() => window.SolarisAuth.user.stats)));

    await page.screenshot({ path: path.join(SHOTS, '06-portal-after.png'), fullPage: true });

    // ── A second contributor gets different words ────────────────────────────
    const mine = await page.evaluate(() => window.__solarisGame.queue.map(w => w.id));

    // Registration is closed to strangers once an account exists, so the
    // second contributor is created by the first — the way a lead adds a
    // teammate — and then signs in normally.
    const invited = await page.evaluate(async () => {
      const r = await window.SolarisAuth.fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'second', password: 'quiet-harbour-2026', displayName: 'Second Voice' }),
      });
      return r.status;
    });
    check('an existing contributor can create an account for a teammate',
      invited === 201, `status ${invited}`);

    const other = await context.newPage();
    await other.goto(BASE, { waitUntil: 'networkidle' });
    await other.evaluate(() => localStorage.clear());
    await other.reload({ waitUntil: 'networkidle' });
    await other.fill('#auth-user', 'second');
    await other.fill('#auth-pass', 'quiet-harbour-2026');
    await other.click('#btnAuthSubmit');
    await other.waitForSelector('#screen-portal:not([hidden])', { timeout: 15000 });

    const theirBatch = await other.evaluate(async () => {
      const r = await window.SolarisAuth.fetch('/api/words/batch?count=10');
      return (await r.json()).words.map(w => w.id);
    });

    const overlap = theirBatch.filter(id => mine.includes(id));
    check('a second contributor is handed a different set of words',
      overlap.length <= 2, `${overlap.length} of 10 overlapped: ${overlap.join(', ')}`);

    check('the second contributor starts with their own empty progress',
      await other.evaluate(() => window.SolarisAuth.user.stats.words) === 0);

    await other.close();

    // ── Landscape ────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const landscapeOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow in landscape', landscapeOverflow <= 0, `overflows by ${landscapeOverflow}px`);

    check('no uncaught console errors', errors.length === 0, errors.join(' | '));

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exitCode = 1;
  } catch (err) {
    console.error('  run aborted:', err.message);
    await page.screenshot({ path: path.join(SHOTS, 'failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(DATASET, { recursive: true, force: true });
  }
})();
