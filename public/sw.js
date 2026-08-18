/**
 * sw.js — offline app shell.
 *
 * Field sessions happen where there is no signal, so the interface itself
 * must load without the network. Only the shell is cached; recordings are
 * never cached here — those go through the IndexedDB queue in store.js,
 * which is durable and inspectable.
 *
 * Strategy: network-first for the shell so a redeploy reaches the phone on
 * the next load, cache as the fallback when the network is gone.
 */
const CACHE = 'solaris-shell-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'dsp.js',
  'store.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Never serve a stale answer for live state or uploads.
  if (url.pathname === '/health' || url.pathname.startsWith('/api/') || url.pathname === '/save') return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('index.html')))
  );
});
