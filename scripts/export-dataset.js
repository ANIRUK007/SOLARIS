#!/usr/bin/env node
/**
 * Pull the archive down into a folder you can train on.
 *
 *   node scripts/export-dataset.js ./export
 *
 * Reads the contributions table for what exists, downloads each recording from
 * wherever it is stored, and writes a manifest beside it. The manifest is the
 * point: a folder of WAVs with no index is not a dataset, and the pairing
 * between a Banjara recording and its Telugu prompt lives in the database, not
 * in the audio.
 *
 * Writes manifest.jsonl (one JSON object per line, which is what most training
 * pipelines want) and manifest.csv (which is what a spreadsheet wants).
 *
 * Safe to re-run: a file already downloaded and the right size is skipped, so
 * an interrupted export continues rather than starting again.
 */
const fs = require('fs');
const path = require('path');
const { open: openDb } = require('../db.js');
const { open: openStorage } = require('../storage.js');

(function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const outDir = path.resolve(process.argv[2] || './export');
const root = path.join(__dirname, '..');

const db = openDb(process.env, {
  wordsFile: path.join(root, 'data', 'words.json'),
  usersFile: path.join(root, '.solaris-users.json'),
  indexFile: path.join(root, '.solaris-words.json'),
});
const audio = openStorage(process.env, { root: path.join(root, 'dataset') });

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

(async function main() {
  console.log(`\nExporting from ${db.name} + ${audio.name} into ${outDir}\n`);

  const words = await db.words();
  const byId = new Map(words.map(w => [w.id, w]));

  // Only recordings. A skip is a finding worth keeping in the database, but
  // there is no audio behind it and it has no place in a training set.
  let rows;
  if (db.name === 'supabase') {
    rows = await db._request('/contributions?select=*&outcome=eq.recorded&order=created_at');
  } else {
    rows = [];
    for (const [contributor, history] of Object.entries(db._index.contributors || {})) {
      for (const wordId of Object.keys(history.recorded || {})) {
        rows.push({ contributor, word_id: wordId, storage_path: null, quality: null });
      }
    }
  }

  if (!rows.length) {
    console.log('Nothing recorded yet.\n');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  const audioDir = path.join(outDir, 'audio');

  const manifest = [];
  let downloaded = 0, skipped = 0, missing = 0;

  for (const row of rows) {
    const word = byId.get(row.word_id);
    if (!word) { missing++; continue; }

    const folder = row.storage_path || `contributors/${row.contributor}/${word.category}/${word.id}`;
    const base = `${row.contributor}_${word.id}`;

    // The cleaned take is what a model should train on; the raw one is kept so
    // the filtering can be redone if its thresholds change.
    const wanted = [
      { key: `${folder}/${base}_banjara.wav`, kind: 'cleaned' },
      { key: `${folder}/${base}_banjara_raw.wav`, kind: 'raw' },
    ];

    const localPaths = {};
    for (const { key, kind } of wanted) {
      const dest = path.join(audioDir, key.split('/').slice(1).join(path.sep));

      if (fs.existsSync(dest) && fs.statSync(dest).size > 44) {
        localPaths[kind] = path.relative(outDir, dest);
        skipped++;
        continue;
      }

      const bytes = await audio.get(key);
      if (!bytes) {
        if (kind === 'cleaned') missing++;
        continue;
      }

      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, bytes);
      localPaths[kind] = path.relative(outDir, dest);
      downloaded++;
    }

    if (!localPaths.cleaned) continue;

    manifest.push({
      audio: localPaths.cleaned,
      audio_raw: localPaths.raw || null,
      // The Telugu prompt is the transcript — this pairing is the dataset.
      telugu: word.te,
      transliteration: word.translit || null,
      english: word.en || null,
      language: 'bnj',
      pivot_language: 'te',
      word_id: word.id,
      category: word.category,
      contributor: row.contributor,
      quality: row.quality === undefined ? null : row.quality,
      recorded_at: row.created_at || null,
      sample_rate: 16000,
    });

    if (manifest.length % 25 === 0) process.stdout.write(`\r  ${manifest.length} recordings`);
  }

  process.stdout.write(`\r  ${manifest.length} recordings\n`);

  fs.writeFileSync(path.join(outDir, 'manifest.jsonl'),
    manifest.map(m => JSON.stringify(m)).join('\n') + '\n');

  const columns = Object.keys(manifest[0] || { audio: '' });
  fs.writeFileSync(path.join(outDir, 'manifest.csv'),
    [columns.join(','), ...manifest.map(m => columns.map(c => csvCell(m[c])).join(','))].join('\n') + '\n');

  const contributors = new Set(manifest.map(m => m.contributor));
  const categories = new Set(manifest.map(m => m.category));

  console.log(`\n  downloaded    ${downloaded} files`);
  if (skipped) console.log(`  already had   ${skipped}`);
  if (missing) console.log(`  missing audio ${missing} (a row with no file behind it)`);
  console.log(`\n  ${manifest.length} recordings from ${contributors.size} contributor(s), ${categories.size} categories`);
  console.log(`  manifest.jsonl and manifest.csv written to ${outDir}\n`);
})().catch(err => {
  console.error('\nExport failed:', err.message, '\n');
  process.exit(1);
});
