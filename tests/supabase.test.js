/**
 * Tests for the Supabase backend. Run with: npm test
 *
 * These run against a stub PostgREST rather than a real project, so they need
 * no credentials and no network. That is the point: what can go wrong here is
 * the request this code builds — wrong table, wrong filter, a column name that
 * does not exist, a header Supabase needs and did not get — and every one of
 * those is visible in the request itself.
 *
 * What this cannot prove is that the schema in db/schema.sql matches. Applying
 * it and running once against a real project is still required.
 */
const assert = require('assert');
const http = require('http');
const { SupabaseDb } = require('../db.js');

let passed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

/**
 * A stand-in for PostgREST that records what it was asked and replies with
 * whatever the test queued up.
 */
function stub() {
  const seen = [];
  let reply = { status: 200, body: [] };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
      });

      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status, Object.assign(
        { 'Content-Type': 'application/json' }, reply.headers || {}));
      res.end(req.method === 'HEAD' ? undefined : payload);
    });
  });

  return {
    seen,
    server,
    setReply: (next) => { reply = next; },
    last: () => seen[seen.length - 1],
    listen: () => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test('a URL and a service key are both required', () => {
  assert.throws(() => new SupabaseDb({ url: 'https://x.supabase.co' }), /service key/);
  assert.throws(() => new SupabaseDb({ serviceKey: 'k' }), /URL/);
});

test('every request carries the key in both places PostgREST looks', async (db, s) => {
  s.setReply({ status: 200, body: [] });
  await db.words();

  const req = s.last();
  assert.strictEqual(req.headers.apikey, 'test-key');
  assert.strictEqual(req.headers.authorization, 'Bearer test-key');
});

test('words are fetched from the words table, active ones only', async (db, s) => {
  s.setReply({ status: 200, body: [{ id: 'tel_pl_001', category: 'places', te: 'ఇల్లు' }] });
  const words = await db.words();

  assert.strictEqual(words.length, 1);
  assert.ok(s.last().url.startsWith('/rest/v1/words?'), s.last().url);
  assert.match(s.last().url, /active=is\.true/, 'retired prompts would be handed out');
});

test('reference data is fetched once, not per request', async (db, s) => {
  s.setReply({ status: 200, body: [{ id: 'tel_pl_001', category: 'places' }] });
  await db.words();
  await db.words();
  await db.words();

  assert.strictEqual(s.seen.length, 1, `hit the network ${s.seen.length} times for static data`);
});

test('a word list longer than one page is fetched in full', async (db, s) => {
  // PostgREST caps a response at 1,000 rows. Without paging, a longer list
  // comes back truncated with no error at all, and the tail is never handed
  // to anyone — which is exactly what happened on the real project.
  let served = 0;
  const total = 1482;

  const originalListener = s.server.listeners('request')[0];
  s.server.removeAllListeners('request');
  s.server.on('request', (req, res) => {
    const offset = Number((req.url.match(/offset=(\d+)/) || [])[1] || 0);
    const limit = Number((req.url.match(/limit=(\d+)/) || [])[1] || 1000);
    const rows = [];
    for (let i = offset; i < Math.min(offset + limit, total); i++) {
      rows.push({ id: `w_${i}`, category: 'places', te: 'x' });
    }
    served += rows.length;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  });

  const words = await db.words();
  assert.strictEqual(words.length, total, `only ${words.length} of ${total} words were fetched`);
  assert.strictEqual(served, total);

  s.server.removeAllListeners('request');
  s.server.on('request', originalListener);
});

test('a contributor is looked up by exact username', async (db, s) => {
  s.setReply({ status: 200, body: [{ username: 'ravi', display_name: 'Ravi', xp: 40, words_count: 3 }] });
  const row = await db.findContributor('ravi');

  assert.match(s.last().url, /contributors\?.*username=eq\.ravi/, s.last().url);
  assert.strictEqual(row.username, 'ravi');
  assert.strictEqual(row.displayName, 'Ravi', 'snake_case column was not mapped');
  assert.deepStrictEqual(row.stats, { xp: 40, words: 3, streak: 0, bestStreak: 0 });
});

test('an unknown contributor comes back as null, not an empty row', async (db, s) => {
  s.setReply({ status: 200, body: [] });
  assert.strictEqual(await db.findContributor('nobody'), null);
});

test('creating a contributor writes the hash to its own column', async (db, s) => {
  s.setReply({ status: 201, body: [{ username: 'ravi', display_name: 'Ravi', password_hash: 'h' }] });
  await db.createContributor({
    username: 'ravi', displayName: 'Ravi', hash: 'h', salt: 's',
    createdAt: '2026-01-01T00:00:00Z',
  });

  const sent = s.last().body;
  assert.strictEqual(sent.password_hash, 'h');
  assert.strictEqual(sent.password_salt, 's');
  assert.strictEqual(sent.display_name, 'Ravi');
  assert.ok(!('hash' in sent), 'sent an application field Postgres has no column for');
});

test('an update patches only the columns it was given', async (db, s) => {
  s.setReply({ status: 200, body: [{ username: 'ravi', xp: 50, words_count: 4 }] });
  await db.updateContributor('ravi', { xp: 50, words: 4 });

  const req = s.last();
  assert.strictEqual(req.method, 'PATCH');
  assert.deepStrictEqual(req.body, { xp: 50, words_count: 4 });
  assert.match(req.url, /username=eq\.ravi/);
});

test('history is split into recorded and skipped', async (db, s) => {
  s.setReply({ status: 200, body: [
    { word_id: 'tel_pl_001', outcome: 'recorded' },
    { word_id: 'tel_pl_002', outcome: 'skipped' },
  ] });

  const history = await db.contributorHistory('ravi');
  assert.ok(history.recorded.has('tel_pl_001'));
  assert.ok(history.skipped.has('tel_pl_002'));
  assert.ok(!history.recorded.has('tel_pl_002'), 'a skip was counted as a recording');
});

test('coverage comes from the view, and only for words with voices', async (db, s) => {
  s.setReply({ status: 200, body: [{ word_id: 'tel_pl_001', voices: 2 }] });
  const coverage = await db.coverage();

  assert.match(s.last().url, /word_coverage/);
  assert.match(s.last().url, /voices=gt\.0/, 'pulling every uncovered word back wastes the round trip');
  assert.strictEqual(coverage.get('tel_pl_001'), 2);
});

test('a contribution is inserted with its outcome and quality', async (db, s) => {
  s.setReply({ status: 201, body: '' });
  const ok = await db.addContribution({
    contributor: 'ravi', wordId: 'tel_pl_001', outcome: 'recorded', quality: 88, xp: 19,
  });

  assert.strictEqual(ok, true);
  assert.strictEqual(s.last().body.word_id, 'tel_pl_001');
  assert.strictEqual(s.last().body.quality, 88);
  assert.strictEqual(s.last().body.xp_awarded, 19);
});

test('a repeat contribution is reported as already present, not as a crash', async (db, s) => {
  // The (contributor, word_id) primary key is what makes a repeat impossible;
  // the conflict is the answer to "have they done this already".
  s.setReply({ status: 409, body: { message: 'duplicate key value violates unique constraint' } });
  const ok = await db.addContribution({ contributor: 'ravi', wordId: 'tel_pl_001', outcome: 'recorded' });
  assert.strictEqual(ok, false);
});

test('a real failure is raised with what Postgres actually said', async (db, s) => {
  s.setReply({ status: 400, body: { message: 'column "nope" does not exist' } });
  await assert.rejects(
    () => db.addContribution({ contributor: 'ravi', wordId: 'tel_pl_001', outcome: 'recorded' }),
    // The body is JSON, so the quotes arrive escaped — match the text itself.
    /does not exist/,
    'the underlying error was swallowed');
});

test('the token secret is stored so a restart does not sign everyone out', async (db, s) => {
  s.setReply({ status: 200, body: [{ value: 'abc123' }] });
  assert.strictEqual(await db.secret(), 'abc123');

  s.setReply({ status: 201, body: '' });
  await db.setSecret('newsecret');
  assert.strictEqual(s.last().body.value, 'newsecret');
  assert.match(s.last().headers.prefer || '', /merge-duplicates/,
    'a second server writing its own secret would overwrite rather than merge');
});

test('the contributor count is asked for as a count, not a full table read', async (db, s) => {
  s.setReply({ status: 200, body: '', headers: { 'Content-Range': '0-0/7' } });
  const count = await db.countContributors();

  assert.strictEqual(count, 7);
  assert.strictEqual(s.last().method, 'HEAD', 'pulled every row back to count them');
});

test('a session log is written with its run sheet', async (db, s) => {
  s.setReply({ status: 201, body: '' });
  await db.addSession({
    contributor: 'ravi',
    category: 'places',
    startedAt: '2026-01-01T00:00:00Z',
    finishedAt: '2026-01-01T00:10:00Z',
    endedHow: 'quit',
    xp: 30, recorded: 2, skipped: 1,
    detail: [{ id: 'tel_pl_001', outcome: 'recorded' }],
  });

  const sent = s.last().body;
  assert.strictEqual(sent.ended_how, 'quit');
  assert.strictEqual(sent.recorded, 2);
  assert.ok(Array.isArray(sent.detail));
});

// ── Runner ────────────────────────────────────────────────────────────────────
(async function run() {
  console.log('\nsupabase backend');

  for (const t of tests) {
    const s = stub();
    let db;
    try {
      if (t.fn.length > 0) {
        const port = await s.listen();
        db = new SupabaseDb({ url: `http://127.0.0.1:${port}`, serviceKey: 'test-key' });
        await t.fn(db, s);
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

  console.log(`\n${passed}/${tests.length} passed\n`);
})();
