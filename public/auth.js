/**
 * auth.js (client) — sign-in state for the capture tools.
 *
 * Holds the token, tells callers who is signed in, and stamps outgoing
 * requests. Every network call that writes to the archive goes through
 * SolarisAuth.fetch so the token is attached in exactly one place.
 *
 * The token sits in localStorage: this runs on a shared field phone with no
 * backend session store, and a token that vanished on every reload would
 * mean signing in between every word. It expires server-side after 30 days.
 */
(function (root) {
  'use strict';

  const TOKEN_KEY = 'solaris_token';
  const USER_KEY = 'solaris_user';

  let baseUrl = '';
  let token = null;
  let user = null;

  try {
    token = localStorage.getItem(TOKEN_KEY);
    const cached = localStorage.getItem(USER_KEY);
    if (cached) user = JSON.parse(cached);
  } catch { /* private browsing, or a corrupt entry */ }

  function persist() {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);

      if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
      else localStorage.removeItem(USER_KEY);
    } catch { /* nothing we can do; the session simply will not survive a reload */ }
  }

  function url(p) { return (baseUrl || '') + p; }

  /** fetch with the bearer token attached, if there is one. */
  function authedFetch(input, init) {
    const opts = Object.assign({}, init);
    opts.headers = Object.assign({}, opts.headers);
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    return fetch(input, opts);
  }

  async function post(path, body) {
    const r = await authedFetch(url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data.error || `Request failed (${r.status})`);
      err.status = r.status;
      throw err;
    }
    return data;
  }

  async function login(username, password) {
    const data = await post('/api/auth/login', { username, password });
    token = data.token;
    user = data.user;
    persist();
    return user;
  }

  async function register(username, password, displayName) {
    const data = await post('/api/auth/register', { username, password, displayName });
    token = data.token;
    user = data.user;
    persist();
    return user;
  }

  /**
   * Re-check with the server. Also the way a token that expired or was
   * invalidated gets cleared, instead of failing later mid-session.
   */
  async function refresh() {
    if (!token) return null;
    try {
      const r = await authedFetch(url('/api/auth/me'));
      if (r.status === 401) { logout(); return null; }
      if (!r.ok) return user;                 // server trouble; keep what we have
      const data = await r.json();
      user = data.user;
      persist();
      return user;
    } catch {
      // Offline. The cached user is still the right thing to show.
      return user;
    }
  }

  function logout() {
    token = null;
    user = null;
    persist();
  }

  /** Whether this server has any accounts at all — before the first sign-up
   *  the tools stay usable so somebody can actually set it up. */
  async function serverRequiresAuth() {
    try {
      const r = await fetch(url('/health'), { cache: 'no-store' });
      const j = await r.json();
      return !!(j.auth && j.auth.required);
    } catch {
      return false;
    }
  }

  /** Replace the cached profile, e.g. after the server recomputes XP. */
  function updateUser(next) {
    if (!next) return;
    user = next;
    persist();
  }

  root.SolarisAuth = {
    configure: (opts) => { if (opts && opts.baseUrl !== undefined) baseUrl = opts.baseUrl; },
    login,
    register,
    refresh,
    updateUser,
    logout,
    serverRequiresAuth,
    fetch: authedFetch,
    get token() { return token; },
    get user() { return user; },
    get isSignedIn() { return !!token; },
  };
})(typeof self !== 'undefined' ? self : globalThis);
