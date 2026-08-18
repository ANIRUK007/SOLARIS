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

const fs = require('fs');
const path = require('path');

const TARGET_PER_WORD = 3;   // how many different voices we want per prompt

class Words {
  constructor({ dataFile, indexFile }) {
    this.dataFile = dataFile;
    this.indexFile = indexFile;

    const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    this.categories = db.categories;
    this.words = db.words;

    this.byId = new Map(this.words.map(w => [w.id, w]));
    this.byCategory = new Map();
    for (const word of this.words) {
      if (!this.byCategory.has(word.category)) this.byCategory.set(word.category, []);
      this.byCategory.get(word.category).push(word);
    }

    this.index = this._loadIndex();
  }

  _loadIndex() {
    try {
      if (fs.existsSync(this.indexFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
        if (parsed && parsed.contributors && parsed.coverage) return parsed;
      }
    } catch {
      try { fs.renameSync(this.indexFile, this.indexFile + '.corrupt-' + Date.now()); } catch {}
    }
    return { contributors: {}, coverage: {} };
  }

  _saveIndex() {
    const tmp = this.indexFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.index));
    fs.renameSync(tmp, this.indexFile);
  }

  /** Word ids this contributor has already answered, recorded or skipped. */
  _history(username) {
    const entry = this.index.contributors[username];
    return entry || (this.index.contributors[username] = { recorded: {}, skipped: {} });
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
  batch(username, { category = null, count = 10 } = {}) {
    const history = this._history(username);
    const pool = category ? (this.byCategory.get(category) || []) : this.words;

    const available = pool.filter(w => !history.recorded[w.id] && !history.skipped[w.id]);

    // Group by coverage so the shuffle only happens between equals.
    const tiers = new Map();
    for (const word of available) {
      const seen = Math.min(this.index.coverage[word.id] || 0, TARGET_PER_WORD);
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
  recordWord(username, wordId) {
    if (!this.byId.has(wordId)) return false;
    const history = this._history(username);
    if (history.recorded[wordId]) return false;      // already counted

    history.recorded[wordId] = new Date().toISOString();
    delete history.skipped[wordId];
    this.index.coverage[wordId] = (this.index.coverage[wordId] || 0) + 1;
    this._saveIndex();
    return true;
  }

  /**
   * A word this contributor says has no Banjara equivalent. It is a finding,
   * so it is remembered — but it does not count toward coverage, because
   * nobody recorded audio for it.
   */
  skipWord(username, wordId) {
    if (!this.byId.has(wordId)) return false;
    const history = this._history(username);
    if (history.recorded[wordId] || history.skipped[wordId]) return false;

    history.skipped[wordId] = new Date().toISOString();
    this._saveIndex();
    return true;
  }

  // ── Reporting ───────────────────────────────────────────────────────────────
  /** Category list with this contributor's progress folded in. */
  progress(username) {
    const history = this._history(username);

    return this.categories.map(cat => {
      const words = this.byCategory.get(cat.id) || [];
      let recorded = 0, skipped = 0;
      for (const w of words) {
        if (history.recorded[w.id]) recorded++;
        else if (history.skipped[w.id]) skipped++;
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
  coverageSummary() {
    let covered = 0, atTarget = 0;
    for (const word of this.words) {
      const seen = this.index.coverage[word.id] || 0;
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
