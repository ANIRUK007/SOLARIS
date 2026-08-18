#!/usr/bin/env node
/**
 * Push local data into Supabase.
 *
 * Seeds the prompt list from data/words.json, then carries across any accounts
 * and contributions that were recorded while the server was running on files.
 * Safe to run more than once: rows are upserted on their primary keys, so a
 * second run updates rather than duplicates.
 *
 *   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/migrate-to-supabase.js
 *
 * Apply db/schema.sql first — this script writes rows, it does not create
 * tables. It does not touch the audio: recordings stay where they are.
 */
const fs = require('fs');
const path = require('path');
const { SupabaseDb, FileDb } = require('../db.js');

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_KEY first.');
  console.error('Both are in the Supabase dashboard under Project Settings → API.');
  console.error('Use the service_role key: the anon key cannot write these tables.');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const db = new SupabaseDb({ url, serviceKey: key });

/** Upsert in batches. PostgREST accepts an array, but not 1,500 rows at once
 *  on a small project without timing out. */
async function upsert(table, rows, conflictColumn, size = 200) {
  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    await db._request(`/${table}?on_conflict=${conflictColumn}`, {
      method: 'POST',
      body: slice,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    process.stdout.write(`\r  ${table}: ${Math.min(i + size, rows.length)}/${rows.length}`);
  }
  process.stdout.write('\n');
}

(async function main() {
  console.log(`\nMigrating into ${url}\n`);

  // ── Reference data ─────────────────────────────────────────────────────────
  const words = JSON.parse(fs.readFileSync(path.join(root, 'data', 'words.json'), 'utf8'));

  await upsert('categories', words.categories.map((c, i) => ({
    id: c.id, name: c.name, icon: c.icon, accent: c.accent,
    description: c.description, sort_order: i,
  })), 'id');

  await upsert('words', words.words.map(w => ({
    id: w.id, category: w.category, te: w.te, translit: w.translit,
    en: w.en, level: w.level, word_order: w.order, active: true,
  })), 'id');

  // ── Anything recorded while running on files ───────────────────────────────
  const usersFile = process.env.SOLARIS_USERS_FILE || path.join(root, '.solaris-users.json');
  const indexFile = process.env.SOLARIS_WORD_INDEX || path.join(root, '.solaris-words.json');

  if (!fs.existsSync(usersFile)) {
    console.log('\n  No local accounts to carry over.');
  } else {
    const local = new FileDb({
      wordsFile: path.join(root, 'data', 'words.json'),
      usersFile,
      indexFile,
    });

    const accounts = Object.values(local._users.users || {});
    if (accounts.length) {
      await upsert('contributors', accounts.map(u => ({
        username: u.username,
        display_name: u.displayName || u.username,
        // The hashes move across as they are: they are already scrypt digests,
        // and rehashing is impossible without the passwords.
        password_hash: u.hash,
        password_salt: u.salt,
        xp: (u.stats && u.stats.xp) || 0,
        words_count: (u.stats && u.stats.words) || 0,
        streak: (u.stats && u.stats.streak) || 0,
        best_streak: (u.stats && u.stats.bestStreak) || 0,
        created_at: u.createdAt || new Date().toISOString(),
        last_login_at: u.lastLoginAt || null,
      })), 'username');
    }

    // The signing secret comes too, or every token issued so far stops working.
    if (local._users.secret) {
      await db.setSecret(local._users.secret);
      console.log('  token secret: carried over (existing sign-ins survive)');
    }

    const contributions = [];
    for (const [username, history] of Object.entries(local._index.contributors || {})) {
      for (const [wordId, at] of Object.entries(history.recorded || {})) {
        contributions.push({ contributor: username, word_id: wordId, outcome: 'recorded', created_at: at });
      }
      for (const [wordId, at] of Object.entries(history.skipped || {})) {
        contributions.push({ contributor: username, word_id: wordId, outcome: 'skipped', created_at: at });
      }
    }
    if (contributions.length) await upsert('contributions', contributions, 'contributor,word_id');
  }

  // ── Check it landed ────────────────────────────────────────────────────────
  const seeded = await db.words();
  const cats = await db.categories();
  const people = await db.countContributors();

  console.log('\nIn Supabase now:');
  console.log(`  ${seeded.length} words in ${cats.length} categories`);
  console.log(`  ${people} contributor${people === 1 ? '' : 's'}`);
  console.log('\nPut SUPABASE_URL and SUPABASE_SERVICE_KEY in .env and restart the server.');
  console.log('It will report "Database: Supabase" on startup.\n');
})().catch(err => {
  console.error('\nMigration failed:', err.message);
  console.error('Nothing is half-written: every step upserts, so fix the cause and run it again.\n');
  process.exit(1);
});
