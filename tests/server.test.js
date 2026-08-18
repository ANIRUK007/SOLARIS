/**
 * Integration tests for server.js. Run with: npm test
 *
 * Boots the real server on a spare port against a throwaway dataset
 * directory, then drives it over HTTP the same way the phone does.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
// path.resolve, not realpath: on macOS the temp dir is /var/... which is a
// symlink to /private/var/..., and the server reports the resolved-but-not-
// dereferenced path. Comparing the wrong one produces a false failure.
const DATASET = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-test-')));

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function wav(bytes) {
  // Not a real WAV, just a recognisable payload — the server stores bytes
  // verbatim and does not parse audio.
  return new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test('GET /health reports status and configured engines', async () => {
  const r = await fetch(BASE + '/health');
  const j = await r.json();
  assert.strictEqual(r.status, 200);
  assert.strictEqual(j.status, 'ok');
  assert.strictEqual(j.basePath, DATASET);
  // No keys were set for this run, so both engines report unavailable.
  assert.deepStrictEqual(j.engines, { sarvam: false, groq: false });
});

test('GET / serves the app, opening on the account screen', async () => {
  const r = await fetch(BASE + '/');
  const body = await r.text();
  assert.strictEqual(r.status, 200);
  assert.ok(r.headers.get('content-type').startsWith('text/html'));
  assert.ok(body.includes('SOLARIS'), 'expected the app shell');
  assert.ok(body.includes('app.js'), 'expected the app script tag');
  assert.ok(body.includes('screen-auth'), 'expected the account screen');
  assert.ok(body.includes('screen-portal'), 'expected the portal');
});

test('static assets are served from public/', async () => {
  for (const asset of ['dsp.js', 'store.js', 'auth.js', 'icons.js', 'theme.css', 'app.css', 'manifest.webmanifest']) {
    const r = await fetch(`${BASE}/${asset}`);
    assert.strictEqual(r.status, 200, `${asset} returned ${r.status}`);
  }
});

test('static serving refuses to escape the public directory', async () => {
  // server.js sits one level above public/ and must never be readable.
  const r = await fetch(BASE + '/../server.js', { redirect: 'manual' });
  assert.ok(r.status === 403 || r.status === 404, `expected refusal, got ${r.status}`);
  const body = await r.text();
  assert.ok(!body.includes('SARVAM_API_KEY'), 'server source leaked through static handler');
});

test('POST /save writes the three core files', async () => {
  const fd = new FormData();
  fd.append('folderPath', 'speakers/SPK001/sessions/session_01/అ');
  fd.append('banjara', wav([1, 2, 3]), 'a_banjara.wav');
  fd.append('telugu', wav([4, 5, 6]), 'a_telugu.wav');
  fd.append('transcript', new Blob(['నమస్కారం'], { type: 'text/plain' }), 'a_telugu.txt');
  fd.append('bnj_name', 'SPK001_అ_place_banjara.wav');
  fd.append('tel_name', 'SPK001_అ_place_telugu.wav');
  fd.append('txt_name', 'SPK001_అ_place_telugu.txt');

  const r = await fetch(BASE + '/save', { method: 'POST', body: fd });
  const j = await r.json();

  assert.strictEqual(r.status, 200, JSON.stringify(j));
  assert.strictEqual(j.success, true);
  assert.strictEqual(j.files.length, 3);

  const dir = path.join(DATASET, 'speakers', 'SPK001', 'sessions', 'session_01', 'అ');
  assert.ok(fs.existsSync(path.join(dir, 'SPK001_అ_place_banjara.wav')), 'banjara wav missing');
  assert.ok(fs.existsSync(path.join(dir, 'SPK001_అ_place_telugu.wav')), 'telugu wav missing');

  const txt = fs.readFileSync(path.join(dir, 'SPK001_అ_place_telugu.txt'), 'utf8');
  assert.strictEqual(txt, 'నమస్కారం', 'Telugu transcript did not survive the round trip');

  const bytes = fs.readFileSync(path.join(dir, 'SPK001_అ_place_banjara.wav'));
  assert.deepStrictEqual(Array.from(bytes), [1, 2, 3], 'audio bytes were altered');
});

test('POST /save also archives the raw takes and session metadata', async () => {
  const fd = new FormData();
  fd.append('folderPath', 'speakers/SPK002/sessions/session_01/క');
  fd.append('banjara', wav([9]), 'b.wav');
  fd.append('telugu', wav([9]), 't.wav');
  fd.append('transcript', new Blob(['x']), 't.txt');
  fd.append('bnj_name', 'b_clean.wav');
  fd.append('tel_name', 't_clean.wav');
  fd.append('txt_name', 't.txt');
  fd.append('banjara_raw', wav([7, 7]), 'b_raw.wav');
  fd.append('bnj_raw_name', 'b_raw.wav');
  fd.append('telugu_raw', wav([8, 8]), 't_raw.wav');
  fd.append('tel_raw_name', 't_raw.wav');
  fd.append('metadata', new Blob([JSON.stringify({ speaker: 'SPK002' })], { type: 'application/json' }), 'session.json');

  const r = await fetch(BASE + '/save', { method: 'POST', body: fd });
  const j = await r.json();

  assert.strictEqual(r.status, 200, JSON.stringify(j));
  assert.strictEqual(j.files.length, 6, `expected 6 files, got ${j.files.join(', ')}`);

  const dir = path.join(DATASET, 'speakers', 'SPK002', 'sessions', 'session_01', 'క');
  assert.ok(fs.existsSync(path.join(dir, 'b_raw.wav')), 'raw banjara missing');
  assert.ok(fs.existsSync(path.join(dir, 't_raw.wav')), 'raw telugu missing');

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8'));
  assert.strictEqual(meta.speaker, 'SPK002');
});

test('POST /save contains path traversal inside the dataset directory', async () => {
  const fd = new FormData();
  fd.append('folderPath', '../../../../../../tmp/solaris-escape');
  fd.append('banjara', wav([1]), 'a.wav');
  fd.append('telugu', wav([1]), 'b.wav');
  fd.append('transcript', new Blob(['x']), 'c.txt');
  fd.append('bnj_name', '../../escaped.wav');
  fd.append('tel_name', 'ok.wav');
  fd.append('txt_name', 'ok.txt');

  const r = await fetch(BASE + '/save', { method: 'POST', body: fd });
  const j = await r.json();

  assert.strictEqual(r.status, 200, JSON.stringify(j));
  // Both the folder and the filename must have been neutralised.
  assert.ok(j.savedTo.startsWith(DATASET), `escaped to ${j.savedTo}`);
  assert.ok(!fs.existsSync('/tmp/solaris-escape'), 'wrote outside the dataset directory');
  assert.ok(fs.existsSync(path.join(j.savedTo, 'escaped.wav')), 'filename was not flattened as expected');
});

test('POST /save rejects a request with missing fields', async () => {
  const fd = new FormData();
  fd.append('folderPath', 'speakers/X');
  const r = await fetch(BASE + '/save', { method: 'POST', body: fd });
  const j = await r.json();
  assert.strictEqual(r.status, 400);
  assert.match(j.error, /Missing required fields/);
});

test('POST /api/stt reports clearly when no key is configured', async () => {
  const fd = new FormData();
  fd.append('file', wav([1, 2]), 'audio.wav');
  fd.append('engine', 'sarvam');

  const r = await fetch(BASE + '/api/stt', { method: 'POST', body: fd });
  const j = await r.json();

  assert.strictEqual(r.status, 503);
  assert.match(j.error, /SARVAM_API_KEY/);
});

test('POST /api/stt rejects an unknown engine', async () => {
  const fd = new FormData();
  fd.append('file', wav([1]), 'audio.wav');
  fd.append('engine', 'definitely-not-real');

  const r = await fetch(BASE + '/api/stt', { method: 'POST', body: fd });
  assert.strictEqual(r.status, 400);
});

test('unknown routes return 404 JSON', async () => {
  const r = await fetch(BASE + '/nope');
  assert.strictEqual(r.status, 404);
  const j = await r.json();
  assert.match(j.error, /Cannot GET/);
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async function run() {
  console.log('\nserver.js');

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SOLARIS_DATASET_DIR: DATASET,
      // Isolate accounts: a store left over from another run would make these
      // requests require a token.
      SOLARIS_USERS_FILE: path.join(DATASET, 'users.json'),
      SARVAM_API_KEY: '',
      GROQ_API_KEY: '',
      // Force the file backend. Without this a developer's .env would point
      // the tests at the live project and they would write to it.
      SUPABASE_URL: '',
      SUPABASE_SERVICE_KEY: '',
      SSL_CERT: path.join(DATASET, 'no-cert'),   // force plain HTTP for the test
      SSL_KEY: path.join(DATASET, 'no-key'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });

  const up = await waitForServer(8000);
  if (!up) {
    console.error('  server did not start');
    if (stderr) console.error(stderr);
    child.kill();
    process.exit(1);
  }

  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(`       ${err.message}`);
      process.exitCode = 1;
    }
  }

  child.kill();
  fs.rmSync(DATASET, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed\n`);
})();
