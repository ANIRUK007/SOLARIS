# SOLARIS — a system description

Reference notes for writing this up. Every number here was read out of the
source rather than remembered; where a design choice has a reason, the reason is
given, because that is usually what a paper needs and what the code alone does
not say.

---

## 1. Problem

Banjara (also Gor Boli or Lambadi) is an Indo-Aryan language spoken by the
Banjara communities of the Deccan, largely without a standard written form. A
language in that position is poorly served by the usual speech-corpus pipeline,
which assumes a writing system, an existing text corpus to read aloud, and
literate speakers willing to read it.

SOLARIS collects spoken Banjara without requiring any of those. It also has to
work on the phone a contributor already owns, outdoors, on an unreliable
connection.

## 2. Elicitation design

**Cross-lingual prompt–response.** The contributor is shown a Telugu word and
speaks the Banjara equivalent. Telugu is the regional lingua franca in the
target area, so the prompt is legible to the speaker while the response is in
the language being documented.

Three consequences worth stating explicitly:

1. **No transcription is required for alignment.** The prompt is known before
   the speaker opens their mouth, so every recording arrives already paired with
   a semantic target. The corpus is usable without an annotation pass — which is
   the step that usually stalls low-resource collection.
2. **No orthography is required from the speaker.** Nothing is written in
   Banjara at any point.
3. **The prompt carries three surfaces** — Telugu script, Latin transliteration,
   and an English gloss — so a contributor who cannot read Telugu script can
   still use the system.

**Prompt corpus.** 1,482 Telugu prompts in 15 categories, imported from a
tracker spreadsheet:

| Category | n | Category | n | Category | n |
|---|---|---|---|---|---|
| places | 100 | pronouns | 100 | prepositions | 100 |
| animals | 100 | verbs | 88 | conjunctions | 100 |
| objects | 100 | adjectives | 100 | interjections | 100 |
| abstract | 100 | adverbs | 100 | relations | 94 |
| time | 100 | numbers | 100 | sentences | 100 |

Each record is `{id, category, te, translit, en, level, order}`. The `sentences`
category holds whole utterances rather than lexical items.

**Session unit.** Five prompts per sitting. Short enough to complete while
standing, which is the situation the app is actually used in.

## 3. Client-side audio pipeline

Everything below runs in the browser on the contributor's phone. Nothing is sent
to a server before the speaker has heard the result and accepted it.

### 3.1 Capture and normalisation

`MediaRecorder` with codec feature-detection at runtime rather than a hardcoded
MIME type — iOS Safari has never supported WebM, and assuming it is the single
most common way a browser recorder fails on half its users. The captured blob is
decoded, downmixed to mono, and resampled to **16 kHz** through an
`OfflineAudioContext`, then WAV-encoded.

16 kHz mono is the standard input rate for speech recognition, so the archive
needs no conversion pass before it is usable for training.

### 3.2 Threshold-based stem separation

A JavaScript port of a Python `audio_processor` module, run on-device:

1. STFT to a complex spectrogram — `n_fft = 1024`, `hop = 256`.
2. Per frame, **spectral flatness** (tonal vs. noise-like).
3. Per time–frequency bin, its **energy percentile within its own frame**.
4. Threshold both into three non-overlapping masks:
   - `noise` = flatness > **0.35**
   - `foreground` = not noise **and** percentile ≥ **70**
   - `background` = the remainder
5. Apply each binary mask to the complex spectrogram — **phase preserved** — and
   inverse-STFT back to a waveform.

Two deliberate departures from the source implementation:

- **Window size.** The Python defaults (`n_fft = 2048`) were sized for 44.1 kHz
  music. At 16 kHz that is a 128 ms window, far too long to track a syllable.
  1024 gives a 64 ms window.
- **Residual leak, 0.08.** Hard binary T-F masks leave isolated surviving bins
  that ring as *musical noise*, which measurably degrades recognition accuracy.
  Folding 8% of the discarded stems back in masks the ringing. Setting it to 0
  reproduces the original exactly.

**Both the raw and the cleaned take are retained.** The separation is lossy and
its thresholds are a judgement call; discarding the original would make that
judgement irreversible for every future user of the corpus.

### 3.3 On-device quality grading

Each take is scored 0–100 and must reach **50** to be accepted. Four components:

| Component | Criterion | Max |
|---|---|---|
| Duration | ≥ 0.6 s | 25 |
| Level | RMS ∈ (0.01, 0.95) | 30 |
| Clipping | < 1% of samples at \|x\| ≥ 0.99 | 25 |
| SNR | > 10 dB | 20 |

The noise floor is the **10th-percentile energy across 20 ms frames**, not the
first N milliseconds. An early version used a leading window; on a clip that
began in silence the ratio went to 687 dB. SNR is clamped to [−20, 60] dB.

A rejected take returns one specific, plain-language reason — *"Too much
background noise around the voice"*, *"The audio is clipping. Speak a little
softer"* — rather than a score. The contributor is not a sound engineer and
cannot act on a number.

Grading on-device is what makes the feedback loop immediate, and it means a bad
take never consumes uplink.

## 4. Coverage-weighted sampling

The naive design hands every contributor the word list in order, which produces
a corpus deep in the first category and empty in the last, with heavy duplicate
effort between contributors.

Instead, for each request:

1. Exclude every word this contributor has already **recorded or skipped**.
2. Tier the remainder by `min(global_coverage, TARGET_PER_WORD)` where
   `TARGET_PER_WORD = 3` — three distinct voices per prompt.
3. Walk tiers in ascending order, **Fisher–Yates shuffling within each tier**,
   until the batch is filled.

Least-covered words are always served first, so coverage converges uniformly;
randomisation within a tier means two contributors working simultaneously get
different sets. Coverage is computed server-side from the contributions table,
so it is correct across devices and sessions.

## 5. Data model and storage

**Postgres** (Supabase), six tables: `categories`, `words`, `contributors`,
`contributions`, `sessions`, `app_secrets`. Row-level security is enabled on
every table with **no permissive policy**, so only the service role can read or
write; the key never reaches a browser.

**Audio** goes to object storage in a **private** bucket, keyed
`contributors/<user>/<category>/<word>/<file>`. Private always: consent to
contribute to a language archive is not consent to be published. The path scheme
is identical on disk and in the bucket, so either can be mirrored to the other
with `rsync` and a dataset copied off either looks the same to whatever reads it
next.

**Both backends are interchangeable.** With credentials configured, Postgres and
object storage are the source of truth; without them the same interface is
served from JSON files and a local directory — which is what a field laptop with
no uplink uses. The application code does not know which it is talking to.

An export tool reconstructs the full dataset — cleaned take, raw take, session
metadata — from whichever backend is live.

## 6. Offline behaviour

A PWA with a service worker. Accepted takes are queued in **IndexedDB** and
uploaded when a connection returns. A recording made with no signal is not a
recording that is lost, which in this deployment context is the difference
between a usable system and a demo.

## 7. Accounts and security

Contributions are attributed, so accounts are not optional.

- **Passwords**: scrypt, per-user salt, 64-byte derived key. Policy is
  length-first — minimum 10 characters, checked against a list of the passwords
  attackers actually try, and rejected if it contains the username. Rules
  demanding a symbol mostly produce `Password1!`.
- **Sessions**: HMAC-signed bearer tokens, 30-day TTL (field trips are long),
  carrying an **epoch** field. Changing a password or signing out everywhere
  increments the epoch, invalidating every previously issued token — revocation
  without server-side session storage.
- **Lockout**: 8 failed sign-ins → 15-minute lock.
- **Rate limits**, sliding window: sign-in 20/15 min, sign-up 10/hr, writes
  120/min, all requests 600/min. Keyed by IP *and* by username, so hammering one
  account cannot be hidden behind a rotating address.
- **Headers**: CSP with `default-src 'self'` and `script-src 'self'` — no
  `unsafe-inline`, no `unsafe-eval`, because the token is in `localStorage` and
  an injected script could read it. `frame-ancestors 'none'`, `nosniff`,
  `no-referrer`, and `Permissions-Policy` granting only the microphone.
- **HSTS** is sent when TLS terminated upstream, established from
  `x-forwarded-proto` and believed **only** when the server is configured as
  proxied. Trusting that header unconditionally would let anyone claim a secure
  origin — the same rule governs `x-forwarded-for` for rate limiting.

## 8. Engagement design

The interface is a progress map: sections are word sets, each tile is five
words, and the map opens scrolled to the tile the contributor is up to. The road
stops at the end of the section in progress and ends in a locked gate naming
what opens it — bounding the scroll and giving completion a reward.

XP is **10–25 per accepted word**, computed server-side as
`10 + round(quality/10) + day_bonus`, so it cannot be inflated by the client.
**Streaks count distinct days contributed**, evaluated in `Asia/Kolkata` via
`Intl.DateTimeFormat` — not sessions, and not a rolling 24 hours.

This is worth being honest about in a paper: gamification is a data-quality
intervention with a known failure mode, discussed in §11.

## 9. Implementation and deployment

Roughly **4,700 lines** of application code with **zero runtime dependencies** —
plain Node and browser APIs. The container image is the runtime plus the
repository; there is no build step and no package registry needed to deploy,
which matters for a system intended to be redeployable from a field site.

Deployed as a single service: the same process serves the PWA and the API from
one origin. Splitting them would break the CSP (`connect-src 'self'`), the CORS
posture, and service-worker scope, for no benefit.

## 10. Verification

Around **3,100 lines** of tests, no framework: **159 headless assertions**
covering the DSP, the sampler, both storage backends, both database backends,
authentication, security posture and the HTTP surface; and **97 browser
assertions** driving a real browser at phone viewports through the full journey
— sign-up, map, recording, grading, save, offline queue, and a byte-identical
storage round-trip.

Method note worth reporting: **screenshots caught defects that assertions did
not.** Icons rendering as black silhouettes (a `<use>` shadow-tree inheritance
issue), a clipped label, an empty map after sign-in, and a horizontally
swipeable page were all invisible to passing tests and obvious in an image. The
suite renders and inspects screenshots for this reason.

## 11. Limitations

These are the questions a reviewer will ask, and the honest answers.

**Linguistic validity**
- Nothing verifies that a recording *is* Banjara, or is the correct translation.
  Grading is purely acoustic. There is no linguist-in-the-loop validation stage.
- Telugu-mediated elicitation biases the corpus toward concepts that lexicalise
  in Telugu, and may induce calques. Banjara concepts with no Telugu equivalent
  are structurally unreachable by this design.
- A fixed prompt list yields citation-form speech, not spontaneous or
  conversational speech. Its usefulness for language modelling, prosody, or
  conversational ASR is correspondingly limited.

**Corpus composition**
- **No speaker metadata is collected** — no age, gender, dialect region, or
  first language. For a language-documentation corpus this is a significant
  limitation, and it constrains any study of variation.
- A coverage target of **three voices per prompt** is low for modelling speaker
  variability.
- Category sizes are near-uniform by construction (~100 each), which reflects
  the source spreadsheet rather than the language's structure or frequency
  distribution.

**Signal**
- Consumer phone microphones, uncontrolled acoustic conditions, and device-
  dependent capture codecs before decode.
- Binary T-F masking is lossy and can remove speech; the 0.08 residual leak
  mitigates musical-noise artefacts but does not eliminate them. Retaining the
  raw take is the mitigation, not a fix.
- Thresholds (0.35 flatness, 70th percentile) were carried over from a music-
  oriented implementation and have not been tuned on Banjara speech.

**Method**
- Gamified progress may bias contributors toward speed over care; the acceptance
  threshold is the only counterweight, and it is acoustic.
- Rate limiting and lockout counters are in-process, so they reset on restart
  and are per-instance behind a load balancer.
- Single deployment, no inter-rater agreement study, no held-out evaluation of
  whether the collected audio improves a downstream ASR system — which is the
  obvious next experiment.

## 12. Reproducibility

The corpus schema, the sampler, the DSP module and its thresholds, the grading
rubric and the export tool are all in the repository, with the tests that pin
their behaviour. The system runs with no cloud account at all — file-backed
database, local audio directory — which is the configuration to use for
replication.
