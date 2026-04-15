const http = require('http');
const fs   = require('fs');
const path = require('path');

// ── Configuration ─────────────────────────────────────────────────────────────
const PORT      = 3001;
const BASE_PATH = 'C:\\Users\\asus\\OneDrive\\Desktop\\SOLARIS_user_interface\\dataset';

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

// ── Multipart parser ──────────────────────────────────────────────────────────
function parseMultipart(body, boundary) {
  const parts   = [];
  const sep     = Buffer.from('\r\n--' + boundary);
  const start   = Buffer.from('--' + boundary);

  // Find the very first boundary
  let pos = body.indexOf(start);
  if (pos === -1) return parts;
  pos += start.length;

  while (pos < body.length) {
    // Skip \r\n after boundary marker
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    // Check for terminal --
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;

    // Find header/body separator (\r\n\r\n)
    const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;

    const headerStr = body.slice(pos, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;

    // Find next boundary
    const nextBnd = body.indexOf(sep, dataStart);
    const dataEnd = nextBnd === -1 ? body.length : nextBnd;
    const data    = body.slice(dataStart, dataEnd);

    const nameMatch     = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);

    if (nameMatch) {
      parts.push({
        name:     nameMatch[1],
        filename: filenameMatch ? filenameMatch[1] : null,
        data,
      });
    }

    if (nextBnd === -1) break;
    pos = nextBnd + sep.length;
  }
  return parts;
}

// ── Request handler ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  setCORS(res);

  // Pre-flight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Strip query string for routing
  const pathname = req.url.split('?')[0];

  console.log(`[${req.method}] ${pathname}`);

  // ── GET / → serve index.html ────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (!fs.existsSync(htmlPath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('index.html not found next to server.js');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(htmlPath));
    return;
  }

  // ── GET /health ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/health') {
    sendJSON(res, 200, { status: 'ok', basePath: BASE_PATH });
    return;
  }

  // ── POST /save ──────────────────────────────────────────────────────────────
  if (req.method === 'POST' && pathname === '/save') {
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=("?)(.+)\1$/);           // handles quoted boundaries too

    if (!bm) {
      sendJSON(res, 400, { error: 'No multipart boundary in Content-Type' });
      return;
    }

    const boundary = bm[2].trim();
    const chunks   = [];

    req.on('data',  chunk => chunks.push(chunk));
    req.on('error', err   => { console.error('[REQ ERR]', err); sendJSON(res, 500, { error: err.message }); });
    req.on('end', () => {
      try {
        const body  = Buffer.concat(chunks);
        const parts = parseMultipart(body, boundary);

        const get = name => parts.find(p => p.name === name);

        const folderPathPart = get('folderPath');
        const banjaraPart    = get('banjara');
        const teluguPart     = get('telugu');
        const transcriptPart = get('transcript');
        const bnjName        = get('bnj_name')?.data.toString('utf8').trim();
        const telName        = get('tel_name')?.data.toString('utf8').trim();
        const txtName        = get('txt_name')?.data.toString('utf8').trim();

        if (!folderPathPart || !banjaraPart || !teluguPart || !transcriptPart) {
          console.error('[SAVE] Missing fields. Got parts:', parts.map(p => p.name));
          sendJSON(res, 400, {
            error: 'Missing required fields',
            received: parts.map(p => p.name),
          });
          return;
        }

        // Sanitise relative folder (prevent path traversal)
        const relFolder = folderPathPart.data.toString('utf8').trim()
          .replace(/\.\./g, '')
          .replace(/^[/\\]+/, '');

        const saveDir = path.join(BASE_PATH, relFolder);
        mkdirSafe(saveDir);

        const bnjPath = path.join(saveDir, bnjName || 'banjara.wav');
        const telPath = path.join(saveDir, telName || 'telugu.wav');
        const txtPath = path.join(saveDir, txtName || 'telugu.txt');

        fs.writeFileSync(bnjPath, banjaraPart.data);
        fs.writeFileSync(telPath, teluguPart.data);
        fs.writeFileSync(txtPath, transcriptPart.data.toString('utf8'));

        console.log(`[SAVED] ${bnjPath}`);
        console.log(`[SAVED] ${telPath}`);
        console.log(`[SAVED] ${txtPath}`);

        sendJSON(res, 200, {
          success: true,
          savedTo: saveDir,
          files:   [path.basename(bnjPath), path.basename(telPath), path.basename(txtPath)],
        });

      } catch (err) {
        console.error('[SAVE ERR]', err);
        sendJSON(res, 500, { error: err.message });
      }
    });

    return;
  }

  // ── 404 fallback ────────────────────────────────────────────────────────────
  sendJSON(res, 404, { error: `Cannot ${req.method} ${pathname}` });
});

// ── Start ─────────────────────────────────────────────────────────────────────
mkdirSafe(BASE_PATH);
server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   SOLARIS  —  Local File Server v2       ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Listening : http://127.0.0.1:${PORT}`);
  console.log(`  Dataset   : ${BASE_PATH}`);
  console.log('');
  console.log('  Routes:');
  console.log('    GET  /         → serves index.html');
  console.log('    GET  /health   → {"status":"ok"}');
  console.log('    POST /save     → saves wav + txt files');
  console.log('');
});
