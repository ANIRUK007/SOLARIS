/**
 * End-to-end test of the prompt-driven word session, at phone size.
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
      SOLARIS_USERS_FILE: path.join(DATASET, 'users.json'),
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
    await page.goto(BASE + '/play.html', { waitUntil: 'networkidle' });

    check('setup screen loads with the word pack listed',
      (await page.textContent('#setup-pack')).includes('Everyday Words'),
      await page.textContent('#setup-pack'));

    check('setup reports the server as reachable',
      (await page.textContent('#srvLbl')).includes('online'));

    const setupOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow on setup', setupOverflow <= 0, `overflows by ${setupOverflow}px`);

    // The setup screen must fit a standard phone without clipping its own
    // fields behind the start button.
    const setupFits = await page.evaluate(() => {
      const col = document.querySelector('#screen-setup .center-col');
      return { over: col.scrollHeight - col.clientHeight, h: col.clientHeight };
    });
    check('the setup screen fits without scrolling', setupFits.over <= 2,
      `content overflows by ${setupFits.over}px in ${setupFits.h}px`);

    await page.screenshot({ path: path.join(SHOTS, 'play-01-setup.png') });

    // ── Sign up through the interface ────────────────────────────────────────
    // No account exists yet, so the tools are usable and the sign-up is
    // offered rather than forced.
    check('the sign-in route is offered on first run',
      await page.isVisible('#btnGoAuth'));

    await page.click('#btnGoAuth');
    await page.waitForSelector('#screen-auth:not([hidden])');

    check('the sign-up form is shown, not the sign-in form',
      (await page.textContent('#btnAuthSubmit')).includes('Create'),
      await page.textContent('#btnAuthSubmit'));

    await page.screenshot({ path: path.join(SHOTS, 'play-00-auth.png') });

    // A weak password must be refused by the server, with the reason shown.
    await page.fill('#auth-user', 'fieldworker');
    await page.fill('#auth-pass', 'short');
    await page.click('#btnAuthSubmit');
    await page.waitForFunction(() => !document.querySelector('#authErr').hidden, null, { timeout: 10000 });
    check('a weak password is rejected with a readable reason',
      /8 characters/i.test(await page.textContent('#authErr')),
      await page.textContent('#authErr'));

    // The rejection above is a deliberate 400, which the browser logs as a
    // failed resource load. Drop exactly that one so it cannot mask a real
    // error later.
    const expected = errors.filter(e => /400/.test(e) && /Failed to load resource/.test(e));
    for (const e of expected) errors.splice(errors.indexOf(e), 1);

    await page.fill('#auth-pass', 'fieldpass2024');
    await page.fill('#auth-name', 'Field Worker');
    await page.click('#btnAuthSubmit');
    await page.waitForSelector('#screen-setup:not([hidden])', { timeout: 15000 });

    check('creating an account signs the user straight in',
      await page.isVisible('#userChip'));
    check('the user chip shows the display name and level',
      (await page.textContent('#userName')).includes('Field Worker') &&
      /Level \d/.test(await page.textContent('#userLevel')),
      `${await page.textContent('#userName')} / ${await page.textContent('#userLevel')}`);

    // ── Start ────────────────────────────────────────────────────────────────
    await page.fill('#setup-speaker', 'SPK042');
    await page.click('#btnStart');
    await page.waitForSelector('#screen-play:not([hidden])');

    const promptWord = await page.textContent('#promptWord');
    check('the first Telugu prompt is displayed', promptWord.trim().length > 0 && promptWord !== '—', `showed "${promptWord}"`);

    check('the instruction asks for Banjara',
      (await page.textContent('#instruction')).includes('Banjara'));

    check('the progress bar has one segment per prompt',
      await page.evaluate(() => document.querySelectorAll('#segbar .seg').length) === 27);

    // Everything interactive must sit within the viewport — this screen never
    // scrolls.
    const fits = await page.evaluate(() => {
      const rec = document.querySelector('#btnRecord').getBoundingClientRect();
      const skip = document.querySelector('#btnSkip').getBoundingClientRect();
      return rec.bottom <= window.innerHeight + 1 && skip.bottom <= window.innerHeight + 1;
    });
    check('record and skip controls fit on screen without scrolling', fits);

    const playOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow while playing', playOverflow <= 0, `overflows by ${playOverflow}px`);

    await page.screenshot({ path: path.join(SHOTS, 'play-02-prompt.png') });

    // ── Record the first prompt ──────────────────────────────────────────────
    const recordPrompt = async () => {
      await page.click('#btnRecord');
      // Wait for the stream to actually open before asking it to stop —
      // getUserMedia resolves asynchronously.
      await page.waitForFunction(() => window.__solarisGame.isRec, null, { timeout: 15000 });
      await page.waitForTimeout(1600);
      await page.click('#btnRecord');
      await page.waitForFunction(
        () => document.querySelector('#sheet').classList.contains('show'),
        null, { timeout: 20000 });
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

    await page.screenshot({ path: path.join(SHOTS, 'play-03-verdict.png') });

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
    check('skipping resets the streak',
      (await page.textContent('#streakVal')).trim() === '0');

    // ── Finish early ─────────────────────────────────────────────────────────
    await page.click('#btnQuit');
    await page.waitForSelector('#screen-done:not([hidden])', { timeout: 10000 });

    check('the completion screen reports XP',
      Number(await page.textContent('#statXp')) > 0,
      await page.textContent('#statXp'));
    check('the completion screen counts what was recorded',
      (await page.textContent('#statRecorded')).startsWith('1/'),
      await page.textContent('#statRecorded'));

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
      const btn = document.querySelector('#btnAgain').getBoundingClientRect();
      const mid = document.elementFromPoint(btn.left + btn.width / 2, btn.top + btn.height / 2);
      return mid && (mid.id === 'btnAgain' || mid.closest('#btnAgain')) ? null : (mid ? mid.className || mid.id : 'nothing');
    });
    check('nothing overlaps the start-another-session button', buttonClear === null, `covered by ${buttonClear}`);

    await page.screenshot({ path: path.join(SHOTS, 'play-04-complete.png') });

    // ── What landed on disk ──────────────────────────────────────────────────
    const files = walk(DATASET).map(f => path.relative(DATASET, f));

    check('the Banjara take was saved under the prompt id',
      files.some(f => /SPK042_\w+_banjara\.wav$/.test(f)), files.join(', '));
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

    const logPath = walk(DATASET).find(f => f.endsWith('_log.json'));
    check('a session log was written', !!logPath, files.join(', '));

    if (logPath) {
      const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
      check('the log records the skipped word as a finding',
        log.items.some(i => i.outcome === 'skipped'),
        JSON.stringify(log.totals));
      check('the log records the speaker and pack',
        log.speaker === 'SPK042' && log.pack.id === 'starter',
        `${log.speaker} / ${log.pack && log.pack.id}`);
    }

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
    await page.screenshot({ path: path.join(SHOTS, 'play-failure.png') }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.kill();
    fs.rmSync(DATASET, { recursive: true, force: true });
  }
})();
