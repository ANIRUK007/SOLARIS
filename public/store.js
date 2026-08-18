/**
 * store.js — where a completed recording goes.
 *
 * Everything the app saves passes through this one seam, so moving the
 * dataset to the cloud later is a change to this file and nothing else.
 *
 *   SolarisStore.save(record)      persist one session
 *   SolarisStore.pending()         how many sessions are waiting to upload
 *   SolarisStore.flush()           retry everything queued
 *   SolarisStore.use(name)         choose a backend ('server' today)
 *   SolarisStore.register(name, b) plug in a new backend (e.g. 'cloud')
 *
 * A backend is an object with:
 *   name        string
 *   available() Promise<boolean>            — can it be reached right now
 *   put(record) Promise<{savedTo, files}>   — store one session
 *
 * A record is:
 *   {
 *     folder:     'speakers/SPK001/sessions/session_01/అ',
 *     transcript: 'telugu text',
 *     names:      { banjara, telugu, transcript, banjaraRaw? },
 *     blobs:      { banjara, telugu, banjaraRaw?, teluguRaw? },
 *     meta:       { ...form fields, capturedAt }
 *   }
 *
 * When the active backend cannot be reached — which on a phone happens
 * constantly, since the operator walks out of Wi-Fi range mid-session —
 * the record is written to IndexedDB instead and retried later. Nothing
 * is ever dropped because the network blinked.
 */
(function (root) {
  'use strict';

  const DB_NAME = 'solaris';
  const DB_VERSION = 1;
  const STORE = 'pending';

  let baseUrl = '';
  let activeBackend = 'server';
  const backends = {};

  // ── IndexedDB queue ─────────────────────────────────────────────────────────
  function openDb() {
    return new Promise((resolve, reject) => {
      if (!root.indexedDB) return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(mode, fn) {
    return openDb().then(db => new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (err) { reject(err); return; }
      t.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
      t.onerror = () => { db.close(); reject(t.error); };
    }));
  }

  // Records go in whole, blobs included — IndexedDB stores Blobs natively via
  // structured cloning, which is the entire reason the queue uses it rather
  // than localStorage.
  const queue = {
    add: (record) => tx('readwrite', s => s.add(record)),
    all: () => tx('readonly', s => s.getAll()),
    remove: (id) => tx('readwrite', s => s.delete(id)),
    count: () => tx('readonly', s => s.count()),
  };

  // ── Server backend (current: writes to the host machine's disk) ─────────────
  const serverBackend = {
    name: 'server',

    async available() {
      try {
        const r = await fetch(url('/health'), { method: 'GET', cache: 'no-store' });
        if (!r.ok) return false;
        const j = await r.json();
        return j.status === 'ok';
      } catch {
        return false;
      }
    },

    async put(record) {
      const fd = new FormData();
      fd.append('folderPath', record.folder);
      fd.append('banjara',    record.blobs.banjara, record.names.banjara);
      fd.append('telugu',     record.blobs.telugu,  record.names.telugu);
      fd.append('transcript', new Blob([record.transcript || ''], { type: 'text/plain;charset=utf-8' }), record.names.transcript);
      fd.append('bnj_name',   record.names.banjara);
      fd.append('tel_name',   record.names.telugu);
      fd.append('txt_name',   record.names.transcript);

      // The unfiltered takes are archived next to the cleaned ones. Filtering
      // is lossy and its thresholds may well be retuned later, so the source
      // audio has to survive.
      if (record.blobs.banjaraRaw) {
        fd.append('banjara_raw', record.blobs.banjaraRaw, record.names.banjaraRaw);
        fd.append('bnj_raw_name', record.names.banjaraRaw);
      }
      if (record.blobs.teluguRaw) {
        fd.append('telugu_raw', record.blobs.teluguRaw, record.names.teluguRaw);
        fd.append('tel_raw_name', record.names.teluguRaw);
      }
      if (record.meta) {
        fd.append('metadata', new Blob([JSON.stringify(record.meta, null, 2)], { type: 'application/json' }), 'session.json');
      }

      const r = await fetch(url('/save'), { method: 'POST', body: fd });
      const raw = await r.text();
      if (!r.ok) throw new Error(`Server returned ${r.status}: ${raw.slice(0, 200)}`);

      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error('Server response was not JSON: ' + raw.slice(0, 200)); }
      if (!data.success) throw new Error(data.error || 'Unknown server error');

      return { savedTo: data.savedTo, files: data.files };
    },
  };

  backends.server = serverBackend;

  /**
   * Adding cloud storage later:
   *
   *   SolarisStore.register('cloud', {
   *     name: 'cloud',
   *     available: () => fetch(API + '/ping').then(r => r.ok).catch(() => false),
   *     put: async (record) => {  // upload blobs, return the same shape
   *       ...
   *       return { savedTo: 's3://bucket/' + record.folder, files: [...] };
   *     },
   *   });
   *   SolarisStore.use('cloud');
   *
   * The queue, the retry logic and every caller stay exactly as they are —
   * they only depend on available() and put().
   */

  function url(p) {
    return (baseUrl || '') + p;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  /**
   * Persist one session. Falls back to the offline queue if the backend is
   * unreachable, so the operator never loses a take.
   *
   * @returns {Promise<{queued: boolean, savedTo?: string, files?: string[], reason?: string}>}
   */
  async function save(record) {
    const backend = backends[activeBackend];
    if (!backend) throw new Error(`No storage backend named "${activeBackend}"`);

    try {
      const res = await backend.put(record);
      return { queued: false, savedTo: res.savedTo, files: res.files };
    } catch (err) {
      // Only queue when it looks like a transport problem. A 400 from the
      // server means this record is malformed and retrying cannot fix it.
      if (isPermanent(err)) throw err;
      try {
        await queueRecord(record);
        return { queued: true, reason: err.message };
      } catch (queueErr) {
        throw new Error(`${err.message} (and the offline queue failed: ${queueErr.message})`);
      }
    }
  }

  function isPermanent(err) {
    return /Server returned 4\d\d/.test(err.message || '');
  }

  async function queueRecord(record) {
    // Blobs survive structured cloning, so they go in as-is.
    await queue.add({
      folder: record.folder,
      transcript: record.transcript,
      names: record.names,
      meta: record.meta,
      blobs: record.blobs,
      queuedAt: new Date().toISOString(),
    });
  }

  async function pending() {
    try { return await queue.count(); } catch { return 0; }
  }

  /**
   * Retry every queued record. Stops at the first transport failure so a
   * dead network does not churn through the whole queue.
   *
   * @returns {Promise<{sent: number, failed: number, remaining: number}>}
   */
  async function flush() {
    let sent = 0, failed = 0;
    let records;
    try { records = await queue.all(); } catch { return { sent: 0, failed: 0, remaining: 0 }; }

    const backend = backends[activeBackend];
    for (const rec of records) {
      try {
        await backend.put(rec);
        await queue.remove(rec.id);
        sent++;
      } catch (err) {
        if (isPermanent(err)) {
          // Malformed and unfixable; drop it rather than block the queue forever.
          await queue.remove(rec.id);
          failed++;
          continue;
        }
        break;
      }
    }
    return { sent, failed, remaining: await pending() };
  }

  const api = {
    configure: (opts) => { if (opts && opts.baseUrl !== undefined) baseUrl = opts.baseUrl; },
    use: (name) => { if (!backends[name]) throw new Error(`Unknown backend "${name}"`); activeBackend = name; },
    register: (name, backend) => { backends[name] = backend; },
    current: () => activeBackend,
    available: () => backends[activeBackend].available(),
    save,
    pending,
    flush,
    _queue: queue,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SolarisStore = api;
})(typeof self !== 'undefined' ? self : globalThis);
