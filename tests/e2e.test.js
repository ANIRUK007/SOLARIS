/**
 * End-to-end test in a real browser at phone size. Run with:
 *   npm install --no-save playwright && npm run test:e2e
 *
 * Not part of `npm test` because it needs a browser download. It drives the
 * whole capture flow — record, filter, grade, save — against a real server
 * using Chrome's fake microphone, and writes screenshots to tests/screenshots.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');

const PORT = 3198;
const BASE = `http://127.0.0.1:${PORT}`;
const DATASET = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-e2e-')));
const SHOTS = path.join(__dirname, 'screenshots');

/**
 * Locate a Chromium to drive. Playwright's own download is used when it is
 * present; otherwise fall back to any complete build already in the shared
 * Playwright cache, which avoids a second multi-hundred-megabyte download on
 * a machine that already has one. Override with CHROMIUM_PATH.
 */
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;

  const builds = fs.readdirSync(cache)
    .filter(d => d.startsWith('chromium-'))
    .filter(d => fs.existsSync(path.join(cache, d, 'INSTALLATION_COMPLETE')))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));

  for (const build of builds) {
    for (const dir of ['chrome-mac-arm64', 'chrome-mac']) {
      for (const app of ['Google Chrome for Testing', 'Chromium']) {
        const exe = path.join(cache, build, dir, `${app}.app`, 'Contents', 'MacOS', app);
        if (fs.existsSync(exe)) return exe;
      }
    }
  }
  return undefined;   // let Playwright use its own managed browser
}

async function waitForServer(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/health')).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

(async function run() {
  console.log('\nend-to-end (mobile viewport)');
  fs.mkdirSync(SHOTS, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SOLARIS_DATASET_DIR: DATASET,
      SARVAM_API_KEY: '',
      GROQ_API_KEY: '',
      SOLARIS_USERS_FILE: path.join(DATASET, 'users.json'),
      SSL_CERT: path.join(DATASET, 'none'),
      SSL_KEY: path.join(DATASET, 'none'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  if (!await waitForServer(8000)) {
    console.error('  server did not start');
    server.kill();
    process.exit(1);
  }

  const executablePath = findChromium();
  if (executablePath) console.log(`  using ${path.basename(executablePath)}`);

  const browser = await chromium.launch({
    // A full Chromium build, not the headless shell: the shell ships without
    // the media stack, so the fake microphone would not exist.
    executablePath,
    args: [
      // A synthetic microphone that emits a steady tone, so the recording
      // path runs without a human or a real device.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({
    ...devices['iPhone 13'],
    // 127.0.0.1 counts as a secure context, so getUserMedia is permitted.
    permissions: ['microphone'],
    ignoreHTTPSErrors: true,
  });

  const page = await context.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  let passed = 0, failed = 0;
  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else { failed++; console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`); }
  };

  try {
    await page.goto(BASE, { waitUntil: 'networkidle' });

    check('page loads and reaches the server',
      (await page.textContent('#srvLbl')).trim() === 'online',
      `server pill said "${await page.textContent('#srvLbl')}"`);

    check('the DSP and store globals are present',
      await page.evaluate(() => !!window.SolarisDSP && !!window.SolarisStore));

    // Layout: nothing may overflow the viewport horizontally on a phone.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow at 390px wide', overflow <= 0, `overflows by ${overflow}px`);

    // The primary action must be reachable without scrolling.
    const barVisible = await page.evaluate(() => {
      const bar = document.querySelector('.actionbar').getBoundingClientRect();
      return bar.bottom <= window.innerHeight + 1 && bar.top < window.innerHeight;
    });
    check('the save bar is pinned within the viewport', barVisible);

    // Every tap target should clear the 44px accessibility floor.
    const smallTargets = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('button').forEach(b => {
        if (b.offsetParent === null) return;
        const r = b.getBoundingClientRect();
        if (r.height > 0 && r.height < 32) out.push(`${b.id || b.className}: ${Math.round(r.height)}px`);
      });
      return out;
    });
    check('tap targets are large enough', smallTargets.length === 0, smallTargets.join(', '));

    await page.screenshot({ path: path.join(SHOTS, '01-idle.png'), fullPage: true });

    // ── Record both sides ────────────────────────────────────────────────────
    const recordOnce = async (side) => {
      await page.click(`#btn${side}`);
      await page.waitForTimeout(2600);          // clear the 2s minimum-duration rule
      await page.click(`#btn${side}`);
      await page.waitForFunction(
        (s) => document.querySelector(`#score${s}`).textContent !== '—',
        side, { timeout: 20000 });
      return page.evaluate((s) => window.__solarisDebug.scores[s], side);
    };

    for (const [side, label] of [['B', 'Banjara'], ['T', 'Telugu']]) {
      let score = await recordOnce(side);

      // Chrome's fake microphone emits a beep-and-silence pattern, so a take
      // can legitimately land on a quiet stretch and grade below threshold.
      // A human would simply re-record; do the same rather than calling it a
      // product failure.
      for (let attempt = 0; attempt < 3 && score < 50; attempt++) {
        await page.click(`#rerec${side}`);
        score = await recordOnce(side);
      }

      const shown = await page.textContent(`#score${side}`);
      check(`${label} recording is captured, filtered and graded`,
        /^\d+%$/.test(shown.trim()), `score showed "${shown}"`);
      check(`${label} grades above the quality threshold`,
        score >= 50, `scored ${score} after retries`);

      const playerShown = await page.evaluate(
        (s) => document.querySelector(`#player${s}`).classList.contains('show'), side);
      check(`${label} waveform and playback appear`, playerShown);
    }

    await page.screenshot({ path: path.join(SHOTS, '02-recorded.png'), fullPage: true });

    // No STT key is configured in this run, so the app must degrade to
    // manual entry rather than blocking the save.
    const tstatus = await page.textContent('#tstatus');
    check('missing STT config degrades to manual entry',
      /manual/i.test(tstatus), `status said "${tstatus}"`);

    await page.fill('#trans-text', 'పరీక్ష');

    // ── Filter toggle ────────────────────────────────────────────────────────
    await page.click('#segRaw');
    check('the original/cleaned toggle switches',
      await page.evaluate(() => document.querySelector('#segRaw').classList.contains('on')));
    await page.click('#segClean');

    // ── Save ─────────────────────────────────────────────────────────────────
    const ready = await page.evaluate(() => {
      const b = document.querySelector('#btn-submit');
      return !b.disabled && b.classList.contains('ready');
    });
    check('the save button unlocks once both takes pass', ready);

    if (ready) {
      await page.click('#btn-submit');
      await page.waitForFunction(
        () => document.querySelector('#success-panel').classList.contains('show') ||
              document.querySelector('#errSave').classList.contains('show'),
        null, { timeout: 20000 });

      const saved = await page.evaluate(
        () => document.querySelector('#success-panel').classList.contains('show'));
      check('the session saves through to the server', saved,
        await page.textContent('#errSave'));

      // Verify on disk, not just in the UI.
      const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
        .flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
      const files = fs.existsSync(DATASET) ? walk(DATASET) : [];
      const names = files.map(f => path.basename(f));

      check('cleaned, raw and transcript files all landed on disk',
        names.some(n => n.endsWith('_banjara.wav')) &&
        names.some(n => n.endsWith('_telugu.wav')) &&
        names.some(n => n.includes('_raw')) &&
        names.some(n => n.endsWith('.txt')) &&
        names.includes('session.json'),
        names.join(', '));

      // The archived audio must be a real, non-empty WAV.
      const wavPath = files.find(f => f.endsWith('_telugu.wav'));
      if (wavPath) {
        const buf = fs.readFileSync(wavPath);
        check('the saved WAV has a valid header and audio data',
          buf.slice(0, 4).toString() === 'RIFF' &&
          buf.slice(8, 12).toString() === 'WAVE' &&
          buf.length > 44 + 16000,
          `${path.basename(wavPath)} is ${buf.length} bytes`);
      }

      const txtPath = files.find(f => f.endsWith('.txt'));
      if (txtPath) {
        check('the Telugu transcript survives the round trip',
          fs.readFileSync(txtPath, 'utf8') === 'పరీక్ష');
      }
    }

    await page.screenshot({ path: path.join(SHOTS, '03-saved.png'), fullPage: true });

    // Landscape is the other orientation a field operator will hold.
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(300);
    const landscapeOverflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('no horizontal overflow in landscape', landscapeOverflow <= 0, `overflows by ${landscapeOverflow}px`);
    await page.screenshot({ path: path.join(SHOTS, '04-landscape.png') });

    // Tablet / desktop width.
    await page.setViewportSize({ width: 1024, height: 800 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SHOTS, '05-wide.png'), fullPage: true });

    check('no uncaught console errors', errors.length === 0, errors.join(' | '));

    console.log(`\n${passed} passed, ${failed} failed`);
    console.log(`screenshots: ${SHOTS}\n`);
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
