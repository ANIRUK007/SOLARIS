/**
 * words.js — the prompt database and who has recorded what.
 *
 * The word list comes from the project's Telugu tracker sheet: 1,482 prompts
 * across 15 categories. It is read-only reference data and lives in
 * data/words.json.
 *
 * The interesting part is the assignment. Handing every contributor the same
 * list in the same order would mean the first ten words get recorded by
 * everybody and the last thousand by nobody, so the archive ends up deep on
 * "house" and empty on everything else. Instead each request draws a fresh
 * batch, weighted so the least-covered words come first, and shuffled within
 * a coverage tier so two people asking at the same moment do not get the same
 * ten words.
 *
 * Coverage and per-contributor history are kept in a small JSON file next to
 * the server. It is an index, not the archive — the recordings themselves are
 * the record, and this can be rebuilt from them if it is ever lost.
 */

const TARGET_PER_WORD = 3;   // how many different voices we want per prompt

class Words {
  /** @param db anything matching the db.js interface */
  constructor(db) {
    this.db = db;
  }

  /** Load the prompt list once. It is reference data and does not change
   *  during a run, so it is worth holding in memory rather than querying. */
  async init() {
    this.words = await this.db.words();
    this.categories = await this.db.categories();

    this.byId = new Map(this.words.map(w => [w.id, w]));
    this.byCategory = new Map();
    for (const word of this.words) {
      if (!this.byCategory.has(word.category)) this.byCategory.set(word.category, []);
      this.byCategory.get(word.category).push(word);
    }
    return this;
  }

  // ── Assignment ──────────────────────────────────────────────────────────────
  /**
   * A batch of prompts for one contributor.
   *
   * Words this person has already answered are excluded outright — being
   * asked the same word twice is the fastest way to lose someone's patience.
   * What is left is ordered by how many other people have recorded it, so
   * thin coverage is filled first, and shuffled inside each tier so two
   * contributors working at once are not handed the same words.
   *
   * @returns {{words: object[], remaining: number}}
   */
  async batch(username, { category = null, count = 10 } = {}) {
    const [history, coverage] = await Promise.all([
      this.db.contributorHistory(username),
      this.db.coverage(),
    ]);
    const pool = category ? (this.byCategory.get(category) || []) : this.words;

    const available = pool.filter(w => !history.recorded.has(w.id) && !history.skipped.has(w.id));

    // Group by coverage so the shuffle only happens between equals.
    const tiers = new Map();
    for (const word of available) {
      const seen = Math.min(coverage.get(word.id) || 0, TARGET_PER_WORD);
      if (!tiers.has(seen)) tiers.set(seen, []);
      tiers.get(seen).push(word);
    }

    const picked = [];
    for (const tier of [...tiers.keys()].sort((a, b) => a - b)) {
      if (picked.length >= count) break;
      picked.push(...shuffle(tiers.get(tier)).slice(0, count - picked.length));
    }

    return { words: picked, remaining: available.length };
  }

  // ── Recording ───────────────────────────────────────────────────────────────
  async recordWord(username, wordId, extra = {}) {
    if (!this.byId.has(wordId)) return false;
    return this.db.addContribution({
      contributor: username,
      wordId,
      outcome: 'recorded',
      quality: extra.quality,
      xp: extra.xp,
      durationMs: extra.durationMs,
      storagePath: extra.storagePath,
    });
  }

  /**
   * A word this contributor says has no Banjara equivalent. It is a finding,
   * so it is remembered — but it does not count toward coverage, because
   * nobody recorded audio for it.
   */
  async skipWord(username, wordId) {
    if (!this.byId.has(wordId)) return false;
    return this.db.addContribution({ contributor: username, wordId, outcome: 'skipped' });
  }

  // ── Reporting ───────────────────────────────────────────────────────────────
  /** Category list with this contributor's progress folded in. */
  async progress(username) {
    const history = await this.db.contributorHistory(username);

    return this.categories.map(cat => {
      const words = this.byCategory.get(cat.id) || [];
      let recorded = 0, skipped = 0;
      for (const w of words) {
        if (history.recorded.has(w.id)) recorded++;
        else if (history.skipped.has(w.id)) skipped++;
      }
      return {
        ...cat,
        recorded,
        skipped,
        done: recorded + skipped,
        remaining: words.length - recorded - skipped,
      };
    });
  }

  /** How thinly the archive is covered overall, for the project's own sake. */
  async coverageSummary() {
    const coverage = await this.db.coverage();
    let covered = 0, atTarget = 0;
    for (const word of this.words) {
      const seen = coverage.get(word.id) || 0;
      if (seen > 0) covered++;
      if (seen >= TARGET_PER_WORD) atTarget++;
    }
    return { total: this.words.length, covered, atTarget, target: TARGET_PER_WORD };
  }
}

/** Fisher-Yates on a copy. Never shuffle the caller's array in place — it is
 *  the live category index. */
function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

module.exports = { Words, TARGET_PER_WORD, shuffle };
