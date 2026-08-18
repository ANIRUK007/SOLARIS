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
const wordDb = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'words.json'), 'utf8'));

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
    const id = m[1];
    if (id.startsWith('screen-')) continue;
    if (!htmlIds.has(id)) missing.add(id);
  }

  // Screens are addressed as 'screen-' + name at runtime.
  for (const screen of ['screen-auth', 'screen-portal', 'screen-play', 'screen-done']) {
    if (!htmlIds.has(screen)) missing.add(screen);
  }

  assert.strictEqual(missing.size, 0, `missing from index.html: ${[...missing].join(', ')}`);
});

test('index.html loads the scripts it depends on, in order', () => {
  for (const src of ['icons.js', 'auth.js', 'dsp.js', 'store.js', 'app.js']) {
    assert.ok(html.includes(src), `index.html never loads ${src}`);
  }
  // dsp.js and store.js define globals that app.js uses at startup, so they
  // must be parsed first.
  assert.ok(html.indexOf('dsp.js') < html.indexOf('app.js'), 'dsp.js must load before app.js');
  assert.ok(html.indexOf('store.js') < html.indexOf('app.js'), 'store.js must load before app.js');
  assert.ok(html.indexOf('auth.js') < html.indexOf('app.js'), 'auth.js must load before app.js');
  assert.ok(html.indexOf('icons.js') < html.indexOf('app.js'), 'icons.js must load before app.js');
});

test('the interface uses drawn icons, not emoji', () => {
  const icons = require('../public/icons.js');
  // Emoji render differently on every platform, cannot take the colour of
  // what contains them, and blur at small sizes.
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

  const offenders = [];
  for (const [name, src] of [['index.html', html], ['app.js', app]]) {
    for (const line of src.split('\n')) {
      if (emoji.test(line)) offenders.push(`${name}: ${line.trim().slice(0, 60)}`);
    }
  }
  assert.strictEqual(offenders.length, 0, `emoji still in the interface:\n  ${offenders.join('\n  ')}`);

  // Every category must name an icon the sprite actually provides.
  const known = new Set(icons.names());
  for (const cat of wordDb.categories) {
    assert.ok(known.has(cat.icon), `${cat.id} asks for an unknown icon: ${cat.icon}`);
  }
});

test('viewport is configured for notched phones', () => {
  const tag = html.match(/<meta name="viewport"[^>]*>/);
  assert.ok(tag, 'no viewport meta tag');
  assert.ok(tag[0].includes('width=device-width'), 'viewport must scale to the device');
  assert.ok(tag[0].includes('viewport-fit=cover'), 'viewport-fit=cover is needed for safe-area insets');
  assert.ok(!/user-scalable\s*=\s*no/.test(tag[0]), 'pinch zoom must not be disabled — it is an accessibility requirement');
});

test('every text input is at least 16px so iOS does not zoom on focus', () => {
  const css = fs.readFileSync(path.join(pub, 'app.css'), 'utf8');
  const rules = [
    /\.field-group input, \.field-group select \{([\s\S]*?)\}/,
  ];
  for (const re of rules) {
    const block = css.match(re);
    assert.ok(block, `could not find an input rule matching ${re}`);
    const size = block[1].match(/font-size:\s*(\d+)px/);
    assert.ok(size && Number(size[1]) >= 16,
      `an input is ${size ? size[1] : '?'}px; iOS zooms the page below 16px`);
  }
});

test('no API keys are hard-coded in the client', () => {
  const files = fs.readdirSync(pub).filter(f => f.endsWith('.js') || f.endsWith('.html'));
  for (const [name, src] of files.map(f => [f, fs.readFileSync(path.join(pub, f), 'utf8')])) {
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

test('the word database is well formed', () => {
  assert.ok(wordDb.words.length > 1000, `only ${wordDb.words.length} words imported`);
  assert.ok(wordDb.categories.length, 'no categories');

  const ids = new Set();
  const counted = {};
  for (const word of wordDb.words) {
    assert.ok(word.id, `a word has no id: ${JSON.stringify(word)}`);
    assert.ok(!ids.has(word.id), `duplicate word id: ${word.id}`);
    ids.add(word.id);
    // Ids become directory names on disk.
    assert.ok(/^[a-z0-9_-]+$/.test(word.id), `${word.id} is not safe as a folder name`);
    // A prompt that is not actually Telugu is a broken prompt.
    assert.ok(/[\u0C00-\u0C7F]/.test(word.te || ''), `${word.id} contains no Telugu characters`);
    counted[word.category] = (counted[word.category] || 0) + 1;
  }

  for (const cat of wordDb.categories) {
    assert.strictEqual(cat.count, counted[cat.id] || 0,
      `${cat.id}: header says ${cat.count}, the list holds ${counted[cat.id] || 0}`);
  }
});

test('the app does not call a speech-to-text service', () => {
  // The prompt is the transcript; reaching for STT here would be a regression.
  assert.ok(!/api\/stt/.test(app), 'app.js calls the STT proxy, but the prompt already is the transcript');
});

test('the app is gated behind the account screen', () => {
  assert.ok(/decideStartScreen/.test(app), 'no start-screen decision exists');
  // Every path with no valid session must land on the auth screen.
  const fn = app.slice(app.indexOf('async function decideStartScreen'));
  const body = fn.slice(0, fn.indexOf('\n  }'));
  assert.ok(/show\('auth'\)/.test(body), 'the start-screen decision never shows the auth screen');

  // The portal may only be shown from inside the signed-in branch. Whatever
  // the function does last, with no valid session, must be the auth screen.
  const calls = [...body.matchAll(/show\('(\w+)'\)/g)].map(m => m[1]);
  assert.strictEqual(calls[calls.length - 1], 'auth',
    `the last routing decision is show('${calls[calls.length - 1]}'), so an unauthenticated visitor can land past the gate`);
  const portalIndex = body.indexOf("show('portal')");
  assert.ok(portalIndex === -1 || body.lastIndexOf('isSignedIn', portalIndex) !== -1,
    'the portal is shown without checking for a session first');
});

console.log(`\n${passed} passed\n`);
