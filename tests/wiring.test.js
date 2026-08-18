/**
 * Static wiring checks for the front end. Run with: npm test
 *
 * There is no DOM in this test environment, so instead of rendering the page
 * we check the contract between app.js and index.html: every element id the
 * script reaches for must actually exist in the markup. A typo there is
 * silent in the browser until the moment a field operator taps the button.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const pub = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(pub, 'app.js'), 'utf8');
const sw = fs.readFileSync(path.join(pub, 'sw.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(pub, 'manifest.webmanifest'), 'utf8'));
const playHtml = fs.readFileSync(path.join(pub, 'play.html'), 'utf8');
const playJs = fs.readFileSync(path.join(pub, 'play.js'), 'utf8');
const pack = JSON.parse(fs.readFileSync(path.join(pub, 'packs', 'starter.json'), 'utf8'));

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

console.log('\nfront-end wiring');

test('every id used by app.js exists in index.html', () => {
  const missing = new Set();

  // Direct lookups: $('some-id')
  for (const m of app.matchAll(/\$\('([^']+)'\)/g)) {
    if (!htmlIds.has(m[1])) missing.add(m[1]);
  }

  // Per-side lookups: $('btn' + side) etc., which resolve to two ids each.
  for (const m of app.matchAll(/\$\('([a-zA-Z-]+)'\s*\+\s*side\)/g)) {
    for (const side of ['B', 'T']) {
      if (!htmlIds.has(m[1] + side)) missing.add(m[1] + side);
    }
  }

  assert.strictEqual(missing.size, 0, `missing from index.html: ${[...missing].join(', ')}`);
});

test('index.html loads the three scripts it depends on', () => {
  for (const src of ['dsp.js', 'store.js', 'app.js']) {
    assert.ok(html.includes(src), `index.html never loads ${src}`);
  }
  // dsp.js and store.js define globals that app.js uses at startup, so they
  // must be parsed first.
  assert.ok(html.indexOf('dsp.js') < html.indexOf('app.js'), 'dsp.js must load before app.js');
  assert.ok(html.indexOf('store.js') < html.indexOf('app.js'), 'store.js must load before app.js');
});

test('viewport is configured for notched phones', () => {
  const tag = html.match(/<meta name="viewport"[^>]*>/);
  assert.ok(tag, 'no viewport meta tag');
  assert.ok(tag[0].includes('width=device-width'), 'viewport must scale to the device');
  assert.ok(tag[0].includes('viewport-fit=cover'), 'viewport-fit=cover is needed for safe-area insets');
  assert.ok(!/user-scalable\s*=\s*no/.test(tag[0]), 'pinch zoom must not be disabled — it is an accessibility requirement');
});

test('text inputs are at least 16px so iOS does not zoom on focus', () => {
  const css = fs.readFileSync(path.join(pub, 'styles.css'), 'utf8');
  const block = css.match(/\.field input,[\s\S]*?\{([\s\S]*?)\}/);
  assert.ok(block, 'could not find the shared input rule');
  const size = block[1].match(/font-size:\s*(\d+)px/);
  assert.ok(size, 'inputs have no explicit font-size');
  assert.ok(Number(size[1]) >= 16, `inputs are ${size[1]}px; iOS zooms the page below 16px`);
});

test('no API keys are hard-coded in the client', () => {
  for (const [name, src] of [['app.js', app], ['index.html', html], ['store.js', fs.readFileSync(path.join(pub, 'store.js'), 'utf8')]]) {
    assert.ok(!/sk_[a-z0-9_]{10,}/i.test(src), `${name} contains what looks like a Sarvam key`);
    assert.ok(!/gsk_[A-Za-z0-9]{20,}/.test(src), `${name} contains what looks like a Groq key`);
    assert.ok(!/api-subscription-key/.test(src), `${name} calls the STT provider directly instead of the server proxy`);
  }
});

test('the client records through a codec Safari supports', () => {
  assert.ok(app.includes('audio/mp4'), 'no MP4/AAC fallback — recording throws on every iPhone');
  assert.ok(app.includes('isTypeSupported'), 'codec support is not being feature-detected');
});

test('the service worker never caches uploads or health checks', () => {
  assert.ok(sw.includes("/api/"), 'API routes are not excluded from the cache');
  assert.ok(sw.includes('/save'), 'the save route is not excluded from the cache');
  assert.ok(sw.includes("req.method !== 'GET'"), 'non-GET requests are not excluded from the cache');
});

test('manifest is installable', () => {
  assert.ok(manifest.name && manifest.short_name, 'name fields are required to install');
  assert.strictEqual(manifest.display, 'standalone');
  assert.ok(manifest.start_url, 'start_url is required');
  assert.ok(manifest.icons && manifest.icons.length > 0, 'at least one icon is required');
  assert.ok(fs.existsSync(path.join(pub, manifest.icons[0].src)), 'the declared icon file is missing');
});

test('every file the service worker precaches exists', () => {
  const list = sw.match(/const SHELL = \[([\s\S]*?)\]/);
  assert.ok(list, 'could not find the precache list');
  for (const m of list[1].matchAll(/'([^']+)'/g)) {
    if (m[1] === './') continue;
    assert.ok(fs.existsSync(path.join(pub, m[1])), `precached file is missing: ${m[1]}`);
  }
});

// ── Word session ──────────────────────────────────────────────────────────────
const playIds = new Set([...playHtml.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

test('every id used by play.js exists in play.html', () => {
  const missing = new Set();
  for (const m of playJs.matchAll(/\$\('([^']+)'\)/g)) {
    const id = m[1];
    // Screens are addressed as 'screen-' + name at runtime.
    if (id.startsWith('screen-')) continue;
    if (!playIds.has(id)) missing.add(id);
  }
  for (const screen of ['screen-setup', 'screen-play', 'screen-done']) {
    if (!playIds.has(screen)) missing.add(screen);
  }
  assert.strictEqual(missing.size, 0, `missing from play.html: ${[...missing].join(', ')}`);
});

test('play.html loads its dependencies in order', () => {
  for (const src of ['dsp.js', 'store.js', 'play.js']) {
    assert.ok(playHtml.includes(src), `play.html never loads ${src}`);
  }
  assert.ok(playHtml.indexOf('dsp.js') < playHtml.indexOf('play.js'), 'dsp.js must load before play.js');
  assert.ok(playHtml.indexOf('store.js') < playHtml.indexOf('play.js'), 'store.js must load before play.js');
});

test('the word pack is well formed', () => {
  assert.ok(pack.items.length > 0, 'pack has no items');
  const ids = new Set();
  for (const item of pack.items) {
    assert.ok(item.id, `an item is missing an id: ${JSON.stringify(item)}`);
    assert.ok(!ids.has(item.id), `duplicate prompt id: ${item.id}`);
    ids.add(item.id);
    assert.ok(item.te && item.te.trim(), `${item.id} has no Telugu text`);
    // Prompt ids become directory names on disk.
    assert.ok(/^[a-z0-9_-]+$/.test(item.id), `${item.id} is not safe as a folder name`);
    // Telugu text must actually be in the Telugu block, or the prompt is wrong.
    assert.ok(/[\u0C00-\u0C7F]/.test(item.te), `${item.id} does not contain Telugu characters`);
  }
});

test('play inputs are at least 16px so iOS does not zoom on focus', () => {
  const css = fs.readFileSync(path.join(pub, 'play.css'), 'utf8');
  const block = css.match(/\.field-group input, \.field-group select \{([\s\S]*?)\}/);
  assert.ok(block, 'could not find the play input rule');
  const size = block[1].match(/font-size:\s*(\d+)px/);
  assert.ok(size && Number(size[1]) >= 16, `play inputs are ${size ? size[1] : '?'}px`);
});

test('the game does not call a speech-to-text service', () => {
  // The prompt is the transcript; reaching for STT here would be a regression.
  assert.ok(!/api\/stt/.test(playJs), 'play.js calls the STT proxy, but the prompt already is the transcript');
});

console.log(`\n${passed} passed\n`);
