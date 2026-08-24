/**
 * Tests for where the audio goes. Run with: npm test
 *
 * The recordings are the one thing here that cannot be rebuilt from anything
 * else, so the failure that matters is a write that silently does not land —
 * or lands somewhere it should not.
 *
 * The Supabase half runs against a stub, so no credentials and no network.
 */
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DiskStorage, SupabaseStorage, open } = require('../storage.js');

const TMP = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-store-')));
let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function stub() {
  const seen = [];
  let reply = { status: 200, body: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(reply.status, { 'Content-Type': 'application/json' });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  return {
    seen, server,
    setReply: (r) => { reply = r; },
    last: () => seen[seen.length - 1],
    listen: () => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))),
    close: () => new Promise(r => server.close(r)),
  };
}

// ── Disk ──────────────────────────────────────────────────────────────────────
test('a file written to disk comes back byte for byte', async () => {
  const store = new DiskStorage({ root: path.join(TMP, 'disk1') });
  const bytes = Buffer.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3]);

  await store.put('contributors/ravi/places/tel_pl_001/take.wav', bytes);
  const back = await store.get('contributors/ravi/places/tel_pl_001/take.wav');
  assert.deepStrictEqual(back, bytes);
});

test('a missing file reads as null rather than throwing', async () => {
  const store = new DiskStorage({ root: path.join(TMP, 'disk2') });
  assert.strictEqual(await store.get('nothing/here.wav'), null);
});

test('a path cannot escape the dataset directory', async () => {
  const store = new DiskStorage({ root: path.join(TMP, 'disk3') });

  // The traversal is stripped rather than honoured, so the write lands inside.
  await store.put('../../escape.wav', Buffer.from('x'));
  assert.ok(!fs.existsSync(path.join(TMP, 'escape.wav')), 'wrote outside the root');
  assert.ok(fs.existsSync(path.join(TMP, 'disk3', 'escape.wav')));
});

test('listing walks the whole tree', async () => {
  const store = new DiskStorage({ root: path.join(TMP, 'disk4') });
  await store.put('contributors/ravi/places/a/take.wav', Buffer.from('a'));
  await store.put('contributors/ravi/animals/b/take.wav', Buffer.from('b'));
  await store.put('contributors/sita/places/c/take.wav', Buffer.from('c'));

  const all = await store.list();
  assert.strictEqual(all.length, 3, all.join(', '));

  const mine = await store.list('contributors/ravi');
  assert.strictEqual(mine.length, 2, mine.join(', '));
  // Keys are the same shape a bucket uses, so a folder and a bucket can be
  // mirrored to each other.
  assert.ok(all.every(k => !k.includes('\\\\')), `a listing used backslashes: ${all.join(', ')}`);
});

// ── Supabase Storage ──────────────────────────────────────────────────────────
test('a URL and a key are both required', () => {
  assert.throws(() => new SupabaseStorage({ url: 'https://x.supabase.co' }), /service key/);
});

test('an upload goes to the bucket with its content type', async (store, s) => {
  s.setReply({ status: 200, body: { Key: 'ok' } });
  await store.put('contributors/ravi/places/tel_pl_001/take.wav', Buffer.from('RIFF'), 'audio/wav');

  const req = s.last();
  assert.strictEqual(req.method, 'POST');
  assert.match(req.url, /^\/storage\/v1\/object\/recordings\//, req.url);
  assert.strictEqual(req.headers['content-type'], 'audio/wav');
  // Re-uploading the same take replaces it; the path already identifies it.
  assert.strictEqual(req.headers['x-upsert'], 'true');
  assert.strictEqual(req.body.toString(), 'RIFF');
});

test('a failed upload is raised, not swallowed', async (store, s) => {
  // A silently dropped recording is the worst outcome this code can produce.
  s.setReply({ status: 413, body: { message: 'Payload too large' } });
  await assert.rejects(() => store.put('a/b.wav', Buffer.from('x'), 'audio/wav'), /413|too large/i);
});

test('the bucket is created private, so voices are not on a public URL', async (store, s) => {
  s.setReply({ status: 404, body: { message: 'not found' } });
  await store.ensureBucket().catch(() => {});

  const created = s.seen.find(r => r.method === 'POST' && r.url.endsWith('/bucket'));
  assert.ok(created, 'no bucket was created');
  const body = JSON.parse(created.body.toString());
  assert.strictEqual(body.public, false,
    'a public bucket would put recordings of people on a guessable URL');
});

test('an existing bucket is left alone', async (store, s) => {
  s.setReply({ status: 200, body: { name: 'recordings' } });
  const created = await store.ensureBucket();
  assert.strictEqual(created, false);
  assert.strictEqual(s.seen.filter(r => r.method === 'POST').length, 0, 'tried to recreate it');
});

test('a download that is not there reads as null', async (store, s) => {
  s.setReply({ status: 404, body: { message: 'not found' } });
  assert.strictEqual(await store.get('missing.wav'), null);
});

test('a missing object is recognised even though Storage answers 400', async (store, s) => {
  // Supabase Storage returns HTTP 400 with the real status inside the body.
  // Trusting the HTTP status alone turned "no file here" into a hard failure
  // and stopped an export on the first recording with no raw take.
  s.setReply({ status: 400, body: { statusCode: '404', error: 'not_found', code: 'NoSuchKey' } });
  assert.strictEqual(await store.get('missing.wav'), null);
});

test('a genuine download failure is still raised', async (store, s) => {
  s.setReply({ status: 500, body: { message: 'internal error' } });
  await assert.rejects(() => store.get('a.wav'), /500|internal/i);
});

// ── Choosing a backend ────────────────────────────────────────────────────────
test('Supabase is used when configured, disk otherwise', () => {
  const root = path.join(TMP, 'choice');
  assert.strictEqual(open({}, { root }).name, 'disk');
  assert.strictEqual(
    open({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k' }, { root }).name,
    'supabase');
  // An explicit override, for a field laptop that has credentials but should
  // still keep its recordings locally.
  assert.strictEqual(
    open({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_KEY: 'k', SOLARIS_AUDIO: 'disk' }, { root }).name,
    'disk');
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async function run() {
  console.log('\nstorage');

  for (const t of tests) {
    const s = stub();
    try {
      if (t.fn.length > 0) {
        const port = await s.listen();
        const store = new SupabaseStorage({ url: `http://127.0.0.1:${port}`, serviceKey: 'k' });
        await t.fn(store, s);
      } else {
        await t.fn();
      }
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(`       ${err.message}`);
      process.exitCode = 1;
    } finally {
      await s.close().catch(() => {});
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed}/${tests.length} passed\n`);
})();
