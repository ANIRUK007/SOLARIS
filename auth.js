/**
 * auth.js — accounts for the capture tools.
 *
 * This is a small team on a local network, not a public service, so the
 * design is deliberately minimal. It is still real authentication rather
 * than a decorative gate:
 *
 *   - passwords are hashed with scrypt and a per-user salt, never stored
 *   - tokens are HMAC-signed with a server secret and carry an expiry
 *   - the secret is generated once and kept out of the repository
 *
 * What it deliberately does NOT do, so nobody mistakes it for more than it
 * is: there is no password reset, no rate limiting, no revocation list. A
 * token stays valid until it expires. Logging out discards it client-side.
 * If this is ever exposed beyond a trusted LAN, it needs all three.
 *
 * Registration is open only while no account exists (so the first person can
 * bootstrap), or to a caller who is already signed in (so a lead can add
 * teammates). Otherwise a stranger on the network could simply enrol.
 */

const crypto = require('crypto');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days; field trips are long

class Auth {
  /** @param db anything matching the db.js interface */
  constructor(db) {
    this.db = db;
    this.secret = null;
    this.userCount = 0;
  }

  /**
   * Load the signing secret and find out whether anyone has registered.
   *
   * The secret is stored rather than generated per process: two servers on the
   * same database must accept each other's tokens, and a restart must not sign
   * everyone out.
   */
  async init() {
    this.secret = await this.db.secret();
    if (!this.secret) {
      this.secret = crypto.randomBytes(32).toString('hex');
      await this.db.setSecret(this.secret);
    }
    this.userCount = await this.db.countContributors();
    return this;
  }

  get isBootstrapped() { return this.userCount > 0; }

  // ── Passwords ───────────────────────────────────────────────────────────────
  _hash(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
  }

  /** Constant-time compare, so a wrong password cannot be found by timing. */
  _verify(password, user) {
    const attempt = Buffer.from(this._hash(password, user.salt), 'hex');
    const stored = Buffer.from(user.hash, 'hex');
    return attempt.length === stored.length && crypto.timingSafeEqual(attempt, stored);
  }

  // ── Tokens ──────────────────────────────────────────────────────────────────
  _sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  /**
   * Check a token's signature and expiry.
   *
   * Deliberately synchronous and offline: it runs on every request, and a
   * database round trip per request to confirm the account still exists would
   * put the archive's availability at the mercy of the network. A deleted
   * account is caught the moment it tries to read or write anything.
   *
   * @returns {string|null} the username, or null if the token is unusable.
   */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;

    const expected = crypto.createHmac('sha256', this.secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return null; }

    if (!payload.u || !payload.exp || Date.now() > payload.exp) return null;
    return payload.u;
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  /** @throws {Error} with a `.status` for the HTTP layer to use. */
  async register({ username, password, displayName }) {
    const name = String(username || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
      throw this._err(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw this._err(400, 'Password must be at least 8 characters.');
    }
    if (await this.db.findContributor(name)) {
      throw this._err(409, 'That username is already taken.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const row = await this.db.createContributor({
      username: name,
      displayName: String(displayName || username).trim().slice(0, 60) || name,
      salt,
      hash: this._hash(password, salt),
      createdAt: new Date().toISOString(),
      // Sessions are not counted: opening a word set is not an achievement,
      // contributing a word is.
      stats: { xp: 0, words: 0, streak: 0, bestStreak: 0 },
      xp: 0, words: 0, streak: 0, bestStreak: 0,
    });
    this.userCount++;
    return this._public(row);
  }

  async login({ username, password }) {
    const name = String(username || '').trim().toLowerCase();
    const user = await this.db.findContributor(name);

    // Same message either way: naming which half was wrong tells an attacker
    // which usernames exist.
    const bad = () => this._err(401, 'Incorrect username or password.');
    if (!user) throw bad();
    if (typeof password !== 'string' || !this._verify(password, user)) throw bad();

    await this.db.updateContributor(name, { lastLoginAt: new Date().toISOString() });

    return {
      token: this._sign({ u: name, exp: Date.now() + TOKEN_TTL_MS }),
      user: this._public(user),
    };
  }

  async publicUser(name) {
    const row = await this.db.findContributor(name);
    return row ? this._public(row) : null;
  }

  /** The shape a client is allowed to see. Never the hash or the salt. */
  _public(u) {
    if (!u) return null;
    const stats = this._normaliseStats(u);
    return {
      username: u.username,
      displayName: u.displayName,
      createdAt: u.createdAt,
      stats,
      level: levelFor(stats.xp),
    };
  }

  /**
   * Credit one contributed word, the moment it lands.
   *
   * Crediting at the end of a set would mean a contributor who records two
   * words and puts the phone down gets nothing, which is both discouraging
   * and untrue — the archive has their two words either way.
   *
   * The XP is computed here rather than accepted from the client. It is only
   * a game score on a trusted network, but a number the client can set is not
   * a number worth showing.
   */
  async recordWord(name, { score = 0, streak = 0 } = {}) {
    const u = await this.db.findContributor(name);
    if (!u) return null;
    const stats = this._normaliseStats(u);

    const quality = Math.max(0, Math.min(100, Number(score) || 0));
    const run = Math.max(0, Math.min(5, Math.round(Number(streak) || 0)));
    const xp = 10 + Math.round(quality / 10) + run;      // 10-25

    const next = {
      words: stats.words + 1,
      xp: stats.xp + xp,
      streak: Math.max(0, Math.round(Number(streak) || 0)),
    };
    next.bestStreak = Math.max(stats.bestStreak || 0, next.streak);

    const row = await this.db.updateContributor(name, {
      ...next,
      lastContributionAt: new Date().toISOString(),
    });
    return { profile: this._public(row || { ...u, ...next, stats: next }), xp };
  }

  /**
   * Roll a finished session into the user's lifetime totals.
   *
   * `streak` is the run of good takes as it stood at the end of the session,
   * carried forward rather than reset, so a streak survives putting the phone
   * down. Opening a word set adds nothing on its own.
   */
  async recordSession(name, { streak = null } = {}) {
    const u = await this.db.findContributor(name);
    if (!u) return null;
    const stats = this._normaliseStats(u);

    // Words and XP are credited per word as they land, not here — otherwise
    // finishing a set would count everything twice.
    const patch = { lastContributionAt: new Date().toISOString() };
    if (streak !== null && streak !== undefined) {
      patch.streak = Math.max(0, Math.round(streak));
      patch.bestStreak = Math.max(stats.bestStreak || 0, patch.streak);
    }

    const row = await this.db.updateContributor(name, patch);
    return this._public(row || u);
  }

  /** Tolerate a record written before streaks were persisted, and drop the
   *  session tally that is no longer kept. */
  _normaliseStats(u) {
    const stats = Object.assign({ xp: 0, words: 0, streak: 0, bestStreak: 0 }, u.stats);
    delete stats.sessions;
    u.stats = stats;
    return stats;
  }

  _err(status, message) {
    const e = new Error(message);
    e.status = status;
    return e;
  }
}

/** Levels widen as they go, so early sessions feel like progress and later
 *  ones still mean something. Level 1 starts at 0 XP. */
function levelFor(xp) {
  return Math.floor(Math.sqrt(Math.max(0, xp) / 120)) + 1;
}
function xpForLevel(level) {
  return Math.pow(Math.max(0, level - 1), 2) * 120;
}

module.exports = { Auth, levelFor, xpForLevel, TOKEN_TTL_MS };
