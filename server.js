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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
async function handleSave(req, res) {
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

  const metaPart = get('metadata');
  if (metaPart) {
    const metaPath = path.join(saveDir, 'session.json');
    fs.writeFileSync(metaPath, metaPart.data.toString('utf8'));
    written.push('session.json');
  }

  console.log(`[SAVED] ${saveDir} (${written.length} files)`);

  sendJSON(res, 200, { success: true, savedTo: saveDir, files: written });
}

// ── Session log ───────────────────────────────────────────────────────────────
/**
 * Stores the run sheet for one capture session: the prompt order, which words
 * the speaker had no Banjara equivalent for, and the timings. The audio files
 * cannot express any of that, and "this word has no Banjara form" is a finding
 * worth keeping rather than an empty slot.
 */
async function handleSessionLog(req, res) {
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

  const name = safeName(payload.name, 'session_log.json');
  const target = path.join(dir, name);
  fs.writeFileSync(target, JSON.stringify(payload.log, null, 2));

  console.log(`[LOG] ${target}`);
  sendJSON(res, 200, { success: true, savedTo: target });
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
      });
    }

    if (req.method === 'POST' && pathname === '/save')             return await handleSave(req, res);
    if (req.method === 'POST' && pathname === '/api/stt')          return await handleSTT(req, res);
    if (req.method === 'POST' && pathname === '/api/session-log')  return await handleSessionLog(req, res);

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

server.listen(PORT, '0.0.0.0', () => {
  const engines = Object.entries(STT).filter(([, v]) => v.key).map(([k]) => k);
  console.log('');
  console.log('  SOLARIS — data collection server');
  console.log('  ' + '-'.repeat(46));
  console.log(`  This device : ${scheme}://localhost:${PORT}`);
  for (const ip of lanAddresses()) {
    console.log(`  Phone       : ${scheme}://${ip}:${PORT}`);
  }
  console.log(`  Dataset     : ${BASE_PATH}`);
  console.log(`  STT engines : ${engines.length ? engines.join(', ') : 'none configured (transcribe manually)'}`);
  console.log('');
  if (!haveCerts) {
    console.log('  NOTE: running over plain HTTP. Phones will refuse microphone');
    console.log('        access on a LAN address. Run "npm run certs" to generate');
    console.log('        a local certificate, then restart.');
    console.log('');
  }
});
