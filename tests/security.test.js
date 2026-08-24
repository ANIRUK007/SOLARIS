/**
 * Tests for the things that keep this usable by people who are not us.
 * Run with: npm test
 *
 * Each of these corresponds to an attack that works on an app without it:
 * guessing a password until it lands, keeping a stolen session alive after the
 * password was changed, embedding the page in a frame to harvest taps, or
 * calling the API from another origin with a token that leaked.
 */
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RateLimiter, headers, passwordProblem, clientAddress } = require('../security.js');

const TMP = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-sec-')));
const PORT = 3188;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
const unit = [];
const test = (name, fn) => unit.push({ name, fn });

// ── Rate limiter ──────────────────────────────────────────────────────────────
test('a limiter allows up to its maximum and then refuses', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 3 });
  for (let i = 0; i < 3; i++) assert.ok(limiter.check('a').ok, `attempt ${i + 1} was refused`);

  const refused = limiter.check('a');
  assert.strictEqual(refused.ok, false);
  assert.ok(refused.retryAfter > 0, 'no retry-after was given');
});

test('one caller being limited does not affect another', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });
  limiter.check('a'); limiter.check('a'); limiter.check('a');
  assert.ok(limiter.check('b').ok, 'a second caller was punished for the first');
});

test('the window slides, so a limit is not permanent', () => {
  const limiter = new RateLimiter({ windowMs: 50, max: 2 });
  limiter.check('a'); limiter.check('a');
  assert.strictEqual(limiter.check('a').ok, false);

  return new Promise(resolve => setTimeout(() => {
    assert.ok(limiter.check('a').ok, 'the limit never lifted');
    resolve();
  }, 70));
});

test('clearing a key forgives earlier attempts', () => {
  const limiter = new RateLimiter({ windowMs: 60_000, max: 2 });
  limiter.check('a'); limiter.check('a');
  limiter.clear('a');
  assert.ok(limiter.check('a').ok, 'a successful sign-in did not reset the count');
});

// ── Headers ───────────────────────────────────────────────────────────────────
test('the page cannot be framed, sniffed or leaked through a referrer', () => {
  const h = headers(false);
  assert.strictEqual(h['X-Frame-Options'], 'DENY');
  assert.strictEqual(h['X-Content-Type-Options'], 'nosniff');
  assert.strictEqual(h['Referrer-Policy'], 'no-referrer');
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
});

test('the content policy blocks anything not served by this origin', () => {
  const csp = headers(false)['Content-Security-Policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  // The session token is in localStorage, so an injected script would be able
  // to read it. Inline script must not be allowed.
  assert.ok(!/script-src[^;]*unsafe-inline/.test(csp), 'inline script is permitted');
  assert.ok(!/script-src[^;]*unsafe-eval/.test(csp), 'eval is permitted');
});

test('recording still works under the policy', () => {
  const csp = headers(false)['Content-Security-Policy'];
  // Recorded audio is played back from a blob: URL, and waveforms are drawn
  // from data: URIs. A policy that forgot these would break the app.
  assert.match(csp, /media-src[^;]*blob:/);
  assert.match(csp, /img-src[^;]*data:/);
  assert.match(headers(false)['Permissions-Policy'], /microphone=\(self\)/);
});

test('HSTS is only sent over TLS', () => {
  assert.ok(!headers(false)['Strict-Transport-Security'],
    'HSTS on a plain response would pin a host with no certificate');
  assert.match(headers(true)['Strict-Transport-Security'], /max-age=\d+/);
});

// ── Passwords ─────────────────────────────────────────────────────────────────
test('short, common and self-referential passwords are refused', () => {
  assert.match(passwordProblem('short'), /at least 10/);
  assert.match(passwordProblem('password123'), /commonly used/);
  assert.match(passwordProblem('ravikumar99', { username: 'ravi' }), /your username/);
  assert.match(passwordProblem('aaaaaaaaaaaa'), /repeated character/);
  assert.match(passwordProblem('1234567890'), /commonly used|keyboard pattern/);
  assert.match(passwordProblem(''), /Enter a password/);
});

test('a long ordinary passphrase is accepted', () => {
  // Length is what makes a password hard to guess; rules demanding a symbol
  // mostly produce "Password1!".
  assert.strictEqual(passwordProblem('banjara recording project'), null);
  assert.strictEqual(passwordProblem('correct-horse-2026'), null);
});

// ── Proxy headers ─────────────────────────────────────────────────────────────
test('a forwarded-for header is ignored unless the server is behind a proxy', () => {
  const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: { remoteAddress: '10.0.0.9' } };
  // Trusting it by default would let anyone claim a fresh rate-limit quota.
  assert.strictEqual(clientAddress(req), '10.0.0.9');
  assert.strictEqual(clientAddress(req, { trustProxy: true }), '1.2.3.4');
});

// ── Server ────────────────────────────────────────────────────────────────────
const api = {
  post: async (p, body, token) => {
    const r = await fetch(BASE + p, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}),
      body: JSON.stringify(body),
    });
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  },
  get: async (p, token) => {
    const r = await fetch(BASE + p, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
    return { status: r.status, body: await r.json().catch(() => ({})), headers: r.headers };
  },
};

(async function run() {
  console.log('\nsecurity');

  for (const t of unit) {
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

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      SOLARIS_DATASET_DIR: path.join(TMP, 'dataset'),
      SOLARIS_USERS_FILE: path.join(TMP, 'users.json'),
      SOLARIS_WORD_INDEX: path.join(TMP, 'index.json'),
      SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
      SARVAM_API_KEY: '', GROQ_API_KEY: '',
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
    // ── Headers on a real response ───────────────────────────────────────────
    const page = await fetch(BASE + '/');
    check('the app is served with its defensive headers',
      page.headers.get('content-security-policy') &&
      page.headers.get('x-frame-options') === 'DENY',
      `csp=${!!page.headers.get('content-security-policy')} xfo=${page.headers.get('x-frame-options')}`);

    // ── What health tells a stranger ─────────────────────────────────────────
    const health = await api.get('/health');
    check('health does not leak the dataset path or the number of accounts',
      !('basePath' in health.body) && !('users' in (health.body.auth || {})),
      JSON.stringify(health.body));

    // ── Accounts ─────────────────────────────────────────────────────────────
    const first = await api.post('/api/auth/register',
      { username: 'ravi', password: 'first-account-2026', displayName: 'Ravi' });
    check('the first account can be created', first.status === 201, JSON.stringify(first.body));
    const token = first.body.token;

    const weak = await api.post('/api/auth/register', { username: 'weakling', password: 'password123' });
    check('a common password is refused at the API', weak.status === 400 && /commonly used/.test(weak.body.error),
      JSON.stringify(weak.body));

    // ── Brute force ──────────────────────────────────────────────────────────
    let locked = null;
    for (let i = 0; i < 12; i++) {
      const attempt = await api.post('/api/auth/login', { username: 'ravi', password: `guess-${i}-wrong` });
      if (attempt.status === 429) { locked = attempt; break; }
    }
    check('guessing a password is stopped before it can succeed', !!locked,
      'twelve wrong passwords in a row were all answered normally');
    check('the refusal says when to try again',
      locked && (locked.headers.get('retry-after') || /\d+ (second|minute)/.test(locked.body.error)),
      locked ? JSON.stringify(locked.body) : '');

    // ── Token revocation ─────────────────────────────────────────────────────
    const me = await api.get('/api/auth/me', token);
    check('a valid token identifies its owner', me.status === 200 && me.body.user.username === 'ravi');

    const changed = await api.post('/api/auth/password',
      { currentPassword: 'first-account-2026', newPassword: 'second-password-2026' }, token);
    check('a password can be changed', changed.status === 200 && !!changed.body.token,
      JSON.stringify(changed.body));

    const afterChange = await api.get('/api/auth/me', token);
    check('changing the password kills every token issued before it',
      afterChange.status === 401,
      `an old token still worked after the password changed (status ${afterChange.status})`);

    const withNew = await api.get('/api/auth/me', changed.body.token);
    check('the token handed back by the change still works', withNew.status === 200);

    const wrongCurrent = await api.post('/api/auth/password',
      { currentPassword: 'not-the-password', newPassword: 'another-password-2026' }, changed.body.token);
    check('a password change requires the current password', wrongCurrent.status === 401);

    // ── Sign out everywhere ──────────────────────────────────────────────────
    const signedOut = await api.post('/api/auth/signout-all', {}, changed.body.token);
    check('a session can be ended everywhere', signedOut.status === 200);
    check('the token stops working after signing out everywhere',
      (await api.get('/api/auth/me', changed.body.token)).status === 401);

    // ── Forged tokens ────────────────────────────────────────────────────────
    check('a made-up token is refused', (await api.get('/api/auth/me', 'not.a.token')).status === 401);
    check('an absent token is refused', (await api.get('/api/auth/me')).status === 401);

    // ── Cross-origin ─────────────────────────────────────────────────────────
    const cors = await fetch(BASE + '/health', { headers: { Origin: 'https://evil.example' } });
    check('another origin is not granted access',
      !cors.headers.get('access-control-allow-origin'),
      `allow-origin: ${cors.headers.get('access-control-allow-origin')}`);

    // ── HSTS behind a proxy ──────────────────────────────────────────────────
    // A hosted platform terminates TLS and forwards plain HTTP. Going by the
    // socket alone, a real deployment never sent HSTS at all — which is the
    // header that stops a first visit over http being intercepted.
    const spoofed = await fetch(BASE + '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    check('a forwarded-proto header is ignored when not behind a proxy',
      !spoofed.headers.get('strict-transport-security') &&
      (await spoofed.json()).secure === false,
      'the app claimed a secure origin on the strength of a header anyone can set');

    // The same request, against a server that has been told it is proxied.
    const proxied = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT + 1),
        SOLARIS_TRUST_PROXY: 'true',
        SOLARIS_DATASET_DIR: path.join(TMP, 'dataset2'),
        SOLARIS_USERS_FILE: path.join(TMP, 'users2.json'),
        SOLARIS_WORD_INDEX: path.join(TMP, 'index2.json'),
        SUPABASE_URL: '', SUPABASE_SERVICE_KEY: '',
        SSL_CERT: path.join(TMP, 'none'), SSL_KEY: path.join(TMP, 'none'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    try {
      const base2 = `http://127.0.0.1:${PORT + 1}`;
      for (let i = 0; i < 80; i++) {
        try { if ((await fetch(base2 + '/health')).ok) break; } catch {}
        await new Promise(r => setTimeout(r, 100));
      }

      const behind = await fetch(base2 + '/health', { headers: { 'X-Forwarded-Proto': 'https' } });
      check('HSTS is sent when a trusted proxy says the visitor came over TLS',
        /max-age=\d+/.test(behind.headers.get('strict-transport-security') || ''),
        `header was ${behind.headers.get('strict-transport-security')}`);
      check('the app reports itself secure behind a TLS-terminating proxy',
        (await behind.json()).secure === true);

      const plain = await fetch(base2 + '/health', { headers: { 'X-Forwarded-Proto': 'http' } });
      check('a proxied request that really was plain http gets no HSTS',
        !plain.headers.get('strict-transport-security'));
    } finally {
      proxied.kill();
    }

    // ── Oversized bodies ─────────────────────────────────────────────────────
    const huge = await fetch(BASE + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ravi', password: 'x'.repeat(400_000) }),
    });
    check('an oversized JSON body is refused rather than parsed', huge.status === 413,
      `status ${huge.status}`);
  } finally {
    server.kill();
    fs.rmSync(TMP, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed\n`);
})();
