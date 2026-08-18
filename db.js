/**
 * db.js — where SOLARIS keeps its data.
 *
 * One interface, two implementations:
 *
 *   supabase  Postgres via PostgREST. The source of truth once configured.
 *   file      JSON files next to the server. What runs when Supabase is not
 *             configured, and what the tests run against.
 *
 * The file backend is not a leftover. Recording happens in villages with no
 * reliable uplink, and a laptop in a field kit has to work with the cloud
 * unreachable, so "no database configured" stays a supported way to run rather
 * than an error. Which one is live is decided by SUPABASE_URL being present.
 *
 * Every method is async in both, so no caller can accidentally depend on the
 * file backend being synchronous.
 *
 * The interface:
 *
 *   words()                          → [{id, category, te, translit, en, …}]
 *   categories()                     → [{id, name, icon, accent, description}]
 *   findContributor(username)        → row | null
 *   createContributor(row)           → row
 *   updateContributor(username, patch)
 *   contributorHistory(username)     → {recorded: Set, skipped: Set}
 *   coverage()                       → Map<wordId, voices>
 *   addContribution(row)             → boolean   false if already present
 *   addSession(row)
 */

const fs = require('fs');
const path = require('path');

// Counters live under `stats` in the application's shape but are plain columns
// in Postgres, so a patch names them flat and each backend files them away.
const COUNTERS = new Set(['xp', 'words', 'streak', 'bestStreak']);

// ── File backend ──────────────────────────────────────────────────────────────
class FileDb {
  constructor({ wordsFile, usersFile, indexFile }) {
    this.wordsFile = wordsFile;
    this.usersFile = usersFile;
    this.indexFile = indexFile;

    const db = JSON.parse(fs.readFileSync(wordsFile, 'utf8'));
    this._words = db.words;
    this._categories = db.categories;

    this._users = readJson(usersFile, { secret: null, users: {} });
    this._index = readJson(indexFile, { contributors: {}, coverage: {} });
  }

  get name() { return 'file'; }

  async words() { return this._words; }
  async categories() { return this._categories; }

  /** The token-signing secret lives with the accounts in this backend. */
  async secret() { return this._users.secret; }
  async setSecret(secret) {
    this._users.secret = secret;
    writeJson(this.usersFile, this._users, 0o600);
  }

  async countContributors() {
    return Object.keys(this._users.users).length;
  }

  async findContributor(username) {
    return this._users.users[username] || null;
  }

  async createContributor(row) {
    // Store the same shape the Supabase backend returns: identity fields at
    // the top, counters grouped under `stats`. Two backends that disagree on
    // shape is a bug waiting for whichever one the tests do not cover.
    const stored = {
      username: row.username,
      displayName: row.displayName,
      salt: row.salt,
      hash: row.hash,
      createdAt: row.createdAt,
      stats: Object.assign({ xp: 0, words: 0, streak: 0, bestStreak: 0 }, row.stats),
    };
    this._users.users[row.username] = stored;
    writeJson(this.usersFile, this._users, 0o600);
    return stored;
  }

  async updateContributor(username, patch) {
    const row = this._users.users[username];
    if (!row) return null;

    row.stats = Object.assign({ xp: 0, words: 0, streak: 0, bestStreak: 0 }, row.stats);
    for (const [key, value] of Object.entries(patch)) {
      if (COUNTERS.has(key)) row.stats[key] = value;
      else row[key] = value;
    }

    writeJson(this.usersFile, this._users, 0o600);
    return row;
  }

  async contributorHistory(username) {
    const entry = this._index.contributors[username] || { recorded: {}, skipped: {} };
    return {
      recorded: new Set(Object.keys(entry.recorded || {})),
      skipped: new Set(Object.keys(entry.skipped || {})),
    };
  }

  async coverage() {
    return new Map(Object.entries(this._index.coverage));
  }

  async addContribution({ contributor, wordId, outcome }) {
    const entry = this._index.contributors[contributor] ||
      (this._index.contributors[contributor] = { recorded: {}, skipped: {} });

    if (entry.recorded[wordId] || entry.skipped[wordId]) return false;

    entry[outcome === 'recorded' ? 'recorded' : 'skipped'][wordId] = new Date().toISOString();
    if (outcome === 'recorded') {
      this._index.coverage[wordId] = (this._index.coverage[wordId] || 0) + 1;
    }
    writeJson(this.indexFile, this._index);
    return true;
  }

  async addSession() { /* the log file on disk is the record in this mode */ }
}

// ── Supabase backend ──────────────────────────────────────────────────────────
/**
 * Talks to PostgREST directly with fetch. No client library: the whole surface
 * used here is six endpoints, and a dependency that has to be installed in the
 * field is a dependency that will be missing in the field.
 */
class SupabaseDb {
  constructor({ url, serviceKey, fetchImpl }) {
    if (!url || !serviceKey) throw new Error('Supabase needs both a URL and a service key');
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.key = serviceKey;
    this.fetch = fetchImpl || fetch;

    this._wordCache = null;
    this._categoryCache = null;
  }

  get name() { return 'supabase'; }

  async _request(pathAndQuery, { method = 'GET', body, prefer } = {}) {
    const headers = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
    };
    if (prefer) headers.Prefer = prefer;

    const res = await this.fetch(this.base + pathAndQuery, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      // Surface what Postgres actually said; "400 Bad Request" alone is
      // useless when a constraint is what rejected the row.
      throw new Error(`Supabase ${method} ${pathAndQuery} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  /** Reference data is static for the life of the process, so read it once. */
  async words() {
    if (!this._wordCache) {
      this._wordCache = await this._request(
        '/words?select=id,category,te,translit,en,level,word_order&active=is.true&order=category,word_order');
    }
    return this._wordCache;
  }

  async categories() {
    if (!this._categoryCache) {
      const rows = await this._request('/categories?select=*&order=sort_order');
      const words = await this.words();
      const counts = words.reduce((acc, w) => (acc[w.category] = (acc[w.category] || 0) + 1, acc), {});
      this._categoryCache = rows.map(r => ({ ...r, count: counts[r.id] || 0 }));
    }
    return this._categoryCache;
  }

  async secret() {
    const rows = await this._request('/app_secrets?select=value&key=eq.token_secret&limit=1');
    return rows && rows.length ? rows[0].value : null;
  }

  async setSecret(secret) {
    await this._request('/app_secrets', {
      method: 'POST',
      body: { key: 'token_secret', value: secret },
      prefer: 'resolution=merge-duplicates',
    });
  }

  async countContributors() {
    // A HEAD with an exact count returns the number in a header rather than
    // pulling every row back just to measure it.
    const res = await this.fetch(`${this.base}/contributors?select=username`, {
      method: 'HEAD',
      headers: {
        apikey: this.key,
        Authorization: `Bearer ${this.key}`,
        Prefer: 'count=exact',
        Range: '0-0',
      },
    });
    const range = res.headers.get('content-range') || '';
    const total = range.split('/')[1];
    return Number(total) || 0;
  }

  async findContributor(username) {
    const rows = await this._request(`/contributors?select=*&username=eq.${encodeURIComponent(username)}&limit=1`);
    return rows && rows.length ? fromRow(rows[0]) : null;
  }

  async createContributor(row) {
    const inserted = await this._request('/contributors', {
      method: 'POST',
      body: toRow(row),
      prefer: 'return=representation',
    });
    return fromRow(Array.isArray(inserted) ? inserted[0] : inserted);
  }

  async updateContributor(username, patch) {
    const updated = await this._request(`/contributors?username=eq.${encodeURIComponent(username)}`, {
      method: 'PATCH',
      body: toRow(patch),
      prefer: 'return=representation',
    });
    const row = Array.isArray(updated) ? updated[0] : updated;
    return row ? fromRow(row) : null;
  }

  async contributorHistory(username) {
    const rows = await this._request(
      `/contributions?select=word_id,outcome&contributor=eq.${encodeURIComponent(username)}`);

    const recorded = new Set(), skipped = new Set();
    for (const row of rows || []) {
      (row.outcome === 'recorded' ? recorded : skipped).add(row.word_id);
    }
    return { recorded, skipped };
  }

  async coverage() {
    const rows = await this._request('/word_coverage?select=word_id,voices&voices=gt.0');
    return new Map((rows || []).map(r => [r.word_id, Number(r.voices)]));
  }

  async addContribution({ contributor, wordId, outcome, quality, xp, durationMs, storagePath }) {
    try {
      await this._request('/contributions', {
        method: 'POST',
        body: {
          contributor,
          word_id: wordId,
          outcome,
          quality: quality === undefined ? null : quality,
          xp_awarded: xp || 0,
          duration_ms: durationMs === undefined ? null : durationMs,
          storage_path: storagePath || null,
        },
        prefer: 'return=minimal',
      });
      return true;
    } catch (err) {
      // The (contributor, word_id) primary key is what stops a repeat from
      // double-counting coverage, so a conflict here is the expected answer
      // to "have they already done this word", not a failure.
      if (/duplicate key|23505/.test(err.message)) return false;
      throw err;
    }
  }

  async addSession(row) {
    await this._request('/sessions', {
      method: 'POST',
      body: {
        contributor: row.contributor,
        category: row.category || null,
        started_at: row.startedAt,
        finished_at: row.finishedAt,
        ended_how: row.endedHow || 'completed',
        xp: row.xp || 0,
        recorded: row.recorded || 0,
        skipped: row.skipped || 0,
        detail: row.detail || null,
      },
      prefer: 'return=minimal',
    });
  }
}

// ── Row mapping ───────────────────────────────────────────────────────────────
// Postgres columns are snake_case; the application speaks camelCase. Keeping
// the translation in one pair of functions means the rest of the code never
// has to know which backend it is talking to.
const FIELDS = [
  ['username', 'username'],
  ['displayName', 'display_name'],
  ['hash', 'password_hash'],
  ['salt', 'password_salt'],
  ['xp', 'xp'],
  ['words', 'words_count'],
  ['streak', 'streak'],
  ['bestStreak', 'best_streak'],
  ['createdAt', 'created_at'],
  ['lastLoginAt', 'last_login_at'],
  ['lastContributionAt', 'last_contribution_at'],
];

function toRow(obj) {
  const out = {};
  for (const [app, col] of FIELDS) {
    if (obj[app] !== undefined) out[col] = obj[app];
  }
  return out;
}

function fromRow(row) {
  const out = {};
  for (const [app, col] of FIELDS) {
    if (row[col] !== undefined && row[col] !== null) out[app] = row[col];
  }
  // The application groups the counters; the table keeps them as columns.
  out.stats = {
    xp: row.xp || 0,
    words: row.words_count || 0,
    streak: row.streak || 0,
    bestStreak: row.best_streak || 0,
  };
  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function readJson(file, fallback) {
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {
    try { fs.renameSync(file, file + '.corrupt-' + Date.now()); } catch {}
  }
  return fallback;
}

function writeJson(file, data, mode) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

/**
 * Pick a backend from the environment. Supabase wins when it is configured;
 * otherwise the server runs on files, which is what makes a field laptop with
 * no uplink a supported setup rather than a broken one.
 */
function open(env = process.env, paths = {}) {
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    return new SupabaseDb({ url: env.SUPABASE_URL, serviceKey: env.SUPABASE_SERVICE_KEY });
  }
  return new FileDb({
    wordsFile: paths.wordsFile || path.join(__dirname, 'data', 'words.json'),
    usersFile: paths.usersFile || path.join(__dirname, '.solaris-users.json'),
    indexFile: paths.indexFile || path.join(__dirname, '.solaris-words.json'),
  });
}

module.exports = { FileDb, SupabaseDb, open, toRow, fromRow };
