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
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days; field trips are long

class Auth {
  constructor(storePath) {
    this.storePath = storePath;
    this.data = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.storePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
        if (parsed && parsed.secret && parsed.users) return parsed;
      }
    } catch {
      // A corrupt store must not take the server down, but it also must not
      // silently discard accounts — move it aside so it can be recovered.
      try { fs.renameSync(this.storePath, this.storePath + '.corrupt-' + Date.now()); } catch {}
    }
    return { secret: crypto.randomBytes(32).toString('hex'), users: {} };
  }

  _save() {
    const tmp = this.storePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.storePath);
  }

  get userCount() { return Object.keys(this.data.users).length; }
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
    const sig = crypto.createHmac('sha256', this.data.secret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  /** @returns {string|null} the username, or null if the token is unusable. */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;

    const expected = crypto.createHmac('sha256', this.data.secret).update(body).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    let payload;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); }
    catch { return null; }

    if (!payload.u || !payload.exp || Date.now() > payload.exp) return null;
    if (!this.data.users[payload.u]) return null;      // account deleted since
    return payload.u;
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  /** @throws {Error} with a `.status` for the HTTP layer to use. */
  register({ username, password, displayName }) {
    const name = String(username || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
      throw this._err(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    }
    if (typeof password !== 'string' || password.length < 8) {
      throw this._err(400, 'Password must be at least 8 characters.');
    }
    if (this.data.users[name]) {
      throw this._err(409, 'That username is already taken.');
    }

    const salt = crypto.randomBytes(16).toString('hex');
    this.data.users[name] = {
      username: name,
      displayName: String(displayName || username).trim().slice(0, 60) || name,
      salt,
      hash: this._hash(password, salt),
      createdAt: new Date().toISOString(),
      // Sessions are not counted: opening a word set is not an achievement,
      // contributing a word is. Streak carries across sessions so it means
      // something beyond a single sitting.
      stats: { xp: 0, words: 0, streak: 0, bestStreak: 0 },
    };
    this._save();
    return this.publicUser(name);
  }

  login({ username, password }) {
    const name = String(username || '').trim().toLowerCase();
    const user = this.data.users[name];

    // Same message either way: naming which half was wrong tells an attacker
    // which usernames exist.
    const bad = () => this._err(401, 'Incorrect username or password.');
    if (!user) throw bad();
    if (typeof password !== 'string' || !this._verify(password, user)) throw bad();

    user.lastLoginAt = new Date().toISOString();
    this._save();

    return {
      token: this._sign({ u: name, exp: Date.now() + TOKEN_TTL_MS }),
      user: this.publicUser(name),
    };
  }

  publicUser(name) {
    const u = this.data.users[name];
    if (!u) return null;
    this._normaliseStats(u);
    // Never let salt or hash leave the server.
    return {
      username: u.username,
      displayName: u.displayName,
      createdAt: u.createdAt,
      stats: u.stats,
      level: levelFor(u.stats.xp),
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
  recordWord(name, { score = 0, streak = 0 } = {}) {
    const u = this.data.users[name];
    if (!u) return null;
    this._normaliseStats(u);

    const quality = Math.max(0, Math.min(100, Number(score) || 0));
    const run = Math.max(0, Math.min(5, Math.round(Number(streak) || 0)));
    const xp = 10 + Math.round(quality / 10) + run;      // 10-25

    u.stats.words += 1;
    u.stats.xp += xp;
    u.stats.streak = Math.max(0, Math.round(Number(streak) || 0));
    u.stats.bestStreak = Math.max(u.stats.bestStreak || 0, u.stats.streak);
    u.stats.lastContributionAt = new Date().toISOString();

    this._save();
    return { profile: this.publicUser(name), xp };
  }

  /**
   * Roll a finished session into the user's lifetime totals.
   *
   * `streak` is the run of good takes as it stood at the end of the session,
   * carried forward rather than reset, so a streak survives putting the phone
   * down. Opening a word set adds nothing on its own.
   */
  recordSession(name, { streak = null } = {}) {
    const u = this.data.users[name];
    if (!u) return null;
    this._normaliseStats(u);

    // Words and XP are credited per word as they land, not here — otherwise
    // finishing a set would count everything twice.
    if (streak !== null && streak !== undefined) {
      u.stats.streak = Math.max(0, Math.round(streak));
      u.stats.bestStreak = Math.max(u.stats.bestStreak || 0, u.stats.streak);
    }

    u.stats.lastContributionAt = new Date().toISOString();
    this._save();
    return this.publicUser(name);
  }

  /** Migrate a store written before streaks were persisted. */
  _normaliseStats(u) {
    u.stats = Object.assign({ xp: 0, words: 0, streak: 0, bestStreak: 0 }, u.stats);
    delete u.stats.sessions;
    return u.stats;
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
