# SOLARIS

A data collection interface for a research project called SOLARIS — Speech-Oriented Language
Archival and Reasoning Infrastructure for Indigenous Systems. The goal is to collect paired
Banjara (tribal oral language) and Telugu audio recordings from bilingual speakers, annotate
them, and build a speech AI pipeline using Telugu as a pivot language.

This branch (`mobile`) is the phone-capable version. Fieldwork happens where the speakers
are, so the interface has to run on the handset a researcher is already carrying.

The app opens on an account screen. Once signed in you land on a portal of word-set cards;
tapping one starts a session where a Telugu word fills the screen and the speaker says it
in Banjara. That is the whole loop.

---

## Rotate the old API keys first

Earlier versions of `index.html` contained a live Sarvam key and a live Groq key. That file
was committed to a public repository, so both keys are in the git history and must be treated
as compromised. **Rotate them at Sarvam and at Groq.** Removing them from the current file
does not un-publish them — the old commits still hold the values.

In this version the keys live in `.env` on the server and never reach the browser. The page
calls `POST /api/stt`, and the server attaches the key on the way out.

---

## Quick start

```bash
cp .env.example .env      # add your rotated keys
npm run certs             # generate a local HTTPS certificate (needed for phones)
npm start
```

The server prints one URL for this machine and one for the phone:

```
This device : https://localhost:3001
Phone       : https://192.168.1.42:3001
Dataset     : /Users/you/SOLARIS/dataset
STT engines : sarvam, groq
```

Put the phone on the same Wi-Fi, open the second URL, accept the certificate warning once,
and record.

### Why HTTPS is not optional on a phone

Browsers only release the microphone on a *secure context*. `localhost` qualifies; the
`192.168.x.x` address a phone must use does not. Over plain HTTP the record button fails on
every phone on the network, usually with no visible error. `npm run certs` generates a
self-signed certificate listing your current LAN addresses. The phone warns once, you accept,
and the microphone works.

For a warning-free certificate:

```bash
brew install mkcert && mkcert -install
mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 192.168.1.42
```

---

## The app

```
open  ─►  sign in / sign up      every recording is attributed to an account
          │
          ▼
       portal                    a card per word set, with the streak and
          │                      the profile drawer in the header
          ▼
       session                   one Telugu prompt at a time, recorded in
          │                      Banjara, graded on the spot
          ▼
       complete                  XP earned, then back to the portal
```

A word set is a JSON file in `public/packs/`, listed in `public/packs/index.json`. Add a
file there and it appears as a card — no code change. Each item needs an `id` safe for use
as a folder name, the Telugu text, and ideally a transliteration and gloss:

```json
{ "id": "amma", "te": "అమ్మ", "translit": "amma", "en": "mother", "segment": "relation" }
```

Progress is tracked per contributor, so a half-finished set resumes where they stopped
rather than starting over. A word marked "no Banjara word for this" counts as answered —
that a Telugu concept has no Banjara equivalent is a finding, and it is kept in the session
log rather than silently dropped.

XP is credited the moment each word is saved, not when a set is finished — someone who
records two words and puts the phone down has still contributed two words, and the archive
has them either way. The server computes the award from the recording's quality score rather
than accepting a number from the client, and caps it, so the figure on screen means something.

Opening a word set earns nothing on its own and no session tally is kept: the numbers that
move are words, XP and the streak, and the streak carries across sittings.

Tapping the avatar slides in the profile: the XP loader and level, words, current and best
streak, and per-set progress. It is reference rather than a step in the flow, so it arrives
over the portal instead of navigating away from it. Tap outside, press Escape, or swipe it
right to dismiss.

## Accounts

The first sign-up on a fresh server becomes the first account and is signed straight in.
After that, registration is closed to strangers: an existing user has to create the account.
Otherwise anyone who could reach the network could enrol themselves, which would make the
sign-in decorative.

Passwords are hashed with scrypt and a per-user salt. Tokens are HMAC-signed with a server
secret and expire after 30 days. The account store sits next to `server.js`, not in the
dataset — the dataset gets copied and shared, and password hashes should not travel with it.

The server stamps who recorded each session from the token, overwriting whatever the client
claimed. Provenance the client can edit is not provenance.

## The interface

Light, high-contrast, in the idiom of a language-learning app: white cards on
paper grey, one saturated green for the action, controls with a hard bottom edge
that collapses when pressed.

Light rather than dark, after a long stretch of dark: recording happens outdoors
in daylight, and a dark screen in sun keeps only the contrast it started with.
White with near-black text is the highest-contrast thing a phone can show.

Colour has one job each, and the set is small enough to hold:

| | |
| --- | --- |
| green | do this — record, continue, accepted |
| red | stop — recording in progress, take rejected |
| yellow | you — streak and XP, nothing else |
| blue | the prompt — the Telugu being asked for |
| grey | everything structural |

The type is a system rounded stack. The obvious move would be Nunito or a
similar rounded face from a CDN, but the content policy allows `font-src 'self'`
and the app has to open with no signal, so weight and letter-spacing do the work
a downloaded face would.

The home screen is one set's path — a node per batch of ten words, exactly one
of them live and labelled. The other fourteen sets are behind the Sets tab: a
list of everything is a reference, not a first thing to read.

### What protects an account

| | |
| --- | --- |
| Passwords | scrypt with a per-user salt; minimum 10 characters, checked against the passwords attackers try first and refused if they contain the username |
| Guessing | 20 sign-in attempts per address per 15 minutes, and an account locks for 15 minutes after 8 wrong passwords |
| Stolen sessions | changing a password, or signing out everywhere, invalidates every token already issued |
| The page | content security policy allows nothing but this origin and forbids inline script and `eval`, so an injected script cannot read the session token |
| Framing | `frame-ancestors 'none'` and `X-Frame-Options: DENY` |
| Other origins | no CORS access unless an origin is listed in `SOLARIS_ALLOWED_ORIGINS` |
| Capabilities | `Permissions-Policy` allows the microphone and nothing else |
| Health endpoint | says only whether the server is up and whether sign-in is required — not the dataset path, not how many accounts exist |

Registration is open by default so contributors can start without a gatekeeper. Set
`SOLARIS_OPEN_REGISTRATION=false` for a closed study, or `SOLARIS_INVITE_CODE=...` to open it
only to people who were given the code.

**Still missing, and worth knowing before this faces the open internet:** there is no password
reset (an admin has to help), and the rate limiting is in-process — it resets when the server
restarts, and two servers behind a load balancer count separately. Move the counters into
Postgres before running more than one.

### Streaks

A streak is the number of consecutive **days** with at least one recording, in
`SOLARIS_TIMEZONE` (default `Asia/Kolkata`). Recording ten words in one afternoon is one day.
A streak that has lapsed reads as zero rather than showing the number it reached last month,
and marking a word as having no Banjara form does not break it — the streak is about turning
up, not about never saying "no word for this".

## What happens to a recording

```
getUserMedia ──► MediaRecorder ──► decode ──► resample to 16 kHz mono
                                                      │
                                                      ▼
                              background + noise removal  (public/dsp.js)
                                                      │
                            ┌─────────────────────────┴─────────────┐
                            ▼                                       ▼
                      quality grade                            WAV encode
                   (verdict on the spot)                            │
                                                                    ▼
                                                    POST /save ──► dataset/
```

No speech-to-text is involved. The Telugu prompt shown on screen *is* the transcript, so the
pairing is known before the speaker says anything — no API key, no round trip, nothing to
correct afterwards. The `/api/stt` proxy is still there for the legacy capture console under
`legacy/`, and stays unused by this app.

Both the cleaned and the original takes are written to disk. Filtering is lossy and its
thresholds are likely to be retuned later, so the source audio is always archived alongside
the processed version.

### The noise filtering

`public/dsp.js` is a JavaScript port of `backend/audio_processor.py` from the
`audio-splitter` branch — the same classical DSP, now running on the handset:

1. STFT the signal into a complex spectrogram.
2. Per time frame, compute **spectral flatness** — near 0 for tonal speech, near 1 for
   broadband hiss.
3. Per time-frequency bin, compute its **energy percentile** within that frame.
4. Threshold both into three non-overlapping masks:
   - `noise` — flatness above the threshold
   - `foreground` — not noise, and in the top energy percentile
   - `background` — everything else
5. Apply each mask to the complex spectrogram (phase preserved) and inverse-STFT back to a
   waveform.

The speaker is the `foreground` stem; that is what gets archived as the cleaned take and
sent for transcription.

Two deliberate differences from the Python original:

- **Window size.** `n_fft` is 1024 with a 256 hop, not 2048/512. At 16 kHz an `n_fft` of 2048
  is a 128 ms window, far too long to track a syllable.
- **Residual leak** (`residual: 0.08`). Hard binary masks leave isolated surviving bins that
  ring as "musical noise", which hurts recognition accuracy. A small amount of the discarded
  signal is folded back to mask that ringing. Set it to `0` for behaviour identical to the
  Python module.

It runs on the device rather than on a server because a field session may have no usable
uplink, and because the operator has to hear the cleaned audio before deciding to keep it.

---

## The database

Two backends, chosen by whether `SUPABASE_URL` is set:

| | Where | When |
| --- | --- | --- |
| **Supabase** | Postgres | The source of truth once configured |
| **files** | JSON next to `server.js` | No cloud configured — a field laptop, or the tests |

The file backend is not a leftover. Recording happens where the network does not
reach, and a kit that refuses to start because a cloud is unreachable is a kit
that does not work. Both implement the same interface in `db.js`, and every
method is async in both, so nothing can quietly depend on files being local.

### Moving to Supabase

```bash
# 1. create a project, then apply the schema
psql "$SUPABASE_DB_URL" -f db/schema.sql      # or paste it into the SQL editor

# 2. carry the words and any local accounts across
SUPABASE_URL=https://yourproject.supabase.co \
SUPABASE_SERVICE_KEY=... \
npm run migrate

# 3. put the same two values in .env and restart
npm start                                      # prints "Database: Supabase"
```

The migration is safe to re-run: every row is upserted on its primary key. It
carries the token-signing secret across too, so existing sign-ins survive the
move rather than everyone being logged out.

**The audio does not go in the database.** Recordings stay on disk (or move to
Supabase Storage) and the tables hold a path. A few hundred thousand WAV files
in Postgres would make the archive slow to query and awkward to copy,
checksum or hand to another institution.

**About the service key:** every table has row-level security enabled with no
permissive policy, so only the service role can read or write. That key stays on
the server and never reaches a browser. If the app is ever changed to talk to
Supabase directly from the phone, policies have to be written before that ships
— without them, `contributors` exposes every password hash.

### What is stored

| Table | Holds |
| --- | --- |
| `categories`, `words` | the prompt list imported from the tracker sheet |
| `contributors` | accounts, scrypt hashes, XP, streaks |
| `contributions` | one row per person per word, with quality and XP |
| `word_coverage` | a view: how many voices each word has |
| `sessions` | the run sheet for each sitting |
| `app_secrets` | the token-signing key, so a restart does not sign everyone out |

## Where a recording ends up

One saved word writes four objects under a key built from the contributor, the
word set and the prompt:

```
contributors/anirudh/places/tel_pl_037/
├── anirudh_tel_pl_037_banjara.wav       cleaned, 16 kHz mono — train on this
├── anirudh_tel_pl_037_banjara_raw.wav   untouched original
├── anirudh_tel_pl_037_telugu.txt        the prompt, which is the transcript
└── session.json                          quality scores, durations, filter settings
```

and one row in `contributions` tying contributor → word → quality → that key.

Where those objects live depends on configuration, and the same rule applies as
for the database: Supabase when configured, disk otherwise. **On a hosted
platform this matters more than anything else in this file** — Render, Fly and
Railway all wipe the local filesystem on every redeploy, so audio written to
disk there is audio that will be lost. Set `SUPABASE_URL` and the recordings go
to Supabase Storage, in a private bucket created on first boot.

Consent to contribute to a language archive is not consent to be published, so
the bucket is private and stays private. A single recording can be shared with
a time-limited signed link.

### Getting the data out

```bash
npm run export ./export
```

Reads the contributions table, downloads each recording from wherever it is
stored, and writes:

```
export/
├── audio/<contributor>/<category>/<word>/…wav
├── manifest.jsonl     one JSON object per line — what most training code wants
└── manifest.csv       the same thing for a spreadsheet
```

Each manifest row carries the audio path, the Telugu prompt and its
transliteration and gloss, the word id and category, the contributor, the
quality score and the sample rate. That pairing is the dataset: a folder of WAVs
with no index is not one, and the link between a Banjara recording and its
Telugu prompt lives in the database rather than in the audio.

Re-running skips what it already has, so an interrupted export continues.

## Deploying

The app is plain Node with no dependencies and no build step, so the image is
the runtime plus this repository.

Any host that runs a container will do. `DEPLOY.md` has the steps for the
usual ones; the whole of what a platform has to provide is two environment
variables, a port, and TLS.

```bash
docker build -t solaris .
docker run -p 3001:3001 \
  -e SUPABASE_URL=https://yourproject.supabase.co \
  -e SUPABASE_SERVICE_KEY=sb_secret_... \
  solaris
```

Three things to get right whatever the platform:

- **TLS must be terminated for you.** Browsers only release the microphone on a
  secure origin, and a self-signed certificate means every contributor taps
  through a warning — which teaches exactly the wrong instinct. A real
  certificate is the difference between a demo and something people use.
- **`SOLARIS_TRUST_PROXY=true`**, but only behind a proxy. The rate limiter
  counts per address, and behind a load balancer every request otherwise looks
  like it came from the balancer. Set it where it is not true and anyone can
  spoof a header for a fresh quota.
- **Do not let the platform sleep the process.** A free tier that idles will
  drop the request that wakes it, and that request is somebody's recording.

The service key belongs in the platform's secret store, never in the repository.
`.env` is gitignored; `.dockerignore` keeps it out of the image as well.

## Storage, and the move to cloud

Everything saved goes through one seam, `public/store.js`:

```js
SolarisStore.save(record)   // persist one session
SolarisStore.pending()      // sessions waiting to upload
SolarisStore.flush()        // retry the queue
```

Today the active backend is `server`, which POSTs to `/save` and writes to the dataset folder
on the machine running the server. When that machine is unreachable — which on a phone
happens constantly — the session is written to IndexedDB instead and retried later, so a
walk out of Wi-Fi range never costs a take. The queued count appears next to the save button.

Moving to the cloud is a change to this one file and nothing else:

```js
SolarisStore.register('cloud', {
  name: 'cloud',
  available: () => fetch(API + '/ping').then(r => r.ok).catch(() => false),
  put: async (record) => {
    // upload record.blobs, return { savedTo, files }
  },
});
SolarisStore.use('cloud');
```

The queue, the retry logic and every caller depend only on `available()` and `put()`.

### Layout on disk

```
dataset/contributors/fieldworker/
├── family/
│   ├── amma/
│   │   ├── fieldworker_amma_banjara.wav       cleaned
│   │   ├── fieldworker_amma_banjara_raw.wav   original
│   │   ├── fieldworker_amma_telugu.txt        the prompt, which is the transcript
│   │   └── session.json                       scores, durations, filter settings, who recorded it
│   └── nanna/ …
├── animals/ …
└── logs/2026-08-18T06-47-12-082Z.json         prompt order, skips, timings, XP
```

The contributor is the signed-in account: the person recording is the person speaking, so
there is no separate speaker field to fill in. Paths carry no session number, because opening
a word set is not a numbered sitting — only the words contributed are counted.

---

## What made the old page unusable on a phone

| Problem | Fix |
| --- | --- |
| Server bound to `127.0.0.1` | Binds `0.0.0.0`; prints the LAN URL to open on the phone |
| Dataset path hardcoded to `C:\Users\asus\...` | `SOLARIS_DATASET_DIR`, cross-platform, defaults to `./dataset` |
| `mimeType: 'audio/webm;codecs=opus'` | Safari has never supported WebM and threw on every iPhone. Codecs are now feature-detected, with MP4/AAC fallback |
| Microphone silently blocked over LAN | HTTPS support, plus an explicit on-screen explanation when the context is insecure |
| 14px inputs | 16px — below that, iOS zooms the page on focus and the layout jumps |
| Fixed desktop grids, 32px padding | Mobile-first layout, safe-area insets for notches, collapsible metadata, sticky save bar |
| API keys in page source | Server-side proxy; keys never leave the machine |
| Second-counting `setInterval` timer | Wall-clock timer — mobile browsers throttle timers when the screen dims, and a counted interval under-reports |
| Waveform library + fonts from a CDN | Waveforms drawn on canvas, system fonts — the app works with no uplink |
| Lost work on a stray back-swipe | Unload guard while a take is in progress |
| Screen sleeping mid-recording | Wake Lock held while recording |

The earlier interfaces are kept under `legacy/` for reference: `desktop-index.html` is the
original single-file page, and `capture-*.js/css/html` is the dense form-based capture
console this app replaced.

---

## Tests

```bash
npm test          # DSP, front-end wiring, and server integration — no browser needed
```

```bash
npm install --no-save playwright
npm run test:e2e  # full capture flow in a real browser at iPhone viewport
```

`npm test` covers the FFT against a naive DFT, the perfect-reconstruction invariant (the
three stems must sum back to the original signal), path-traversal containment on `/save`,
the STT proxy's failure modes, and the contract between `app.js` and `index.html`.

The end-to-end run drives record → filter → grade → save with Chrome's fake microphone,
checks for horizontal overflow and undersized tap targets at phone width, verifies the WAV
that lands on disk, and writes screenshots to `tests/screenshots/`.

---

## Configuration

All optional; read from the environment or a `.env` file next to `server.js`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | Listen port |
| `SOLARIS_DATASET_DIR` | `./dataset` | Where recordings are written |
| `SARVAM_API_KEY` | — | Enables the Sarvam engine; blank disables it |
| `GROQ_API_KEY` | — | Enables the Groq engine; blank disables it |
| `SARVAM_MODEL` | `saarika:v2.5` | |
| `GROQ_MODEL` | `whisper-large-v3-turbo` | |
| `SSL_CERT` / `SSL_KEY` | `./certs/*.pem` | HTTPS; falls back to HTTP if absent |
| `SOLARIS_USERS_FILE` | `./.solaris-users.json` | Account store (hashes and token secret) |

With no key configured the app says so and falls back to manual transcription rather than
failing the session.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | `{ status, basePath, secure, engines }` |
| `POST` | `/save` | multipart: audio + transcript + metadata → dataset |
| `POST` | `/api/stt` | multipart: `file`, `engine` → `{ transcript }` |
| `POST` | `/api/auth/register` | `{username, password, displayName}` → `{user, token}` |
| `POST` | `/api/auth/login` | `{username, password}` → `{user, token}` |
| `GET` | `/api/auth/me` | bearer token → `{user}` |
| `POST` | `/api/session-log` | the run sheet for one session → `{profile}` |

`/save`, `/api/stt` and `/api/session-log` require a bearer token once an account exists.

## Branches

| Branch | Contents |
| --- | --- |
| `mobile` | This version — account-gated portal, on-device filtering, storage seam |
| `main` | Original single-file desktop interface |
| `working_proto`, `current_workingproto` | Near-identical earlier copies of `main` |
| `prototype_01` | Earlier single-file `solaris.html` |
| `audio-splitter` | Separate Python/FastAPI stem splitter — source of the filtering algorithm |
