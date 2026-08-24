/**
 * dsp.js — threshold-based stem separation, ported to the browser.
 *
 * This is a JavaScript port of backend/audio_processor.py from the
 * audio-splitter branch. Same technique, same knobs:
 *
 *   1. STFT the signal into a complex spectrogram.
 *   2. Per time frame, compute spectral flatness (tonal vs. noise-like).
 *   3. Per T-F bin, compute its energy percentile within its own frame.
 *   4. Threshold both features into three non-overlapping masks:
 *        noise      = flatness > noiseThreshold
 *        foreground = not noise AND percentile >= foregroundPercentile
 *        background = everything else
 *   5. Apply each mask to the complex spectrogram (phase preserved) and
 *      inverse-STFT back to a waveform.
 *
 * It runs on the device instead of on a server because a field recording
 * session may have no usable uplink, and because the phone has to grade and
 * play back the cleaned audio before the operator decides to save it.
 *
 * Defaults differ from the Python module in one place: n_fft/hop are sized
 * for 16 kHz speech (64 ms window) rather than 44.1 kHz music. At 16 kHz an
 * n_fft of 2048 would be a 128 ms window, far too long to track a syllable.
 *
 * Works in both the browser and plain Node (for the test harness).
 */
(function (root) {
  'use strict';

  const DEFAULTS = {
    // Spectral-flatness cutoff above which a frame is considered noise.
    // Tonal speech sits near 0.01-0.05, room hiss climbs toward 0.5.
    noiseThreshold: 0.35,
    // Energy percentile (0-100) above which a bin counts as foreground.
    foregroundPercentile: 70,
    nFft: 1024,
    hopLength: 256,
    // How much of the discarded stems to fold back in. Hard binary T-F
    // masks leave isolated surviving bins that ring as "musical noise",
    // which measurably hurts recognition accuracy. Leaking a little of
    // the residual back masks that ringing. 0 = fully faithful to the
    // Python implementation.
    residual: 0.08,
  };

  // ── FFT ─────────────────────────────────────────────────────────────────────
  // Iterative in-place radix-2 Cooley-Tukey. n must be a power of two.
  function fft(re, im, inverse) {
    const n = re.length;
    if (n <= 1) return;

    // Bit-reversal permutation.
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }

    for (let len = 2; len <= n; len <<= 1) {
      const ang = (inverse ? 2 : -2) * Math.PI / len;
      const wRe = Math.cos(ang);
      const wIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let curRe = 1, curIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const aRe = re[i + k],           aIm = im[i + k];
          const bRe = re[i + k + len / 2], bIm = im[i + k + len / 2];
          const tRe = bRe * curRe - bIm * curIm;
          const tIm = bRe * curIm + bIm * curRe;
          re[i + k]           = aRe + tRe;
          im[i + k]           = aIm + tIm;
          re[i + k + len / 2] = aRe - tRe;
          im[i + k + len / 2] = aIm - tIm;
          const nextRe = curRe * wRe - curIm * wIm;
          curIm = curRe * wIm + curIm * wRe;
          curRe = nextRe;
        }
      }
    }

    if (inverse) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /** Periodic Hann window, matching librosa's sym=False default. */
  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  /** Reflect-pad a signal by `pad` samples on both sides, as librosa's
   *  center=True does, so frame times line up with sample times. */
  function reflectPad(y, pad) {
    const n = y.length;
    const out = new Float64Array(n + 2 * pad);
    for (let i = 0; i < pad; i++) {
      // Guard against clips shorter than the pad by clamping the reflection.
      out[i] = y[Math.min(n - 1, Math.max(0, pad - i))];
      out[pad + n + i] = y[Math.max(0, n - 2 - i < 0 ? 0 : n - 2 - i)];
    }
    out.set(y, pad);
    return out;
  }

  // ── STFT / ISTFT ────────────────────────────────────────────────────────────
  /**
   * @returns {{re: Float64Array[], im: Float64Array[], nBins: number, nFrames: number}}
   *          One Float64Array per frame, each holding nFft/2+1 bins.
   */
  function stft(y, nFft, hopLength) {
    const pad = Math.floor(nFft / 2);
    const padded = reflectPad(y, pad);
    const win = hann(nFft);
    const nFrames = 1 + Math.floor((padded.length - nFft) / hopLength);
    const nBins = Math.floor(nFft / 2) + 1;

    const re = [], im = [];
    const bufRe = new Float64Array(nFft);
    const bufIm = new Float64Array(nFft);

    for (let f = 0; f < nFrames; f++) {
      const off = f * hopLength;
      for (let i = 0; i < nFft; i++) {
        bufRe[i] = padded[off + i] * win[i];
        bufIm[i] = 0;
      }
      fft(bufRe, bufIm, false);
      const fr = new Float64Array(nBins);
      const fi = new Float64Array(nBins);
      for (let b = 0; b < nBins; b++) { fr[b] = bufRe[b]; fi[b] = bufIm[b]; }
      re.push(fr); im.push(fi);
    }
    return { re, im, nBins, nFrames };
  }

  /** Inverse STFT with window-squared normalisation (Griffin-Lim overlap-add). */
  function istft(spec, nFft, hopLength, length) {
    const { re, im, nFrames, nBins } = spec;
    const win = hann(nFft);
    const pad = Math.floor(nFft / 2);
    const outLen = nFft + (nFrames - 1) * hopLength;

    const acc = new Float64Array(outLen);
    const wsum = new Float64Array(outLen);
    const bufRe = new Float64Array(nFft);
    const bufIm = new Float64Array(nFft);

    for (let f = 0; f < nFrames; f++) {
      // Rebuild the full spectrum from the half we kept, using the
      // conjugate symmetry that holds for any real-valued signal.
      for (let b = 0; b < nBins; b++) { bufRe[b] = re[f][b]; bufIm[b] = im[f][b]; }
      for (let b = nBins; b < nFft; b++) {
        const mirror = nFft - b;
        bufRe[b] =  re[f][mirror];
        bufIm[b] = -im[f][mirror];
      }
      fft(bufRe, bufIm, true);

      const off = f * hopLength;
      for (let i = 0; i < nFft; i++) {
        acc[off + i]  += bufRe[i] * win[i];
        wsum[off + i] += win[i] * win[i];
      }
    }

    const out = new Float64Array(length);
    for (let i = 0; i < length; i++) {
      const idx = i + pad;
      if (idx >= outLen) break;
      const w = wsum[idx];
      out[i] = w > 1e-8 ? acc[idx] / w : 0;
    }
    return out;
  }

  // ── Features ────────────────────────────────────────────────────────────────
  /**
   * Spectral flatness per frame: geometric mean over arithmetic mean of the
   * power spectrum. ~0 for tonal content, ~1 for broadband noise.
   * The amin floor matters — without it, near-silent bins send the
   * log-domain geometric mean to -Infinity.
   */
  function spectralFlatness(mag, nBins, amin) {
    const floor = amin === undefined ? 1e-10 : amin;
    let logSum = 0, sum = 0;
    for (let b = 0; b < nBins; b++) {
      const p = Math.max(floor, mag[b] * mag[b]);   // power, matching librosa power=2
      logSum += Math.log(p);
      sum += p;
    }
    const gmean = Math.exp(logSum / nBins);
    const amean = sum / nBins;
    const flat = amean > 0 ? gmean / amean : 0;
    return Math.min(1, Math.max(0, flat));
  }

  /**
   * Percentile rank (0-100) of every bin within its own frame.
   * Rank comes from an index sort, matching numpy's double-argsort trick.
   */
  function percentileRanks(mag, nBins, out) {
    const idx = new Int32Array(nBins);
    for (let i = 0; i < nBins; i++) idx[i] = i;
    // Sort indices by magnitude ascending.
    const arr = Array.prototype.slice.call(idx);
    arr.sort((a, b) => mag[a] - mag[b]);
    const denom = Math.max(nBins - 1, 1);
    for (let rank = 0; rank < nBins; rank++) {
      out[arr[rank]] = (rank / denom) * 100;
    }
    return out;
  }

  // ── Separation ──────────────────────────────────────────────────────────────
  /**
   * Split a mono Float32Array/Float64Array into three stems.
   *
   * @param {Float32Array|Float64Array} y  mono samples in [-1, 1]
   * @param {object} [opts]  overrides for DEFAULTS
   * @returns {{foreground: Float32Array, background: Float32Array, noise: Float32Array}}
   */
  function separate(y, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    if (!y || y.length === 0) throw new Error('Cannot separate an empty signal.');

    const spec = stft(y, o.nFft, o.hopLength);
    const { nBins, nFrames } = spec;

    const fg = { re: [], im: [], nBins, nFrames };
    const bg = { re: [], im: [], nBins, nFrames };
    const nz = { re: [], im: [], nBins, nFrames };

    const mag = new Float64Array(nBins);
    const pct = new Float64Array(nBins);
    const r = o.residual;

    for (let f = 0; f < nFrames; f++) {
      const re = spec.re[f], im = spec.im[f];
      for (let b = 0; b < nBins; b++) mag[b] = Math.hypot(re[b], im[b]);

      const flat = spectralFlatness(mag, nBins);
      percentileRanks(mag, nBins, pct);

      const fgRe = new Float64Array(nBins), fgIm = new Float64Array(nBins);
      const bgRe = new Float64Array(nBins), bgIm = new Float64Array(nBins);
      const nzRe = new Float64Array(nBins), nzIm = new Float64Array(nBins);

      // Flatness is a per-frame feature, so the whole frame is either
      // noise-like or not — same broadcast the Python version does.
      const frameIsNoise = flat > o.noiseThreshold;

      for (let b = 0; b < nBins; b++) {
        let wFg, wBg, wNz;
        if (frameIsNoise) {
          wNz = 1; wFg = 0; wBg = 0;
        } else if (pct[b] >= o.foregroundPercentile) {
          wFg = 1; wBg = 0; wNz = 0;
        } else {
          wBg = 1; wFg = 0; wNz = 0;
        }

        // Residual leak: blend a little of the full bin into each stem and
        // take it back out of that stem's own share, so the three stems
        // still sum to the original signal.
        if (r > 0) {
          wFg = wFg * (1 - r) + r / 3;
          wBg = wBg * (1 - r) + r / 3;
          wNz = wNz * (1 - r) + r / 3;
        }

        fgRe[b] = re[b] * wFg; fgIm[b] = im[b] * wFg;
        bgRe[b] = re[b] * wBg; bgIm[b] = im[b] * wBg;
        nzRe[b] = re[b] * wNz; nzIm[b] = im[b] * wNz;
      }

      fg.re.push(fgRe); fg.im.push(fgIm);
      bg.re.push(bgRe); bg.im.push(bgIm);
      nz.re.push(nzRe); nz.im.push(nzIm);
    }

    const n = y.length;
    return {
      foreground: toFloat32(istft(fg, o.nFft, o.hopLength, n)),
      background: toFloat32(istft(bg, o.nFft, o.hopLength, n)),
      noise:      toFloat32(istft(nz, o.nFft, o.hopLength, n)),
    };
  }

  /**
   * What SOLARIS actually wants: the speaker, with room tone and hiss
   * stripped out. That is the foreground stem, peak-normalised back to
   * roughly the level of the original so downstream loudness checks and
   * the STT engines see a sane signal.
   */
  function denoise(y, opts) {
    const stems = separate(y, opts);
    const cleaned = stems.foreground;

    let srcPeak = 0, outPeak = 0;
    for (let i = 0; i < y.length; i++) srcPeak = Math.max(srcPeak, Math.abs(y[i]));
    for (let i = 0; i < cleaned.length; i++) outPeak = Math.max(outPeak, Math.abs(cleaned[i]));

    if (outPeak > 1e-6 && srcPeak > 1e-6) {
      // Never amplify past full scale, and never boost more than 4x — a
      // large gain here means the separation found almost nothing, and
      // shouting the leftovers would just amplify artifacts.
      const gain = Math.min(srcPeak / outPeak, 0.99 / outPeak, 4);
      for (let i = 0; i < cleaned.length; i++) cleaned[i] *= gain;
    }
    return { cleaned, stems };
  }

  function toFloat32(a) {
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = a[i];
    return out;
  }

  // ── WAV encoding ────────────────────────────────────────────────────────────
  /** Mono 16-bit PCM WAV, matching the format the dataset already uses. */
  function encodeWav(samples, sampleRate) {
    const bps = 2;
    const dataLen = samples.length * bps;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };

    ws(0, 'RIFF');  v.setUint32(4, 36 + dataLen, true);
    ws(8, 'WAVE');  ws(12, 'fmt ');
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true);                       // PCM
    v.setUint16(22, 1, true);                       // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * bps, true);
    v.setUint16(32, bps, true);
    v.setUint16(34, 16, true);
    ws(36, 'data'); v.setUint32(40, dataLen, true);

    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
      const x = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
    }
    return buf;
  }

  const api = {
    DEFAULTS, fft, hann, stft, istft,
    spectralFlatness, percentileRanks,
    separate, denoise, encodeWav,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SolarisDSP = api;
})(typeof self !== 'undefined' ? self : globalThis);
