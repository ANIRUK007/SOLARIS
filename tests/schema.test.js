/**
 * Applies db/schema.sql to a real Postgres and pushes the migration's own rows
 * into it. Run with: npm run test:db
 *
 * The stub tests prove the requests are shaped correctly. They cannot prove the
 * tables accept them — a column that does not exist, a check constraint that
 * rejects a value, a foreign key pointing at the wrong thing. Those only appear
 * against a real database, and finding them halfway through a live migration is
 * the worst time.
 *
 * Skipped automatically when no local Postgres is running: this is a
 * verification step, not something a field laptop needs to pass.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildSeedRows, buildAccountRows } = require('../db.js');

const DB = 'solaris_schema_test';
let passed = 0, count = 0;

function psql(sql, database = DB) {
  return execFileSync('psql', ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-d', database, '-c', sql],
    { encoding: 'utf8' }).trim();
}

function test(name, fn) {
  count++;
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${String(err.message).split('\n').slice(0, 4).join('\n       ')}`);
    process.exitCode = 1;
  }
}

/** Turn a row object into a single INSERT, so the column names being tested are
 *  exactly the ones the migration sends. */
function insert(table, row, onConflict) {
  const cols = Object.keys(row);
  const values = cols.map(c => {
    const v = row[c];
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'object') return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
    return `'${String(v).replace(/'/g, "''")}'`;
  });
  const conflict = onConflict ? ` on conflict (${onConflict}) do nothing` : '';
  return `insert into ${table} (${cols.join(', ')}) values (${values.join(', ')})${conflict};`;
}

// ── Runner ────────────────────────────────────────────────────────────────────
console.log('\nschema (real Postgres)');

try {
  execFileSync('pg_isready', { stdio: 'ignore' });
} catch {
  console.log('  skipped — no Postgres running locally\n');
  process.exit(0);
}

try {
  execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' });
  execFileSync('createdb', [DB], { stdio: 'ignore' });
} catch (err) {
  console.log(`  skipped — could not create a test database (${err.message})\n`);
  process.exit(0);
}

try {
  test('db/schema.sql applies to a clean database', () => {
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', DB, '-f',
      path.join(__dirname, '..', 'db', 'schema.sql')], { stdio: 'pipe' });
  });

  test('every table the application writes to exists', () => {
    const tables = psql(`select table_name from information_schema.tables
                         where table_schema = 'public' order by table_name`).split('\n');
    for (const needed of ['app_secrets', 'categories', 'contributions', 'contributors', 'sessions', 'words']) {
      assert.ok(tables.includes(needed), `missing table: ${needed}`);
    }
  });

  const wordsDoc = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'words.json'), 'utf8'));
  const seed = buildSeedRows(wordsDoc);

  test('the migration\'s category rows insert as written', () => {
    for (const row of seed.categories) psql(insert('categories', row, 'id'));
    assert.strictEqual(Number(psql('select count(*) from categories')), seed.categories.length);
  });

  test('the migration\'s word rows insert as written', () => {
    // A sample rather than all 1,482: this is checking the column names and
    // types, and the rows are built by one function.
    for (const row of seed.words.slice(0, 50)) psql(insert('words', row, 'id'));
    assert.strictEqual(Number(psql('select count(*) from words')), 50);
  });

  test('Telugu text survives the round trip into Postgres', () => {
    const stored = psql(`select te from words where id = '${seed.words[0].id}'`);
    assert.strictEqual(stored, seed.words[0].te, 'the script came back different');
  });

  test('a word cannot claim a category that does not exist', () => {
    assert.throws(
      () => psql(insert('words', { id: 'x_1', category: 'nope', te: 'x' })),
      /violates foreign key/,
      'a typo in a category would silently orphan the word');
  });

  test('the migration\'s contributor rows insert as written', () => {
    const accounts = buildAccountRows({
      ravi: {
        username: 'ravi', displayName: 'Ravi K', hash: 'h', salt: 's',
        createdAt: '2026-01-01T00:00:00Z',
        stats: { xp: 240, words: 9, streak: 3, bestStreak: 5 },
      },
    }, { contributors: {} });

    for (const row of accounts.contributors) psql(insert('contributors', row, 'username'));
    assert.strictEqual(psql("select display_name from contributors where username = 'ravi'"), 'Ravi K');
    assert.strictEqual(psql("select xp || '/' || words_count || '/' || best_streak from contributors where username = 'ravi'"), '240/9/5');
  });

  test('the migration\'s contribution rows insert as written', () => {
    const { contributions } = buildAccountRows({}, {
      contributors: {
        ravi: {
          recorded: { [seed.words[0].id]: '2026-01-02T00:00:00Z' },
          skipped: { [seed.words[1].id]: '2026-01-02T00:01:00Z' },
        },
      },
    });

    for (const row of contributions) psql(insert('contributions', row, 'contributor,word_id'));
    assert.strictEqual(Number(psql('select count(*) from contributions')), 2);
  });

  test('the same person cannot be counted twice for one word', () => {
    const before = Number(psql('select count(*) from contributions'));
    // No 'on conflict' this time: the constraint itself must reject it.
    assert.throws(
      () => psql(insert('contributions', {
        contributor: 'ravi', word_id: seed.words[0].id, outcome: 'recorded',
      })),
      /duplicate key|violates unique/,
      'coverage could be inflated by resubmitting');
    assert.strictEqual(Number(psql('select count(*) from contributions')), before);
  });

  test('an outcome outside recorded/skipped is rejected', () => {
    assert.throws(
      () => psql(insert('contributions', {
        contributor: 'ravi', word_id: seed.words[2].id, outcome: 'maybe',
      })),
      /violates check constraint/);
  });

  test('the coverage view counts voices, and ignores skips', () => {
    // One recording and one skip were inserted above.
    const recorded = psql(`select voices from word_coverage where word_id = '${seed.words[0].id}'`);
    const skipped = psql(`select voices from word_coverage where word_id = '${seed.words[1].id}'`);
    assert.strictEqual(recorded, '1');
    assert.strictEqual(skipped, '0', 'a skip was counted as coverage');
  });

  test('a session log inserts with its run sheet as jsonb', () => {
    psql(insert('sessions', {
      contributor: 'ravi',
      category: seed.categories[0].id,
      started_at: '2026-01-02T00:00:00Z',
      finished_at: '2026-01-02T00:10:00Z',
      ended_how: 'quit',
      xp: 30, recorded: 2, skipped: 1,
      detail: [{ id: seed.words[0].id, outcome: 'recorded' }],
    }));
    assert.strictEqual(psql("select detail -> 0 ->> 'outcome' from sessions limit 1"), 'recorded');
  });

  test('an unknown ended_how is rejected', () => {
    assert.throws(
      () => psql(insert('sessions', {
        contributor: 'ravi', started_at: '2026-01-02T00:00:00Z',
        finished_at: '2026-01-02T00:01:00Z', ended_how: 'vanished',
      })),
      /violates check constraint/);
  });

  test('the token secret upserts rather than duplicating', () => {
    psql(insert('app_secrets', { key: 'token_secret', value: 'first' }, 'key'));
    psql(`insert into app_secrets (key, value) values ('token_secret', 'second')
          on conflict (key) do update set value = excluded.value;`);
    assert.strictEqual(psql("select value from app_secrets where key = 'token_secret'"), 'second');
    assert.strictEqual(Number(psql('select count(*) from app_secrets')), 1);
  });

  test('row-level security is on for every table', () => {
    const open = psql(`select tablename from pg_tables
                       where schemaname = 'public' and rowsecurity = false`);
    assert.strictEqual(open, '', `RLS is off for: ${open.split('\n').join(', ')}`);
  });

  test('deleting a contributor does not delete the words they recorded', () => {
    psql("delete from contributors where username = 'ravi'");
    assert.ok(Number(psql('select count(*) from words')) > 0, 'words were cascaded away');
    // Their contributions go with them; the prompt list is reference data and
    // must not be touched by an account being removed.
    assert.strictEqual(Number(psql('select count(*) from contributions')), 0);
  });
} finally {
  try { execFileSync('dropdb', ['--if-exists', DB], { stdio: 'ignore' }); } catch {}
}

console.log(`\n${passed}/${count} passed\n`);
