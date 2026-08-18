/**
 * Throwaway diagnostic: record once in a real browser and dump the grading
 * numbers. Not part of the suite.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');

const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
const DATASET = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-probe-')));

function findChromium() {
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
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

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SOLARIS_DATASET_DIR: DATASET, SARVAM_API_KEY: '', GROQ_API_KEY: '', SSL_CERT: '/nope', SSL_KEY: '/nope' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  const browser = await chromium.launch({
    executablePath: findChromium(),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const ctx = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const page = await ctx.newPage();
  page.on('pageerror', e => console.log('PAGEERROR', e.message));
  await page.goto(BASE, { waitUntil: 'networkidle' });

  for (const side of ['B', 'T']) {
    await page.click(`#btn${side}`);
    await page.waitForTimeout(2600);
    await page.click(`#btn${side}`);
    await page.waitForFunction(
      (s) => document.querySelector(`#score${s}`).textContent !== '—',
      side, { timeout: 20000 });
  }

  const dump = await page.evaluate(() => {
    const out = {};
    for (const side of ['B', 'T']) {
      out[side] = {
        score: document.querySelector(`#score${side}`).textContent,
        metrics: [...document.querySelectorAll(`#metrics${side} .cm`)].map(e => e.textContent),
      };
    }
    out.stateScores = window.__solarisDebug.scores;
    out.submitDisabled = document.querySelector('#btn-submit').disabled;
    return out;
  });
  console.log('BOTH SIDES:', JSON.stringify(dump, null, 2));

  const dump2 = await page.evaluate(() => {
    const rec = window.__solarisDebug ? window.__solarisDebug.rec.B : null;
    const stats = (arr) => {
      let ss = 0, peak = 0, clip = 0;
      for (let i = 0; i < arr.length; i++) { ss += arr[i] * arr[i]; peak = Math.max(peak, Math.abs(arr[i])); if (Math.abs(arr[i]) >= 0.99) clip++; }
      return { rms: Math.sqrt(ss / arr.length), peak, clipRatio: clip / arr.length, len: arr.length };
    };
    return {
      scoreText: document.querySelector('#scoreB').textContent,
      metrics: [...document.querySelectorAll('#metricsB .cm')].map(e => `${e.textContent}[${e.className.includes('bad') ? 'BAD' : 'ok'}]`),
      raw: rec ? stats(rec.samples) : null,
      cleaned: rec ? stats(rec.cleanedSamples) : null,
      duration: rec ? rec.duration : null,
      sampleRate: rec ? rec.sampleRate : null,
    };
  });

  console.log("B DETAIL:", JSON.stringify(dump2, null, 2));

  await browser.close();
  server.kill();
  fs.rmSync(DATASET, { recursive: true, force: true });
})();
