/**
 * security.js — the parts that stop this being a toy.
 *
 * Three things live here:
 *
 *   RateLimiter   how often one caller may do something
 *   headers()     the response headers a browser needs to defend the page
 *   passwordProblem()  why a password is not good enough, in plain words
 *
 * All of it is in-process. That is a real limit and worth stating: restart the
 * server and the counters reset, and two servers behind a load balancer each
 * count separately. For a field deployment — one server, a handful of
 * contributors — it is the right trade. Anything larger wants the counters in
 * Postgres or Redis, and the shape here does not have to change for that.
 */

// ── Rate limiting ─────────────────────────────────────────────────────────────
/**
 * A sliding window per key. Keys are chosen by the caller: an IP for anonymous
 * traffic, a username where the attempt names one, so that hammering one
 * account cannot be hidden behind a changing address.
 */
class RateLimiter {
  constructor({ windowMs, max, name }) {
    this.windowMs = windowMs;
    this.max = max;
    this.name = name || 'requests';
    this.hits = new Map();

    // Without this the map grows for every address that ever connects.
    this.sweeper = setInterval(() => this.sweep(), Math.max(windowMs, 60_000));
    if (this.sweeper.unref) this.sweeper.unref();
  }

  /** @returns {{ok: true} | {ok: false, retryAfter: number}} */
  check(key) {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    const times = (this.hits.get(key) || []).filter(t => t > cutoff);
    times.push(now);
    this.hits.set(key, times);

    if (times.length > this.max) {
      const retryAfter = Math.ceil((times[0] + this.windowMs - now) / 1000);
      return { ok: false, retryAfter: Math.max(1, retryAfter) };
    }
    return { ok: true };
  }

  /** Forget a key — used when an attempt succeeds, so a legitimate user who
   *  mistyped once is not punished for the rest of the window. */
  clear(key) { this.hits.delete(key); }

  sweep() {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, times] of this.hits) {
      const live = times.filter(t => t > cutoff);
      if (live.length) this.hits.set(key, live);
      else this.hits.delete(key);
    }
  }
}

// ── Response headers ──────────────────────────────────────────────────────────
/**
 * What a browser needs to defend the page.
 *
 * The session token lives in localStorage, which means any script that runs on
 * this origin can read it. The content security policy is what keeps a script
 * from getting there: everything is same-origin, and there is no inline script
 * to whitelist because the app has none.
 *
 * @param {boolean} secure  whether this response went out over TLS
 */
function headers(secure) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // The app sets element styles from JavaScript for meters and progress
    // bars, which counts as inline style.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",     // nothing may embed this page
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  const out = {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // The microphone is the only capability this app needs; everything else a
    // browser could offer is turned off.
    'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
  };

  // Only over TLS: sent on a plain HTTP response it would be ignored, and on a
  // LAN address it would pin a host that has no certificate.
  if (secure) out['Strict-Transport-Security'] = 'max-age=31536000';

  return out;
}

// ── Passwords ─────────────────────────────────────────────────────────────────
// The most common passwords, which are what an attacker tries first. A short
// list catches the overwhelming majority of real attempts; a long one is a
// dependency and a download.
const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', 'iloveyou', 'admin123', 'welcome1', 'welcome123',
  'letmein123', 'abc123456', 'passw0rd', 'p@ssw0rd', 'football', 'baseball',
  'sunshine', 'princess', 'trustno1', 'dragon123', 'monkey123', 'solaris123',
  'telugu123', 'banjara123', 'india123', 'changeme', 'secret123',
]);

/**
 * @returns {string|null} what is wrong with this password, or null if it will do.
 *
 * Length does more for a password than any rule about punctuation, so the bar
 * is length plus a check against the passwords attackers actually try. Rules
 * demanding a symbol mostly produce "Password1!", which is on every list.
 */
function passwordProblem(password, { username = '' } = {}) {
  if (typeof password !== 'string' || !password) return 'Enter a password.';
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (password.length > 200) return 'Password must be under 200 characters.';

  const lower = password.toLowerCase();
  if (COMMON.has(lower)) return 'That password is one of the most commonly used. Pick another.';
  if (username && lower.includes(String(username).toLowerCase())) {
    return 'Password must not contain your username.';
  }
  if (/^(.)\1+$/.test(password)) return 'Password cannot be a single repeated character.';

  // Straight runs off the keyboard or the number line.
  if (/^(0123456789|1234567890|abcdefghij|qwertyuiop)/.test(lower)) {
    return 'That password is a keyboard pattern. Pick something less guessable.';
  }
  return null;
}

// ── Client address ────────────────────────────────────────────────────────────
/**
 * The address to rate-limit against.
 *
 * X-Forwarded-For is honoured only when the server is told it sits behind a
 * proxy. Trusting it by default would let anyone set the header and get a
 * fresh quota per request, which is worse than not rate-limiting at all
 * because it looks like protection.
 */
function clientAddress(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

module.exports = { RateLimiter, headers, passwordProblem, clientAddress, COMMON };
