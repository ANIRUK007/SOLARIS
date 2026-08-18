/**
 * SOLARIS — data collection server (mobile-capable)
 *
 * Differences from the original localhost-only server:
 *   - binds 0.0.0.0 so phones on the same Wi-Fi can reach it
 *   - dataset path is cross-platform and configurable (SOLARIS_DATASET_DIR)
 *   - optional HTTPS, which browsers require before granting microphone
 *     access to any origin that is not localhost
 *   - proxies speech-to-text so API keys stay on the server, never in
 *     the page source
 *
 * Config (all optional, read from env or a .env file next to this file):
 *   PORT                  default 3001
 *   SOLARIS_DATASET_DIR   default ./dataset
 *   SARVAM_API_KEY        enables the Sarvam engine
 *   GROQ_API_KEY          enables the Groq engine
 *   SARVAM_MODEL          default saarika:v2.5
 *   GROQ_MODEL            default whisper-large-v3-turbo
 *   SSL_CERT / SSL_KEY    paths to a cert/key pair; defaults to ./certs/*
 */

const { Auth, levelFor, xpForLevel } = require('./auth.js');
const { Words } = require('./words.js');
const { open: openDb } = require('./db.js');

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');

// ── .env loading (no dependency) ──────────────────────────────────────────────
(function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
})();

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT       = Number(process.env.PORT || 3001);
const BASE_PATH  = path.resolve(process.env.SOLARIS_DATASET_DIR || path.join(__dirname, 'dataset'));
const PUBLIC_DIR = path.join(__dirname, 'public');

const STT = {
  sarvam: { key: process.env.SARVAM_API_KEY || '', model: process.env.SARVAM_MODEL || 'saarika:v2.5' },
  groq:   { key: process.env.GROQ_API_KEY   || '', model: process.env.GROQ_MODEL   || 'whisper-large-v3-turbo' },
};

const SSL_CERT = process.env.SSL_CERT || path.join(__dirname, 'certs', 'cert.pem');
const SSL_KEY  = process.env.SSL_KEY  || path.join(__dirname, 'certs', 'key.pem');

const MAX_BODY_BYTES = 60 * 1024 * 1024;   // one session is a few hundred KB; this is slack

// Supabase when it is configured, JSON files otherwise. Recording happens
// where the network does not reach, so a field laptop with no cloud has to
// remain a supported way to run rather than an error.
const db = openDb(process.env, {
  wordsFile: process.env.SOLARIS_WORDS_FILE || path.join(__dirname, 'data', 'words.json'),
  usersFile: process.env.SOLARIS_USERS_FILE || path.join(__dirname, '.solaris-users.json'),
  indexFile: process.env.SOLARIS_WORD_INDEX || path.join(__dirname, '.solaris-words.json'),
});

const auth = new Auth(db);
const words = new Words(db);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function mkdirSafe(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function setCORS(res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

/** Read a request body into a Buffer, refusing anything over the cap. */
function readBody(req, res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        sendJSON(res, 413, { error: 'Payload too large' });
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

/** Every non-loopback IPv4 address, so the console can print a URL for the phone. */
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** Pull a bearer token off the request, from the header or a query string
 *  (the latter so a plain <a> can carry one if it ever needs to). */
function bearer(req) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = req.url.split('?')[1];
  if (q) {
    const found = new URLSearchParams(q).get('token');
    if (found) return found;
  }
  return null;
}

/**
 * Who is making this request.
 *
 * Before anyone has registered, the server is still being set up, so writes
 * are allowed unauthenticated — otherwise the first user could never get in.
 * As soon as an account exists, writes require a valid token.
 *
 * @returns {{ok: true, user: string|null} | {ok: false}}
 */
function requireUser(req, res) {
  const username = auth.verifyToken(bearer(req));
  if (username) return { ok: true, user: username };

  if (!auth.isBootstrapped) return { ok: true, user: null };

  sendJSON(res, 401, { error: 'Sign in to continue.', code: 'auth_required' });
  return { ok: false };
}

// ── Multipart parser ──────────────────────────────────────────────────────────
function parseMultipart(body, boundary) {
  const parts = [];
  const sep   = Buffer.from('\r\n--' + boundary);
  const start = Buffer.from('--' + boundary);

  let pos = body.indexOf(start);
  if (pos === -1) return parts;
  pos += start.length;

  while (pos < body.length) {
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;

    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;

    const headerStr = body.slice(pos, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;

    const nextBnd = body.indexOf(sep, dataStart);
    const dataEnd = nextBnd === -1 ? body.length : nextBnd;
    const data    = body.slice(dataStart, dataEnd);

    const nameMatch     = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const typeMatch     = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      parts.push({
        name:     nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        type:     typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
        data,
      });
    }

    if (nextBnd === -1) break;
    pos = nextBnd + sep.length;
  }
  return parts;
}

// ── Path safety ───────────────────────────────────────────────────────────────
/**
 * Turn a client-supplied relative folder into an absolute path that is
 * guaranteed to sit inside BASE_PATH. Accepts either separator style, since
 * the browser may be on Windows, macOS, Android or iOS.
 */
function resolveInsideBase(relFolder) {
  const cleaned = String(relFolder)
    .replace(/\\/g, '/')
    .split('/')
    .map(seg => seg.trim())
    .filter(seg => seg && seg !== '.' && seg !== '..')
    .map(seg => seg.replace(/[<>:"|?*\x00-\x1f]/g, '_'))
    .join(path.sep);

  const abs = path.resolve(BASE_PATH, cleaned);
  if (abs !== BASE_PATH && !abs.startsWith(BASE_PATH + path.sep)) return null;
  return abs;
}

/** Filenames come from the client; strip anything that could escape the folder. */
function safeName(name, fallback) {
  const base  = path.basename(String(name || '').replace(/\\/g, '/')).trim();
  const clean = base.replace(/[<>:"|?*\x00-\x1f/\\]/g, '_');
  return clean && clean !== '.' && clean !== '..' ? clean : fallback;
}

// ── Static files ──────────────────────────────────────────────────────────────
function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(PUBLIC_DIR, rel);

  if (abs !== PUBLIC_DIR && !abs.startsWith(PUBLIC_DIR + path.sep)) {
    sendJSON(res, 403, { error: 'Forbidden' });
    return true;
  }
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;

  const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
  // The service worker must never be cached, or updates never reach the phone.
  const cache = rel === 'sw.js' ? 'no-cache' : 'no-store';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
  res.end(fs.readFileSync(abs));
  return true;
}

// ── Speech-to-text proxy ──────────────────────────────────────────────────────
async function handleSTT(req, res) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=("?)(.+)\1$/);
  if (!bm) return sendJSON(res, 400, { error: 'No multipart boundary in Content-Type' });

  let body;
  try { body = await readBody(req, res); } catch { return; }

  const parts  = parseMultipart(body, bm[2].trim());
  const engine = parts.find(p => p.name === 'engine')?.data.toString('utf8').trim() || 'sarvam';
  const audio  = parts.find(p => p.name === 'file');

  if (!audio)       return sendJSON(res, 400, { error: 'No audio file in request' });
  if (!STT[engine]) return sendJSON(res, 400, { error: `Unknown STT engine "${engine}"` });
  if (!STT[engine].key) {
    return sendJSON(res, 503, {
      error: `${engine} is not configured on the server. Set ${engine.toUpperCase()}_API_KEY in .env and restart.`,
    });
  }

  const filename = audio.filename || 'audio.wav';
  const blob = new Blob([audio.data], { type: audio.type || 'audio/wav' });

  try {
    const text = engine === 'sarvam'
      ? await sttSarvam(blob, filename)
      : await sttGroq(blob, filename);
    sendJSON(res, 200, { transcript: text, engine });
  } catch (err) {
    console.error('[STT ERR]', err.message);
    sendJSON(res, 502, { error: err.message });
  }
}

async function sttSarvam(blob, filename) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', STT.sarvam.model);
  fd.append('language_code', 'te-IN');
  fd.append('with_timestamps', 'false');

  const r = await fetch('https://api.sarvam.ai/speech-to-text', {
    method: 'POST',
    headers: { 'api-subscription-key': STT.sarvam.key },
    body: fd,
  });
  if (!r.ok) throw new Error(`Sarvam ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d.transcript || d.text || '';
}

async function sttGroq(blob, filename) {
  const fd = new FormData();
  fd.append('file', blob, filename);
  fd.append('model', STT.groq.model);
  fd.append('language', 'te');
  fd.append('response_format', 'json');

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${STT.groq.key}` },
    body: fd,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d = await r.json();
  return d.text || '';
}

// ── Save handler ──────────────────────────────────────────────────────────────
async function handleSave(req, res, username) {
  const ct = req.headers['content-type'] || '';
  const bm = ct.match(/boundary=("?)(.+)\1$/);
  if (!bm) return sendJSON(res, 400, { error: 'No multipart boundary in Content-Type' });

  let body;
  try { body = await readBody(req, res); } catch { return; }

  const parts = parseMultipart(body, bm[2].trim());
  const get   = name => parts.find(p => p.name === name);

  const folderPathPart = get('folderPath');
  const banjaraPart    = get('banjara');
  const teluguPart     = get('telugu');
  const transcriptPart = get('transcript');

  // Telugu audio is optional. In the prompt-driven capture flow the Telugu
  // side is written text shown to the speaker, and only the Banjara response
  // is recorded; there is no Telugu take to send.
  if (!folderPathPart || !banjaraPart || !transcriptPart) {
    console.error('[SAVE] Missing fields. Got parts:', parts.map(p => p.name));
    return sendJSON(res, 400, {
      error: 'Missing required fields (folderPath, banjara and transcript are required)',
      received: parts.map(p => p.name),
    });
  }

  const saveDir = resolveInsideBase(folderPathPart.data.toString('utf8'));
  if (!saveDir) return sendJSON(res, 400, { error: 'Invalid folder path' });
  mkdirSafe(saveDir);

  const bnjPath = path.join(saveDir, safeName(get('bnj_name')?.data.toString('utf8'), 'banjara.wav'));
  const txtPath = path.join(saveDir, safeName(get('txt_name')?.data.toString('utf8'), 'telugu.txt'));

  fs.writeFileSync(bnjPath, banjaraPart.data);
  fs.writeFileSync(txtPath, transcriptPart.data.toString('utf8'));

  const written = [path.basename(bnjPath), path.basename(txtPath)];

  if (teluguPart) {
    const telPath = path.join(saveDir, safeName(get('tel_name')?.data.toString('utf8'), 'telugu.wav'));
    fs.writeFileSync(telPath, teluguPart.data);
    written.push(path.basename(telPath));
  }

  // Optional extras. The client sends the unfiltered takes so the archive
  // keeps the source audio, plus a session.json describing how the cleaned
  // version was produced.
  const extras = [
    ['banjara_raw', 'bnj_raw_name', 'banjara_raw.wav'],
    ['telugu_raw',  'tel_raw_name', 'telugu_raw.wav'],
  ];
  for (const [field, nameField, fallback] of extras) {
    const part = get(field);
    if (!part) continue;
    const target = path.join(saveDir, safeName(get(nameField)?.data.toString('utf8'), fallback));
    fs.writeFileSync(target, part.data);
    written.push(path.basename(target));
  }

  let parsedMeta = null;

  const metaPart = get('metadata');
  if (metaPart) {
    // Stamp the signed-in user server-side. Provenance the client could edit
    // is not provenance.
    let meta;
    try { meta = JSON.parse(metaPart.data.toString('utf8')); }
    catch { meta = { raw: metaPart.data.toString('utf8') }; }
    meta.recordedBy = username || null;
    meta.receivedAt = new Date().toISOString();
    parsedMeta = meta;

    const metaPath = path.join(saveDir, 'session.json');
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    written.push('session.json');
  }

  // Credit the contribution now, not when the set is finished.
  let profile = null;
  let awarded = 0;
  if (username) {
    // Mark the prompt as covered so the randomiser stops handing it out to
    // this contributor and starts favouring thinner words for everyone else.
    const scores = (parsedMeta && parsedMeta.scores) || {};
    const credit = await auth.recordWord(username, {
      score: scores.banjara,
      streak: parsedMeta && parsedMeta.streak,
    });
    if (credit) { profile = credit.profile; awarded = credit.xp; }

    const promptId = parsedMeta && parsedMeta.prompt && parsedMeta.prompt.id;
    if (promptId) {
      await words.recordWord(username, promptId, {
        quality: scores.banjara,
        xp: awarded,
        durationMs: parsedMeta.durations && Math.round((parsedMeta.durations.banjara || 0) * 1000),
        storagePath: path.relative(BASE_PATH, saveDir),
      });
    }
  }

  console.log(`[SAVED] ${saveDir} (${written.length} files)${awarded ? ` +${awarded} XP` : ''}`);

  sendJSON(res, 200, { success: true, savedTo: saveDir, files: written, profile, xp: awarded });
}

// ── Session log ───────────────────────────────────────────────────────────────
/**
 * Stores the run sheet for one capture session: the prompt order, which words
 * the speaker had no Banjara equivalent for, and the timings. The audio files
 * cannot express any of that, and "this word has no Banjara form" is a finding
 * worth keeping rather than an empty slot.
 */
async function handleSessionLog(req, res, username) {
  let body;
  try { body = await readBody(req, res); } catch { return; }

  let payload;
  try { payload = JSON.parse(body.toString('utf8')); }
  catch { return sendJSON(res, 400, { error: 'Body must be JSON' }); }

  if (!payload || !payload.folder || !payload.log) {
    return sendJSON(res, 400, { error: 'Expected { folder, log } in the body' });
  }

  const dir = resolveInsideBase(payload.folder);
  if (!dir) return sendJSON(res, 400, { error: 'Invalid folder path' });
  mkdirSafe(dir);

  const log = { ...payload.log, recordedBy: username || null, receivedAt: new Date().toISOString() };

  const name = safeName(payload.name, 'session_log.json');
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(log, null, 2));

  // Roll the session into the user's lifetime totals — the reason the
  // completion screen can show a level rather than just one session's XP.
  let profile = null;
  if (username) {
    profile = await auth.recordSession(username, { streak: log.streak });

    // The run sheet goes to the database too when there is one; on files the
    // JSON written above is the record.
    await db.addSession({
      contributor: username,
      category: log.pack && log.pack.id,
      startedAt: log.startedAt,
      finishedAt: log.finishedAt,
      endedHow: log.endedHow || 'completed',
      xp: log.xp || 0,
      recorded: (log.totals && log.totals.recorded) || 0,
      skipped: (log.totals && log.totals.skipped) || 0,
      detail: log.items || null,
    }).catch(err => console.error('[SESSION LOG]', err.message));
  }

  console.log(`[LOG] ${target}`);
  sendJSON(res, 200, { success: true, savedTo: target, profile });
}

// ── Auth routes ───────────────────────────────────────────────────────────────
async function readJSON(req, res) {
  const body = await readBody(req, res);
  try { return JSON.parse(body.toString('utf8')); }
  catch { sendJSON(res, 400, { error: 'Body must be JSON' }); return null; }
}

async function handleRegister(req, res) {
  const payload = await readJSON(req, res);
  if (!payload) return;

  // Open only while nobody has signed up yet, or to someone already signed in.
  // Otherwise anyone who can reach the network could enrol themselves.
  const caller = auth.verifyToken(bearer(req));
  if (auth.isBootstrapped && !caller) {
    return sendJSON(res, 403, { error: 'Ask an existing user to create your account.' });
  }

  try {
    const user = await auth.register(payload);
    // Sign the first user straight in; making them log in immediately after
    // choosing a password is friction for no gain.
    const session = await auth.login({ username: payload.username, password: payload.password });
    sendJSON(res, 201, { user, token: session.token });
  } catch (err) {
    sendJSON(res, err.status || 400, { error: err.message });
  }
}

async function handleLogin(req, res) {
  const payload = await readJSON(req, res);
  if (!payload) return;
  try {
    sendJSON(res, 200, await auth.login(payload));
  } catch (err) {
    sendJSON(res, err.status || 401, { error: err.message });
  }
}

async function handleMe(req, res) {
  const username = auth.verifyToken(bearer(req));
  if (!username) return sendJSON(res, 401, { error: 'Not signed in.', code: 'auth_required' });

  const user = await auth.publicUser(username);
  // The token is valid but the account is gone — deleted since it was issued.
  if (!user) return sendJSON(res, 401, { error: 'Not signed in.', code: 'auth_required' });
  sendJSON(res, 200, { user });
}

// ── Word routes ───────────────────────────────────────────────────────────────
/** The category list, with the caller's own progress folded in. */
async function handleCategories(req, res, username) {
  const [categories, coverage] = await Promise.all([
    words.progress(username),
    words.coverageSummary(),
  ]);
  sendJSON(res, 200, { categories, coverage });
}

/**
 * A batch of prompts to record. Drawn fresh each time and weighted toward
 * thin coverage, so two contributors are not handed the same words and the
 * archive fills evenly rather than deepening on whatever sits at the top of
 * the list.
 */
async function handleBatch(req, res, username) {
  const params = new URLSearchParams((req.url.split('?')[1] || ''));
  const category = params.get('category') || null;
  const count = Math.max(1, Math.min(50, Number(params.get('count')) || 10));

  if (category && !words.byCategory.has(category)) {
    return sendJSON(res, 404, { error: `No category named "${category}"` });
  }

  const batch = await words.batch(username, { category, count });
  sendJSON(res, 200, { category, words: batch.words, remaining: batch.remaining });
}

async function handleSkip(req, res, username) {
  const payload = await readJSON(req, res);
  if (!payload) return;
  if (!payload.wordId) return sendJSON(res, 400, { error: 'Expected { wordId }' });

  const noted = await words.skipWord(username, payload.wordId);
  sendJSON(res, 200, { success: true, noted });
}

// ── Request handler ───────────────────────────────────────────────────────────
async function handler(req, res) {
  setCORS(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = decodeURIComponent(req.url.split('?')[0]);
  console.log(`[${req.method}] ${pathname}`);

  try {
    if (req.method === 'GET' && pathname === '/health') {
      return sendJSON(res, 200, {
        status: 'ok',
        basePath: BASE_PATH,
        secure: !!req.socket.encrypted,
        engines: { sarvam: !!STT.sarvam.key, groq: !!STT.groq.key },
        auth: { required: auth.isBootstrapped, users: auth.userCount },
      });
    }

    if (req.method === 'POST' && pathname === '/api/auth/register') return await handleRegister(req, res);
    if (req.method === 'POST' && pathname === '/api/auth/login')    return await handleLogin(req, res);
    if (req.method === 'GET'  && pathname === '/api/auth/me')       return await handleMe(req, res);

    if (req.method === 'GET' && pathname === '/api/words/categories') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleCategories(req, res, who.user);
    }
    if (req.method === 'GET' && pathname === '/api/words/batch') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleBatch(req, res, who.user);
    }
    if (req.method === 'POST' && pathname === '/api/words/skip') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleSkip(req, res, who.user);
    }

    // Everything below writes to the archive or spends an API budget, so it
    // runs as a known user once accounts exist.
    if (req.method === 'POST' && pathname === '/save') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleSave(req, res, who.user);
    }
    if (req.method === 'POST' && pathname === '/api/stt') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleSTT(req, res);
    }
    if (req.method === 'POST' && pathname === '/api/session-log') {
      const who = requireUser(req, res);
      if (!who.ok) return;
      return await handleSessionLog(req, res, who.user);
    }

    if (req.method === 'GET' && serveStatic(res, pathname)) return;

    sendJSON(res, 404, { error: `Cannot ${req.method} ${pathname}` });
  } catch (err) {
    console.error('[ERR]', err);
    if (!res.headersSent) sendJSON(res, 500, { error: err.message });
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
mkdirSafe(BASE_PATH);

const haveCerts = fs.existsSync(SSL_CERT) && fs.existsSync(SSL_KEY);
const server = haveCerts
  ? https.createServer({ cert: fs.readFileSync(SSL_CERT), key: fs.readFileSync(SSL_KEY) }, handler)
  : http.createServer(handler);

const scheme = haveCerts ? 'https' : 'http';

async function boot() {
  await auth.init();
  await words.init();
  server.listen(PORT, '0.0.0.0', onListening);
}

async function onListening() {
  const engines = Object.entries(STT).filter(([, v]) => v.key).map(([k]) => k);
  console.log('');
  console.log('  SOLARIS — data collection server');
  console.log('  ' + '-'.repeat(46));
  console.log(`  This device : ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Phone       : ${scheme}://${ip}:${PORT}`);
  }
  console.log(`  Dataset     : ${BASE_PATH}`);
  console.log(`  Database    : ${db.name === 'supabase' ? 'Supabase' : 'local files (set SUPABASE_URL to move)'}`);
  console.log(`  STT engines : ${engines.length ? engines.join(', ') : 'none configured (transcribe manually)'}`);
  console.log(`  Accounts    : ${auth.userCount === 0 ? 'none yet — the first sign-up becomes the first user' : `${auth.userCount} registered (sign-in required)`}`);
  const cov = await words.coverageSummary();
  console.log(`  Prompts     : ${cov.total} words in ${words.categories.length} categories (${cov.covered} recorded at least once)`);
  console.log('');
  if (!haveCerts) {
    console.log('  NOTE: running over plain HTTP. Phones will refuse microphone');
    console.log('        access on a LAN address. Run "npm run certs" to generate');
    console.log('        a local certificate, then restart.');
    console.log('');
  }
}

boot().catch(err => {
  console.error('');
  console.error('  SOLARIS could not start:', err.message);
  if (db.name === 'supabase') {
    console.error('  Check SUPABASE_URL and SUPABASE_SERVICE_KEY, and that db/schema.sql has been applied.');
  }
  console.error('');
  process.exit(1);
});
