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
const { passwordProblem } = require('./security.js');

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days; field trips are long

// After this many wrong passwords the account stops answering for a while.
// Slow enough to make guessing pointless, short enough that someone who
// genuinely forgot is not locked out for the afternoon.
const MAX_FAILED_LOGINS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

// Streaks are counted in days, and a day needs a timezone. Fieldwork is in
// Telangana, so the day boundary that matters is India's, not the server's.
const TIMEZONE = process.env.SOLARIS_TIMEZONE || 'Asia/Kolkata';

/** Today's date in the project timezone, as YYYY-MM-DD. */
function today(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

/** Whether `earlier` is the calendar day immediately before `later`. */
function isPreviousDay(earlier, later) {
  if (!earlier) return false;
  const prev = new Date(later + 'T00:00:00Z');
  prev.setUTCDate(prev.getUTCDate() - 1);
  return earlier === prev.toISOString().slice(0, 10);
}

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

  /**
   * The full check, including whether the token has been revoked.
   *
   * verifyToken() is the cheap offline half that runs on every request;
   * this one costs a lookup and is used where it matters — anything that
   * writes, and the profile endpoint.
   */
  async verifySession(token) {
    const username = this.verifyToken(token);
    if (!username) return null;

    const user = await this.db.findContributor(username);
    if (!user) return null;                       // account deleted since

    let epoch = 0;
    try {
      const [body] = String(token).split('.');
      epoch = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')).e || 0;
    } catch { /* an unreadable payload has already failed the signature check */ }

    // Bumped when the password changes or the user signs out everywhere.
    if ((user.tokenEpoch || 0) !== epoch) return null;
    return username;
  }

  /**
   * Change a password, and invalidate every token already issued.
   *
   * Without the epoch bump, a password changed because it was shared or
   * stolen would leave the thief signed in for the next thirty days.
   */
  async changePassword(name, { current, next }) {
    const user = await this.db.findContributor(name);
    if (!user) throw this._err(404, 'No such account.');
    if (!this._verify(current, user)) throw this._err(401, 'Current password is incorrect.');

    const weak = passwordProblem(next, { username: name });
    if (weak) throw this._err(400, weak);

    // Work the next epoch out once. Reading it back off `user` after the
    // update would give the already-incremented value on a backend that
    // returns the same object it stored.
    const nextEpoch = (user.tokenEpoch || 0) + 1;

    const salt = crypto.randomBytes(16).toString('hex');
    await this.db.updateContributor(name, {
      salt,
      hash: this._hash(next, salt),
      tokenEpoch: nextEpoch,
    });

    // A fresh token so the person who just changed it stays signed in here.
    return { token: this._sign({ u: name, exp: Date.now() + TOKEN_TTL_MS, e: nextEpoch }) };
  }

  /** Sign out everywhere: every existing token stops working. */
  async signOutEverywhere(name) {
    const user = await this.db.findContributor(name);
    if (!user) return null;
    await this.db.updateContributor(name, { tokenEpoch: (user.tokenEpoch || 0) + 1 });
    return true;
  }

  // ── Accounts ────────────────────────────────────────────────────────────────
  /** @throws {Error} with a `.status` for the HTTP layer to use. */
  async register({ username, password, displayName }) {
    const name = String(username || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,32}$/.test(name)) {
      throw this._err(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
    }
    const weak = passwordProblem(password, { username: name });
    if (weak) throw this._err(400, weak);
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

    // A locked account answers the same way to everyone, including whoever is
    // guessing, so the lockout itself gives nothing away about the password.
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      const minutes = Math.ceil((new Date(user.lockedUntil) - Date.now()) / 60000);
      throw this._err(429, `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
    }

    if (typeof password !== 'string' || !this._verify(password, user)) {
      const failed = (user.failedLogins || 0) + 1;
      const patch = { failedLogins: failed };
      if (failed >= MAX_FAILED_LOGINS) {
        patch.lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
        patch.failedLogins = 0;
      }
      await this.db.updateContributor(name, patch);
      throw bad();
    }

    await this.db.updateContributor(name, {
      lastLoginAt: new Date().toISOString(),
      failedLogins: 0,
      lockedUntil: null,
    });

    return {
      token: this._sign({
        u: name,
        exp: Date.now() + TOKEN_TTL_MS,
        e: user.tokenEpoch || 0,
      }),
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
      stats: {
        ...stats,
        // What the profile shows: a run that has already lapsed reads as zero
        // rather than as the number it reached weeks ago.
        streak: this.liveStreak(u),
        lastContributionDay: u.lastContributionDay || null,
        contributedToday: u.lastContributionDay === today(),
      },
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
  async recordWord(name, { score = 0 } = {}) {
    const u = await this.db.findContributor(name);
    if (!u) return null;
    const stats = this._normaliseStats(u);

    // The streak is a run of days, so it is worked out from the calendar and
    // not from anything the client reports.
    const day = today();
    const lastDay = u.lastContributionDay || null;

    let streak = stats.streak || 0;
    if (lastDay === day) {
      // Already counted today; more words today do not extend a day streak.
    } else if (isPreviousDay(lastDay, day)) {
      streak = streak + 1;
    } else {
      streak = 1;                                  // first day, or the run broke
    }

    const quality = Math.max(0, Math.min(100, Number(score) || 0));
    const dayBonus = Math.min(5, Math.max(0, streak - 1));
    const xp = 10 + Math.round(quality / 10) + dayBonus;   // 10-25

    const next = {
      words: stats.words + 1,
      xp: stats.xp + xp,
      streak,
      bestStreak: Math.max(stats.bestStreak || 0, streak),
    };

    const row = await this.db.updateContributor(name, {
      ...next,
      lastContributionDay: day,
      lastContributionAt: new Date().toISOString(),
    });
    return { profile: this._public(row || { ...u, ...next, stats: next }), xp };
  }

  /**
   * A streak is only alive if the last contribution was today or yesterday.
   *
   * The stored number is what it was when they last recorded; left alone it
   * would still read "12 days" a month later. This is what the profile shows.
   */
  liveStreak(u) {
    const stats = this._normaliseStats(u);
    const last = u.lastContributionDay;
    if (!last) return 0;
    const day = today();
    if (last === day || isPreviousDay(last, day)) return stats.streak || 0;
    return 0;
  }

  /**
   * Roll a finished session into the user's lifetime totals.
   *
   * `streak` is the run of good takes as it stood at the end of the session,
   * carried forward rather than reset, so a streak survives putting the phone
   * down. Opening a word set adds nothing on its own.
   */
  async recordSession(name) {
    // Nothing to credit here any more: words, XP and the day streak are all
    // settled as each word lands. A sitting that ends is not itself an event
    // worth counting.
    const u = await this.db.findContributor(name);
    return u ? this._public(u) : null;
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

module.exports = { Auth, levelFor, xpForLevel, TOKEN_TTL_MS, today, isPreviousDay, MAX_FAILED_LOGINS, LOCKOUT_MS };
