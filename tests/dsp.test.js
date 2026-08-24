/**
 * Tests for the browser DSP port. Run with: npm test
 *
 * The separation masks are non-overlapping and sum to 1 at every
 * time-frequency bin, so the three stems must add back up to the original
 * signal. That invariant catches almost any error in the FFT, the window
 * normalisation, or the masking maths.
 */
const assert = require('assert');
const dsp = require('../public/dsp.js');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(`       ${err.message}`);
    process.exitCode = 1;
  }
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / a.length);
}

/** Deterministic pseudo-random noise, so failures reproduce. */
function noise(n, amp, seed) {
  let s = seed || 12345;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 0xffffffff) * 2 - 1) * amp;
  }
  return out;
}

function tone(n, freq, sr, amp) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / sr) * amp;
  return out;
}

console.log('\ndsp.js');

// ── FFT ───────────────────────────────────────────────────────────────────────
test('fft matches a naive DFT', () => {
  const n = 32;
  const src = noise(n, 1, 7);
  const re = Float64Array.from(src);
  const im = new Float64Array(n);
  dsp.fft(re, im, false);

  for (let k = 0; k < n; k++) {
    let dr = 0, di = 0;
    for (let t = 0; t < n; t++) {
      const ang = (-2 * Math.PI * k * t) / n;
      dr += src[t] * Math.cos(ang);
      di += src[t] * Math.sin(ang);
    }
    assert.ok(Math.abs(re[k] - dr) < 1e-9, `bin ${k} real ${re[k]} vs ${dr}`);
    assert.ok(Math.abs(im[k] - di) < 1e-9, `bin ${k} imag ${im[k]} vs ${di}`);
  }
});

test('inverse fft round-trips', () => {
  const n = 64;
  const src = noise(n, 1, 3);
  const re = Float64Array.from(src);
  const im = new Float64Array(n);
  dsp.fft(re, im, false);
  dsp.fft(re, im, true);
  assert.ok(maxAbsDiff(re, src) < 1e-12, `max diff ${maxAbsDiff(re, src)}`);
});

// ── STFT ──────────────────────────────────────────────────────────────────────
test('stft -> istft reconstructs the signal', () => {
  const sr = 16000;
  const y = tone(sr, 440, sr, 0.6);
  const spec = dsp.stft(y, 1024, 256);
  const back = dsp.istft(spec, 1024, 256, y.length);
  // Edges are approximate under reflect padding; check the interior.
  const inner = (a) => a.slice(2048, a.length - 2048);
  const d = maxAbsDiff(inner(back), inner(y));
  assert.ok(d < 1e-9, `max diff ${d}`);
});

test('stft frame count matches librosa centre framing', () => {
  const y = new Float32Array(16000);
  const spec = dsp.stft(y, 1024, 256);
  assert.strictEqual(spec.nFrames, 1 + Math.floor(16000 / 256));
  assert.strictEqual(spec.nBins, 513);
});

// ── Features ──────────────────────────────────────────────────────────────────
test('spectral flatness separates a tone from broadband noise', () => {
  const nBins = 256;

  const tonal = new Float64Array(nBins);
  tonal.fill(1e-6);
  tonal[40] = 1.0;                       // all energy in one bin
  const flatTonal = dsp.spectralFlatness(tonal, nBins);

  const broadband = new Float64Array(nBins);
  broadband.fill(1.0);                   // perfectly flat spectrum
  const flatNoise = dsp.spectralFlatness(broadband, nBins);

  assert.ok(flatTonal < 0.05, `tonal flatness ${flatTonal} should be near 0`);
  assert.ok(flatNoise > 0.95, `flat spectrum flatness ${flatNoise} should be near 1`);
});

test('percentile ranks span 0..100 within a frame', () => {
  const nBins = 5;
  const mag = new Float64Array([5, 1, 4, 2, 3]);
  const out = new Float64Array(nBins);
  dsp.percentileRanks(mag, nBins, out);
  assert.deepStrictEqual(Array.from(out), [100, 0, 75, 25, 50]);
});

// ── Separation ────────────────────────────────────────────────────────────────
test('the three stems sum back to the original signal', () => {
  const sr = 16000;
  const y = new Float32Array(sr);
  const t = tone(sr, 300, sr, 0.5);
  const n = noise(sr, 0.05, 99);
  for (let i = 0; i < sr; i++) y[i] = t[i] + n[i];

  const { foreground, background, noise: nz } = dsp.separate(y);
  const sum = new Float32Array(y.length);
  for (let i = 0; i < y.length; i++) sum[i] = foreground[i] + background[i] + nz[i];

  const inner = (a) => a.slice(2048, a.length - 2048);
  const d = maxAbsDiff(inner(sum), inner(y));
  assert.ok(d < 1e-6, `stems drift from original by ${d}`);
});

test('separation routes tonal speech-like content to the foreground', () => {
  const sr = 16000;
  const y = new Float32Array(sr);
  const t = tone(sr, 300, sr, 0.5);
  const n = noise(sr, 0.05, 4);
  for (let i = 0; i < sr; i++) y[i] = t[i] + n[i];

  const stems = dsp.separate(y, { residual: 0 });
  assert.ok(rms(stems.foreground) > rms(stems.noise),
    `foreground rms ${rms(stems.foreground)} should exceed noise rms ${rms(stems.noise)}`);
});

test('denoise raises the tone-to-hiss ratio of a noisy recording', () => {
  const sr = 16000;
  const clean = tone(sr, 300, sr, 0.4);
  const hiss = noise(sr, 0.25, 21);
  const dirty = new Float32Array(sr);
  for (let i = 0; i < sr; i++) dirty[i] = clean[i] + hiss[i];

  const { cleaned } = dsp.denoise(dirty);

  // Correlate each signal against the known clean tone: a higher ratio of
  // on-tone energy to total energy means less surviving hiss.
  const onTone = (sig) => {
    let dot = 0, energy = 0;
    for (let i = 0; i < sig.length; i++) { dot += sig[i] * clean[i]; energy += sig[i] * sig[i]; }
    return (dot * dot) / (energy || 1e-12);
  };

  assert.ok(onTone(cleaned) > onTone(dirty),
    `cleaned tone purity ${onTone(cleaned).toFixed(1)} should beat dirty ${onTone(dirty).toFixed(1)}`);
});

test('denoise leaves a silent clip silent instead of amplifying hiss', () => {
  const y = new Float32Array(16000);   // digital silence
  const { cleaned } = dsp.denoise(y);
  assert.ok(rms(cleaned) < 1e-6, `silence became ${rms(cleaned)}`);
});

test('separate rejects an empty signal', () => {
  assert.throws(() => dsp.separate(new Float32Array(0)), /empty/i);
});

// ── WAV ───────────────────────────────────────────────────────────────────────
test('encodeWav writes a valid 16-bit mono header', () => {
  const buf = dsp.encodeWav(new Float32Array(160), 16000);
  const v = new DataView(buf);
  const str = (o, n) => String.fromCharCode(...new Uint8Array(buf, o, n));

  assert.strictEqual(str(0, 4), 'RIFF');
  assert.strictEqual(str(8, 4), 'WAVE');
  assert.strictEqual(str(12, 4), 'fmt ');
  assert.strictEqual(v.getUint16(22, true), 1, 'channels');
  assert.strictEqual(v.getUint32(24, true), 16000, 'sample rate');
  assert.strictEqual(v.getUint16(34, true), 16, 'bit depth');
  assert.strictEqual(v.getUint32(40, true), 320, 'data length');
  assert.strictEqual(buf.byteLength, 44 + 320);
});

test('encodeWav clamps samples outside [-1, 1]', () => {
  const buf = dsp.encodeWav(new Float32Array([2, -2]), 16000);
  const v = new DataView(buf);
  assert.strictEqual(v.getInt16(44, true), 32767);
  assert.strictEqual(v.getInt16(46, true), -32768);
});

console.log(`\n${passed} passed\n`);
