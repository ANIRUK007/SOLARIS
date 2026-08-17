"""
audio_processor.py
-------------------
Threshold-based audio source separation.

This module splits a mono/stereo audio signal into three stems:

    1. FOREGROUND  - the dominant, high-energy, harmonically structured
                      content (e.g. a lead vocal, a solo instrument,
                      speech).
    2. BACKGROUND  - lower-energy, sustained, harmonically structured
                      content that is not dominant (e.g. pads, ambience,
                      accompaniment).
    3. NOISE       - broadband, non-tonal, low-structure content (e.g.
                      hiss, hum, mic bumps, room noise).

HOW IT WORKS (high level)
==========================
1.  We take the Short-Time Fourier Transform (STFT) of the signal. This
    turns the 1-D waveform into a 2-D grid of complex numbers indexed by
    (frequency bin, time frame). The magnitude of each bin tells us "how
    much energy is at this frequency, at this moment in time".

2.  For every time-frequency (T-F) bin we compute two features:

        a. Spectral flatness (per frame) - a classic DSP measure of how
           "noise-like" vs "tonal" a spectrum is. It is the ratio of the
           geometric mean to the arithmetic mean of the magnitude
           spectrum. White noise has flatness close to 1.0 (flat
           spectrum); a pure tone/harmonic sound has flatness close to
           0.0 (energy concentrated in a few bins).

        b. Local relative energy (per bin) - how loud a bin is compared
           to the surrounding energy in that same frame, expressed as a
           percentile. This lets us say "this bin is in the top X% of
           energy for this moment", independent of the song's overall
           loudness.

3.  We turn these two continuous features into three non-overlapping
    binary masks using user-adjustable thresholds:

        - NOISE mask:      flatness > noise_threshold
                            (broadband / non-tonal bins are noise)
        - FOREGROUND mask: NOT noise AND relative_energy >= fg_threshold
                            (the loudest, structured content)
        - BACKGROUND mask: everything else
                            (structured but not dominant)

4.  Each mask is applied to the *complex* STFT (so phase is preserved)
    and each masked spectrogram is inverted back to a waveform with the
    inverse STFT (ISTFT). The three waveforms are written out as
    foreground.wav, background.wav and noise.wav.

This is a classical, fully open, signal-processing technique (STFT +
spectral-flatness + relative-energy thresholding). It does not use or
reproduce any proprietary/patented algorithm - it's built from first
principles with librosa/numpy/scipy, which is why it's suitable for an
open-source project. It also is not as accurate as a trained neural
model (like Spleeter/Demucs); those are listed as an optional upgrade
path in the README.
"""

import numpy as np
import librosa
import soundfile as sf
from dataclasses import dataclass


@dataclass
class SeparationParams:
    """User-adjustable thresholds (all 0.0 - 1.0 unless noted)."""

    # Spectral-flatness cutoff above which a T-F bin is considered "noise".
    # Flatness sits near 0.0 for tonal/harmonic content and rises toward
    # 1.0 for broadband/white-noise-like content. Higher threshold =
    # stricter (less gets labeled noise). Typical useful range 0.05-0.4;
    # pure white noise typically measures ~0.5+, clean tones/voice ~0.01-0.05.
    noise_threshold: float = 0.15

    # Percentile (0-100) of per-frame energy above which a bin is
    # considered "foreground". Higher = only the very loudest content
    # is treated as foreground; the rest becomes background.
    foreground_percentile: float = 70.0

    # STFT settings
    n_fft: int = 2048
    hop_length: int = 512


def _spectral_flatness_per_frame(S_mag: np.ndarray) -> np.ndarray:
    """
    Compute spectral flatness for every time frame, using librosa's
    battle-tested implementation (power-spectrum geometric/arithmetic
    mean ratio with proper numerical-floor handling — a naive hand-rolled
    version is easy to get wrong because near-silent bins blow up the
    log-domain geometric mean unless floored carefully).

    S_mag: magnitude spectrogram, shape (freq_bins, time_frames)
    returns: 1-D array, shape (time_frames,), values in [0, 1].
             ~0.0 = tonal/harmonic, ~1.0 = noise-like/broadband.
    """
    flatness = librosa.feature.spectral_flatness(S=S_mag, amin=1e-10)[0]
    return np.clip(flatness, 0.0, 1.0)


def _relative_energy_percentile(S_mag: np.ndarray) -> np.ndarray:
    """
    For every T-F bin, compute what percentile of its own frame's energy
    distribution it falls into (0 = quietest bin in the frame, 100 =
    loudest bin in the frame).

    S_mag: magnitude spectrogram, shape (freq_bins, time_frames)
    returns: array of same shape with percentile ranks per column
    """
    ranks = np.argsort(np.argsort(S_mag, axis=0), axis=0).astype(np.float64)
    n_bins = S_mag.shape[0]
    percentile = ranks / max(n_bins - 1, 1) * 100.0
    return percentile


def separate_audio(input_path: str, params: SeparationParams):
    """
    Load an audio file, split it into foreground/background/noise, and
    return the three waveforms plus the sample rate.

    Returns
    -------
    (foreground: np.ndarray, background: np.ndarray, noise: np.ndarray, sr: int)
    """
    # 1. Load audio, preserve native sample rate, force mono for simplicity
    #    (stereo could be processed channel-by-channel if needed later).
    y, sr = librosa.load(input_path, sr=None, mono=True)

    if len(y) == 0:
        raise ValueError("Uploaded audio file appears to be empty.")

    # 2. STFT: complex spectrogram (magnitude + phase)
    D = librosa.stft(y, n_fft=params.n_fft, hop_length=params.hop_length)
    S_mag, S_phase = np.abs(D), np.angle(D)

    # 3. Features
    flatness = _spectral_flatness_per_frame(S_mag)          # (frames,)
    rel_energy = _relative_energy_percentile(S_mag)          # (bins, frames)

    # Broadcast flatness across frequency bins so it lines up with rel_energy
    flatness_grid = np.tile(flatness, (S_mag.shape[0], 1))   # (bins, frames)

    # 4. Build the three non-overlapping masks
    noise_mask = flatness_grid > params.noise_threshold

    foreground_mask = (~noise_mask) & (rel_energy >= params.foreground_percentile)

    background_mask = (~noise_mask) & (~foreground_mask)

    # 5. Apply masks to the complex spectrogram (keep original phase),
    #    then invert back to time domain.
    def _reconstruct(mask: np.ndarray) -> np.ndarray:
        D_masked = D * mask
        return librosa.istft(D_masked, hop_length=params.hop_length, length=len(y))

    foreground = _reconstruct(foreground_mask)
    background = _reconstruct(background_mask)
    noise = _reconstruct(noise_mask)

    return foreground, background, noise, sr


def save_wav(path: str, y: np.ndarray, sr: int):
    """Write a float32 waveform to disk as a 16-bit PCM WAV file."""
    sf.write(path, y, sr, subtype="PCM_16")
