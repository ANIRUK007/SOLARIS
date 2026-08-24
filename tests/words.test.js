/**
 * Tests for the prompt database and the assignment. Run with: npm test
 *
 * The assignment is the part worth testing hard: if it quietly repeats words
 * a contributor has already done, or hands two people the same list, the
 * archive ends up deep in one corner and empty everywhere else — and nobody
 * would notice until the data was analysed.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Words, TARGET_PER_WORD } = require('../words.js');
const { FileDb } = require('../db.js');

const TMP = path.resolve(fs.mkdtempSync(path.join(os.tmpdir(), 'solaris-words-')));
const DATA = path.join(__dirname, '..', 'data', 'words.json');

let passed = 0, n = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function run() {
  for (const t of tests) {
    n++;
    try {
      await t.fn();
      passed++;
      console.log(`  ok   ${t.name}`);
    } catch (err) {
      console.error(`  FAIL ${t.name}`);
      console.error(`       ${err.message}`);
      process.exitCode = 1;
    }
  }
}

async function fresh(name) {
  const db = new FileDb({
    wordsFile: DATA,
    usersFile: path.join(TMP, `${name}-users.json`),
    indexFile: path.join(TMP, `${name}-index.json`),
  });
  return new Words(db).init();
}

console.log('\nwords');

test('the sheet imported into a usable database', async () => {
  const w = await fresh('load');
  assert.ok(w.words.length > 1400, `only ${w.words.length} words`);
  assert.strictEqual(w.categories.length, 15);
  // Every category in the header must actually have words behind it.
  for (const cat of w.categories) {
    const held = w.byCategory.get(cat.id) || [];
    assert.strictEqual(held.length, cat.count, `${cat.id}: ${held.length} vs ${cat.count}`);
    assert.ok(held.length > 0, `${cat.id} is empty`);
  }
});

test('a batch is the size asked for', async () => {
  const w = await fresh('size');
  assert.strictEqual((await w.batch('ravi', { count: 10 })).words.length, 10);
  assert.strictEqual((await w.batch('ravi', { count: 3 })).words.length, 3);
});

test('a batch can be restricted to one category', async () => {
  const w = await fresh('category');
  const batch = await w.batch('ravi', { category: 'animals', count: 8 });
  assert.strictEqual(batch.words.length, 8);
  assert.ok(batch.words.every(x => x.category === 'animals'),
    batch.words.map(x => x.category).join(', '));
});

test('two contributors are handed different words', async () => {
  const w = await fresh('spread');
  const a = (await w.batch('alice', { count: 10 })).words.map(x => x.id);
  const b = (await w.batch('bob', { count: 10 })).words.map(x => x.id);
  const shared = a.filter(id => b.includes(id));
  // With 1,482 words to draw from, an overlap of more than a couple means
  // the draw is not actually random.
  assert.ok(shared.length <= 2, `overlap of ${shared.length}: ${shared.join(', ')}`);
});

test('the same contributor asking twice gets a different draw', async () => {
  const w = await fresh('reshuffle');
  const first = (await w.batch('ravi', { count: 10 })).words.map(x => x.id);
  const second = (await w.batch('ravi', { count: 10 })).words.map(x => x.id);
  assert.notDeepStrictEqual(first, second, 'the batch is not being reshuffled');
});

test('a word already recorded is never handed back to that contributor', async () => {
  const w = await fresh('norepeat');
  const first = (await w.batch('ravi', { category: 'animals', count: 5 })).words;
  for (const word of first) await w.recordWord('ravi', word.id);

  const seen = new Set(first.map(x => x.id));
  for (let i = 0; i < 8; i++) {
    for (const word of (await w.batch('ravi', { category: 'animals', count: 10 })).words) {
      assert.ok(!seen.has(word.id), `${word.id} was handed out again after being recorded`);
    }
  }
});

test('a word marked as having no Banjara form does not come back either', async () => {
  const w = await fresh('noskiprepeat');
  const word = (await w.batch('ravi', { category: 'numbers', count: 1 })).words[0];
  await w.skipWord('ravi', word.id);

  for (let i = 0; i < 8; i++) {
    const again = (await w.batch('ravi', { category: 'numbers', count: 20 })).words.map(x => x.id);
    assert.ok(!again.includes(word.id), `${word.id} came back after being skipped`);
  }
});

test('one contributor skipping a word leaves it available to everyone else', async () => {
  const w = await fresh('skipisolated');
  const word = (await w.batch('ravi', { category: 'time', count: 1 })).words[0];
  await w.skipWord('ravi', word.id);

  // A word with no Banjara form for one speaker may well have one for
  // another, and it has no recording either way.
  const pool = (await w.batch('other', { category: 'time', count: 100 })).words.map(x => x.id);
  assert.ok(pool.includes(word.id), 'a skip removed the word for everybody');
  assert.strictEqual((await w.db.coverage()).get(word.id) || 0, 0, 'a skip counted as coverage');
});

test('thinly covered words are handed out before well covered ones', async () => {
  const w = await fresh('coverage');
  const animals = w.byCategory.get('animals');

  // Cover the first forty by other people, up to the target.
  const covered = animals.slice(0, 40).map(x => x.id);
  for (const id of covered) {
    for (let i = 0; i < TARGET_PER_WORD; i++) await w.recordWord('voice' + i, id);
  }

  const batch = (await w.batch('newcomer', { category: 'animals', count: 20 })).words.map(x => x.id);
  const alreadyCovered = batch.filter(id => covered.includes(id));
  assert.strictEqual(alreadyCovered.length, 0,
    `handed out ${alreadyCovered.length} well-covered words while uncovered ones remained`);
});

test('recording the same word twice does not double the coverage', async () => {
  const w = await fresh('idempotent');
  const id = w.words[0].id;

  assert.strictEqual(await w.recordWord('ravi', id), true);
  assert.strictEqual(await w.recordWord('ravi', id), false, 'a repeat was accepted');
  const seen = (await w.db.coverage()).get(id);
  assert.strictEqual(seen, 1, `coverage counted ${seen}`);
});

test('an unknown word id is refused rather than invented', async () => {
  const w = await fresh('unknown');
  assert.strictEqual(await w.recordWord('ravi', 'not_a_real_word'), false);
  assert.strictEqual(await w.skipWord('ravi', 'not_a_real_word'), false);
});

test('progress is reported per category for the contributor asking', async () => {
  const w = await fresh('progress');
  const picked = (await w.batch('ravi', { category: 'places', count: 4 })).words;
  for (const word of picked) await w.recordWord('ravi', word.id);
  const toSkip = (await w.batch('ravi', { category: 'places', count: 1 })).words[0];
  await w.skipWord('ravi', toSkip.id);

  const mine = (await w.progress('ravi')).find(c => c.id === 'places');
  assert.strictEqual(mine.recorded, 4);
  assert.strictEqual(mine.skipped, 1);
  assert.strictEqual(mine.done, 5);
  assert.strictEqual(mine.remaining, mine.count - 5);

  // Somebody else's progress is their own.
  const theirs = (await w.progress('other')).find(c => c.id === 'places');
  assert.strictEqual(theirs.done, 0, 'progress leaked between contributors');
});

test('a batch runs out cleanly rather than repeating to fill the count', async () => {
  const w = await fresh('exhaust');
  const all = w.byCategory.get('verbs');
  for (const word of all) await w.recordWord('ravi', word.id);

  const batch = await w.batch('ravi', { category: 'verbs', count: 10 });
  assert.strictEqual(batch.words.length, 0, 'words were repeated to pad the batch');
  assert.strictEqual(batch.remaining, 0);
});

test('what has been recorded survives a restart', async () => {
  const files = {
    wordsFile: DATA,
    usersFile: path.join(TMP, 'persist-users.json'),
    indexFile: path.join(TMP, 'persist-index.json'),
  };

  const first = await new Words(new FileDb(files)).init();
  const id = (await first.batch('ravi', { count: 1 })).words[0].id;
  await first.recordWord('ravi', id);

  const second = await new Words(new FileDb(files)).init();
  assert.ok((await second.progress('ravi')).some(c => c.recorded > 0), 'progress was lost on reload');
  assert.strictEqual((await second.db.coverage()).get(id), 1);
});

test('coverage is reported across the whole archive', async () => {
  const w = await fresh('summary');
  const before = await w.coverageSummary();
  assert.strictEqual(before.covered, 0);
  assert.strictEqual(before.total, w.words.length);

  for (const word of (await w.batch('ravi', { count: 5 })).words) await w.recordWord('ravi', word.id);
  assert.strictEqual((await w.coverageSummary()).covered, 5);
});

run().then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(`\n${passed}/${n} passed\n`);
});
