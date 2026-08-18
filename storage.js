/**
 * storage.js — where the audio goes.
 *
 * The recordings are the archive. Everything else in this project — the word
 * list, the accounts, the coverage counts — could be rebuilt from them, and
 * nothing can rebuild them. So they get their own layer, separate from the
 * database, with two implementations:
 *
 *   supabase  Supabase Storage. Survives a redeploy, which local disk on a
 *             hosted platform does not.
 *   disk      A folder next to the server. What a field laptop uses, and what
 *             the tests use.
 *
 * A path is the same in both: contributors/<user>/<category>/<word>/<file>.
 * That means a bucket can be mirrored to a folder and back with rsync, and a
 * dataset copied off either one looks identical to whatever reads it next.
 */

const fs = require('fs');
const path = require('path');

// ── Disk ──────────────────────────────────────────────────────────────────────
class DiskStorage {
  constructor({ root }) {
    this.root = root;
  }

  get name() { return 'disk'; }

  /** @returns {Promise<string>} the path the file was stored at */
  async put(objectPath, bytes) {
    const target = this._resolve(objectPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    return objectPath;
  }

  async get(objectPath) {
    const target = this._resolve(objectPath);
    return fs.existsSync(target) ? fs.readFileSync(target) : null;
  }

  async list(prefix = '') {
    const start = this._resolve(prefix);
    if (!fs.existsSync(start)) return [];

    const out = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else out.push(path.relative(this.root, full).split(path.sep).join('/'));
      }
    };
    walk(start);
    return out;
  }

  /** Keep every write inside the root, whatever the caller passed. */
  _resolve(objectPath) {
    const cleaned = String(objectPath)
      .split('/')
      .filter(seg => seg && seg !== '.' && seg !== '..')
      .join(path.sep);

    const abs = path.resolve(this.root, cleaned);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error('Refusing to write outside the dataset directory');
    }
    return abs;
  }
}

// ── Supabase Storage ──────────────────────────────────────────────────────────
class SupabaseStorage {
  constructor({ url, serviceKey, bucket = 'recordings', fetchImpl }) {
    if (!url || !serviceKey) throw new Error('Supabase Storage needs a URL and a service key');
    this.base = url.replace(/\/+$/, '') + '/storage/v1';
    this.key = serviceKey;
    this.bucket = bucket;
    this.fetch = fetchImpl || fetch;
  }

  get name() { return 'supabase'; }

  _headers(extra = {}) {
    return Object.assign({
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
    }, extra);
  }

  /**
   * Create the bucket if it is not there yet, so a fresh project works without
   * anyone clicking through the dashboard first.
   *
   * Private, always. A public bucket would put recordings of people's voices
   * on a guessable URL, and consent to contribute to a language archive is not
   * consent to be published.
   */
  async ensureBucket() {
    const res = await this.fetch(`${this.base}/bucket/${this.bucket}`, { headers: this._headers() });
    if (res.ok) return false;

    const created = await this.fetch(`${this.base}/bucket`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        id: this.bucket,
        name: this.bucket,
        public: false,
        file_size_limit: 50 * 1024 * 1024,
        allowed_mime_types: ['audio/wav', 'audio/x-wav', 'text/plain', 'application/json'],
      }),
    });

    if (!created.ok) {
      const body = await created.text();
      // Another server booting at the same moment is not an error.
      if (!/already exists/i.test(body)) {
        throw new Error(`Could not create the "${this.bucket}" bucket: ${created.status} ${body.slice(0, 200)}`);
      }
    }
    return true;
  }

  async put(objectPath, bytes, contentType = 'application/octet-stream') {
    const res = await this.fetch(`${this.base}/object/${this.bucket}/${encodeURI(objectPath)}`, {
      method: 'POST',
      headers: this._headers({
        'Content-Type': contentType,
        // A re-upload of the same take replaces it rather than failing; the
        // path already identifies contributor, word and file.
        'x-upsert': 'true',
      }),
      body: bytes,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Upload of ${objectPath} failed: ${res.status} ${body.slice(0, 200)}`);
    }
    return objectPath;
  }

  async get(objectPath) {
    const res = await this.fetch(`${this.base}/object/${this.bucket}/${encodeURI(objectPath)}`, {
      headers: this._headers(),
    });
    if (res.ok) return Buffer.from(await res.arrayBuffer());

    // Storage answers a missing object with HTTP 400 and the real status in
    // the body: {"statusCode":"404","code":"NoSuchKey"}. Going by the HTTP
    // status alone turns "this file is not here" into a hard failure, which
    // stopped an export dead on the first recording without a raw take.
    const body = await res.text();
    if (res.status === 404 || /NoSuchKey|not_found|Object not found/i.test(body)) return null;

    throw new Error(`Download of ${objectPath} failed: ${res.status} ${body.slice(0, 200)}`);
  }

  async list(prefix = '') {
    // The listing endpoint pages, and a full archive will be longer than one
    // page well before anyone thinks to check.
    const out = [];
    const limit = 100;

    const walk = async (folder) => {
      for (let offset = 0; ; offset += limit) {
        const res = await this.fetch(`${this.base}/object/list/${this.bucket}`, {
          method: 'POST',
          headers: this._headers({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ prefix: folder, limit, offset, sortBy: { column: 'name', order: 'asc' } }),
        });
        if (!res.ok) throw new Error(`Listing ${folder} failed: ${res.status}`);

        const rows = await res.json();
        if (!rows.length) break;

        for (const row of rows) {
          const full = folder ? `${folder}/${row.name}` : row.name;
          // A folder comes back with no id; a file has one.
          if (row.id === null || row.id === undefined) await walk(full);
          else out.push(full);
        }
        if (rows.length < limit) break;
      }
    };

    await walk(prefix.replace(/\/+$/, ''));
    return out;
  }

  /**
   * A link that works for a while without the service key — for handing a
   * single recording to someone, not for publishing the archive.
   */
  async signedUrl(objectPath, expiresIn = 3600) {
    const res = await this.fetch(`${this.base}/object/sign/${this.bucket}/${encodeURI(objectPath)}`, {
      method: 'POST',
      headers: this._headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) throw new Error(`Signing ${objectPath} failed: ${res.status}`);
    const { signedURL } = await res.json();
    return this.base.replace(/\/storage\/v1$/, '') + signedURL;
  }
}

/**
 * Pick a backend. Supabase when it is configured, disk otherwise — the same
 * rule the database follows, so a deployment cannot end up with the metadata
 * in the cloud and the audio on a disk that is about to be wiped.
 */
function open(env = process.env, { root } = {}) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY && env.SOLARIS_AUDIO !== 'disk') {
    return new SupabaseStorage({
      url: env.SUPABASE_URL,
      serviceKey: env.SUPABASE_SERVICE_KEY,
      bucket: env.SUPABASE_BUCKET || 'recordings',
    });
  }
  return new DiskStorage({ root: root || path.join(__dirname, 'dataset') });
}

module.exports = { DiskStorage, SupabaseStorage, open };
