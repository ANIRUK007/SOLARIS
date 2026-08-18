/**
 * Tests for accounts and the write guard. Run with: npm test
 *
 * Two halves: the Auth class on its own (hashing, tokens, tampering), and
 * the live server (registration rules, 401s, provenance stamping).
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Auth, levelFor } = require('../auth.js');
const { FileDb } = require('../db.js');

let passed = 0;
const unit = [];
const test = (name, fn) => unit.push({ name, fn });

const TMP = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-auth-')));
const PORT = 3193;
const BASE = `http://127.0.0.1:${PORT}`;
const DATASET = path.join(TMP, 'dataset');
const USERS = path.join(TMP, 'users.json');

const WORDS = path.join(__dirname, '..', 'data', 'words.json');

async function freshAuth(name) {
  const db = new FileDb({
    wordsFile: WORDS,
    usersFile: path.join(TMP, `unit-${name}.json`),
    indexFile: path.join(TMP, `unit-${name}-index.json`),
  });
  return new Auth(db).init();
}

// ── Unit: hashing and tokens ──────────────────────────────────────────────────
test('a registered password is never stored in the clear', async () => {
  const a = await freshAuth('store');
  await a.register({ username: 'ravi', password: 'correct horse battery' });

  const raw = fs.readFileSync(a.db.usersFile, 'utf8');
  assert.ok(!raw.includes('correct horse battery'), 'the password appears in the store file');

  const stored = await a.db.findContributor('ravi');
  assert.ok(stored.hash && stored.salt, 'no hash/salt recorded');
});

test('the same password hashes differently for two users', async () => {
  const a = await freshAuth('salts');
  await a.register({ username: 'one', password: 'sharedpassword' });
  await a.register({ username: 'two', password: 'sharedpassword' });
  // Distinct salts, so a leaked store cannot be cracked once for everyone.
  const [one, two] = [await a.db.findContributor('one'), await a.db.findContributor('two')];
  assert.notStrictEqual(one.hash, two.hash);
});

test('login succeeds with the right password and fails with the wrong one', async () => {
  const a = await freshAuth('login');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  const session = await a.login({ username: 'ravi', password: 'correcthorse' });
  assert.ok(session.token, 'no token issued');
  assert.strictEqual(session.user.username, 'ravi');

  await assert.rejects(() => a.login({ username: 'ravi', password: 'wrongpass1' }), /Incorrect/);
});

test('an unknown user and a wrong password report the same thing', async () => {
  const a = await freshAuth('enum');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  // Different messages would let someone enumerate valid usernames.
  const missing = await a.login({ username: 'nobody', password: 'x' }).catch(e => e.message);
  const wrong = await a.login({ username: 'ravi', password: 'x' }).catch(e => e.message);
  assert.strictEqual(missing, wrong);
});

test('usernames are case-insensitive and cannot be duplicated', async () => {
  const a = await freshAuth('dupe');
  await a.register({ username: 'Ravi', password: 'correcthorse' });
  await assert.rejects(() => a.register({ username: 'ravi', password: 'otherpass1' }), /already taken/);
  assert.ok((await a.login({ username: 'RAVI', password: 'correcthorse' })).token);
});

test('weak passwords and malformed usernames are refused', async () => {
  const a = await freshAuth('weak');
  await assert.rejects(() => a.register({ username: 'ravi', password: 'short' }), /at least 8/);
  await assert.rejects(() => a.register({ username: 'a', password: 'longenough1' }), /3-32/);
  await assert.rejects(() => a.register({ username: 'has space', password: 'longenough1' }), /3-32/);
});

test('a valid token identifies its user', async () => {
  const a = await freshAuth('token');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  const { token } = await a.login({ username: 'ravi', password: 'correcthorse' });
  assert.strictEqual(a.verifyToken(token), 'ravi');
});

test('a tampered token is rejected', async () => {
  const a = await freshAuth('tamper');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  const { token } = await a.login({ username: 'ravi', password: 'correcthorse' });
  const [body, sig] = token.split('.');

  // Re-sign a different username with the same signature: the HMAC must fail.
  const forged = Buffer.from(JSON.stringify({ u: 'admin', exp: Date.now() + 1e6 })).toString('base64url');
  assert.strictEqual(a.verifyToken(`${forged}.${sig}`), null, 'a forged payload was accepted');
  assert.strictEqual(a.verifyToken(`${body}.${sig}x`), null, 'a mangled signature was accepted');
  assert.strictEqual(a.verifyToken('garbage'), null);
  assert.strictEqual(a.verifyToken(''), null);
  assert.strictEqual(a.verifyToken(null), null);
});

test('an expired token is rejected', async () => {
  const a = await freshAuth('expiry');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  const expired = a._sign({ u: 'ravi', exp: Date.now() - 1000 });
  assert.strictEqual(a.verifyToken(expired), null);
});

test("a token signed by another server's secret is rejected", async () => {
  const a = await freshAuth('secret-a');
  const b = await freshAuth('secret-b');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  await b.register({ username: 'ravi', password: 'correcthorse' });
  const fromB = await b.login({ username: 'ravi', password: 'correcthorse' }).token;
  assert.strictEqual(a.verifyToken(fromB), null);
});

test('the public profile never exposes the hash or salt', async () => {
  const a = await freshAuth('public');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  const pub = await a.publicUser('ravi');
  assert.ok(!('hash' in pub) && !('salt' in pub), JSON.stringify(pub));
});

test('one contributed word counts immediately', async () => {
  const a = await freshAuth('oneword');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  const { profile, xp } = await a.recordWord('ravi', { score: 100, streak: 1 });
  assert.strictEqual(profile.stats.words, 1, 'a single word did not register');
  assert.ok(xp > 0, 'no XP was awarded');
  assert.strictEqual(profile.stats.xp, xp);
});

test('contributions accumulate word by word', async () => {
  const a = await freshAuth('stats');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  let total = 0;
  for (let i = 1; i <= 5; i++) total += (await a.recordWord('ravi', { score: 80, streak: i })).xp;

  const pub = await a.publicUser('ravi');
  assert.strictEqual(pub.stats.words, 5);
  assert.strictEqual(pub.stats.xp, total);
  assert.strictEqual(pub.level, levelFor(total));
  assert.strictEqual(pub.stats.streak, 5);
});

test('XP per word is computed by the server, within a fixed range', async () => {
  const a = await freshAuth('xprange');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  // A client claiming an enormous score or streak cannot inflate the award.
  const wild = await a.recordWord('ravi', { score: 99999, streak: 99999 });
  assert.ok(wild.xp <= 25, `awarded ${wild.xp} XP for a bogus claim`);

  const floorAward = await a.recordWord('ravi', { score: 0, streak: 0 });
  assert.ok(floorAward.xp >= 10, `awarded only ${floorAward.xp} XP for a valid word`);
});

test('opening and closing a word set with nothing recorded counts for nothing', async () => {
  const a = await freshAuth('nosessions');
  await a.register({ username: 'ravi', password: 'correcthorse' });
  await a.recordSession('ravi', { streak: 0 });

  const pub = await a.publicUser('ravi');
  assert.strictEqual(pub.stats.words, 0);
  assert.strictEqual(pub.stats.xp, 0);
  assert.ok(!('sessions' in pub.stats), 'sessions are still being counted');
});

test('finishing a set does not double-count the words already credited', async () => {
  const a = await freshAuth('nodouble');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  await a.recordWord('ravi', { score: 90, streak: 1 });
  await a.recordWord('ravi', { score: 90, streak: 2 });
  const afterWords = (await a.publicUser('ravi')).stats;

  await a.recordSession('ravi', { streak: 2 });
  const afterSession = (await a.publicUser('ravi')).stats;

  assert.strictEqual(afterSession.words, afterWords.words, 'words were counted twice');
  assert.strictEqual(afterSession.xp, afterWords.xp, 'XP was counted twice');
});

test('a streak survives between sittings and only resets when told to', async () => {
  const a = await freshAuth('streaks');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  await a.recordSession('ravi', { streak: 3 });
  assert.strictEqual((await a.publicUser('ravi')).stats.streak, 3);

  // A sitting that reports no streak change leaves it standing.
  await a.recordSession('ravi', {});
  assert.strictEqual((await a.publicUser('ravi')).stats.streak, 3, 'the streak was dropped without being told to');

  // A broken streak comes back as 0, but the best is remembered.
  await a.recordSession('ravi', { streak: 0 });
  assert.strictEqual((await a.publicUser('ravi')).stats.streak, 0);
  assert.strictEqual((await a.publicUser('ravi')).stats.bestStreak, 3);
});

test('a record written before streaks were persisted still loads', async () => {
  const a = await freshAuth('legacy-stats');
  await a.register({ username: 'ravi', password: 'correcthorse' });

  // Simulate the older shape: a stats object with a session tally and no streak.
  const row = await a.db.findContributor('ravi');
  row.stats = { xp: 240, sessions: 4, words: 9, bestStreak: 2 };

  const pub = await a.publicUser('ravi');
  assert.strictEqual(pub.stats.xp, 240);
  assert.strictEqual(pub.stats.words, 9);
  assert.strictEqual(pub.stats.streak, 0, 'a missing streak should read as zero');
  assert.ok(!('sessions' in pub.stats), 'the stale session count should be dropped');
});

test('accounts survive a restart', async () => {
  const files = {
    wordsFile: WORDS,
    usersFile: path.join(TMP, 'persist-users.json'),
    indexFile: path.join(TMP, 'persist-index.json'),
  };
  const first = await new Auth(new FileDb(files)).init();
  await first.register({ username: 'ravi', password: 'correcthorse' });

  const second = await new Auth(new FileDb(files)).init();
  const session = await second.login({ username: 'ravi', password: 'correcthorse' });
  assert.ok(session.token, 'could not log in after reloading the store');
  // The signing secret must be the same, or every existing token dies on
  // restart.
  assert.strictEqual(second.secret, first.secret, 'the token secret changed on restart');
});

// ── Server ────────────────────────────────────────────────────────────────────
const api = {
  post: async (p, body, token) => {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
  get: async (p, token) => {
    const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  },
};

function savePayload() {
  const fd = new FormData();
  fd.append('folderPath', 'speakers/SPK900/sessions/session_01/amma');
  fd.append('banjara', new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' }), 'a.wav');
  fd.append('transcript', new Blob(['అమ్మ']), 't.txt');
  fd.append('bnj_name', 'a_banjara.wav');
  fd.append('txt_name', 'a_telugu.txt');
  fd.append('metadata', new Blob([JSON.stringify({ speaker: 'SPK900', recordedBy: 'liar' })], { type: 'application/json' }), 'session.json');
  return fd;
}

(async function run() {
  console.log('\nauth');

  for (const t of unit) {
    try { await t.fn(); passed++; console.log(`  ok   ${t.name}`); }
    catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(`       ${err.message}`);
      process.exitCode = 1;
    }
  }

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SOLARIS_DATASET_DIR: DATASET,
      SOLARIS_USERS_FILE: USERS,
      SARVAM_API_KEY: '', GROQ_API_KEY: '',
      // Force the file backend. Without this a developer's .env would point
      // the tests at the live project and they would write to it.
      SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
      SSL_CERT: path.join(TMP, 'none'), SSL_KEY: path.join(TMP, 'none'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });

  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE + '/health')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }

  const check = (name, cond, detail) => {
    if (cond) { passed++; console.log(`  ok   ${name}`); }
    else {
      console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
      process.exitCode = 1;
    }
  };

  try {
    // Before anyone registers, the tools stay usable so the first user can
    // actually get in.
    let health = await api.get('/health');
    check('health reports no accounts yet', health.body.auth.required === false, JSON.stringify(health.body.auth));

    let save = await fetch(BASE + '/save', { method: 'POST', body: savePayload() });
    check('writes are allowed before any account exists', save.status === 200, `status ${save.status}`);

    // First registration bootstraps and signs in.
    const reg = await api.post('/api/auth/register', { username: 'ravi', password: 'correcthorse', displayName: 'Ravi K' });
    check('the first account can be created without a token', reg.status === 201, JSON.stringify(reg.body));
    check('registering returns a token', !!reg.body.token);
    check('registering returns a profile without secrets',
      reg.body.user && !('hash' in reg.body.user) && !('salt' in reg.body.user),
      JSON.stringify(reg.body.user));

    const token = reg.body.token;

    health = await api.get('/health');
    check('health now reports that sign-in is required', health.body.auth.required === true);

    // With an account in place, anonymous writes stop.
    save = await fetch(BASE + '/save', { method: 'POST', body: savePayload() });
    check('anonymous writes are refused once an account exists', save.status === 401, `status ${save.status}`);

    save = await fetch(BASE + '/save', { method: 'POST', body: savePayload(), headers: { Authorization: 'Bearer ' + token } });
    check('a signed-in write succeeds', save.status === 200, `status ${save.status}`);

    const saved = await save.clone().json().catch(() => ({}));
    check('saving one word credits it straight away',
      saved.profile && saved.profile.stats.words === 1 && saved.xp > 0,
      JSON.stringify({ xp: saved.xp, stats: saved.profile && saved.profile.stats }));

    // Provenance must come from the token, not from the client's claim.
    const metaPath = path.join(DATASET, 'speakers', 'SPK900', 'sessions', 'session_01', 'amma', 'session.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    check('the server stamps who recorded it, overriding the client', meta.recordedBy === 'ravi', JSON.stringify(meta.recordedBy));

    // Open registration would make the guard pointless.
    const second = await api.post('/api/auth/register', { username: 'stranger', password: 'letmein12345' });
    check('a stranger cannot self-register once an account exists', second.status === 403, `status ${second.status}`);

    const invited = await api.post('/api/auth/register', { username: 'teammate', password: 'letmein12345' }, token);
    check('a signed-in user can create an account for a teammate', invited.status === 201, JSON.stringify(invited.body));

    // Login and identity.
    const login = await api.post('/api/auth/login', { username: 'ravi', password: 'correcthorse' });
    check('login returns a token', login.status === 200 && !!login.body.token, JSON.stringify(login.body));

    const badLogin = await api.post('/api/auth/login', { username: 'ravi', password: 'nope' });
    check('a wrong password is refused', badLogin.status === 401);

    const me = await api.get('/api/auth/me', token);
    check('/api/auth/me identifies the signed-in user', me.body.user && me.body.user.username === 'ravi');

    const anon = await api.get('/api/auth/me');
    check('/api/auth/me refuses an anonymous caller', anon.status === 401);

    const forged = await api.get('/api/auth/me', 'not.a.real.token');
    check('a forged token is refused', forged.status === 401);

    // The session log rolls into lifetime stats.
    const log = await api.post('/api/session-log', {
      folder: 'speakers/SPK900/sessions/session_01',
      name: 'session_01_log.json',
      log: { xp: 240, streak: 4, totals: { recorded: 9 } },
    }, token);
    check('the session log is accepted and returns the profile',
      log.status === 200 && !!log.body.profile,
      JSON.stringify(log.body));

    check('the profile counts words contributed, not sessions opened',
      log.body.profile && !('sessions' in log.body.profile.stats),
      JSON.stringify(log.body.profile && log.body.profile.stats));

    const logAnon = await api.post('/api/session-log', { folder: 'x', name: 'y.json', log: {} });
    check('the session log refuses an anonymous caller', logAnon.status === 401);

    const stored = JSON.parse(fs.readFileSync(path.join(DATASET, 'speakers', 'SPK900', 'sessions', 'session_01', 'session_01_log.json'), 'utf8'));
    check('the stored log records who ran the session', stored.recordedBy === 'ravi', JSON.stringify(stored.recordedBy));

    // The store file must not be world-readable.
    const mode = fs.statSync(USERS).mode & 0o777;
    check('the account store is not readable by other users', (mode & 0o077) === 0, `mode ${mode.toString(8)}`);
  } finally {
    server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed\n`);
})();
