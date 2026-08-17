# Stemwork — Audio Stem Splitter

Open-source, threshold-based audio separator. Splits an uploaded or
recorded clip into **foreground**, **background**, and **noise** stems
using classical DSP (STFT + spectral flatness + relative energy
thresholding) — no black-box model required, though you can swap in
Demucs/Spleeter later (see "Upgrading separation quality" below).

```
audio-splitter/
├── backend/
│   ├── main.py              FastAPI app (upload / process / download)
│   ├── audio_processor.py   Separation algorithm (heavily commented)
│   ├── requirements.txt
│   ├── uploads/              (created at runtime)
│   └── outputs/               (created at runtime)
└── frontend/
    ├── index.html
    ├── style.css
    └── app.js
```

## 1. Backend setup

Requires Python 3.10+ and `ffmpeg` on your PATH (used by librosa/audioread
for MP3 and browser-recorded webm decoding).

```bash
cd backend
python -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate

pip install -r requirements.txt

# macOS: brew install ffmpeg
# Ubuntu/Debian: sudo apt install ffmpeg
# Windows: https://ffmpeg.org/download.html

uvicorn main:app --reload --port 8000
```

The API is now live at `http://localhost:8000`. Interactive docs are
auto-generated at `http://localhost:8000/docs`.

## 2. Frontend setup

The frontend is static, so any local web server works:

```bash
cd frontend
python -m http.server 5500
```

Open `http://localhost:5500` in your browser. If your backend runs on a
different host/port, update `API_BASE` at the top of `app.js`.

> Microphone recording requires either `localhost` or HTTPS — browsers
> block `getUserMedia` on plain HTTP over a network IP.

## 3. Using it

1. Drop a `.wav`/`.mp3` file, or click **Record from microphone**.
2. Optionally adjust the two thresholds:
   - **Noise sensitivity** — spectral-flatness cutoff; raise it if too
     much real signal is being classified as noise.
   - **Foreground cutoff** — energy percentile; raise it if the
     foreground stem is picking up too much of the background.
3. Click **Split audio**. The backend runs the separation and returns
   three WAV files you can preview, play, and download.

## 4. API reference (for using it from your other project)

| Method | Path                            | Purpose                                   |
|--------|----------------------------------|--------------------------------------------|
| POST   | `/api/upload`                   | multipart file upload → `{ job_id }`       |
| POST   | `/api/process/{job_id}`         | run separation → `{ stems: { foreground, background, noise } }` (URLs) |
| GET    | `/api/download/{job_id}/{stem}` | download `foreground`/`background`/`noise`/`original` |
| GET    | `/api/health`                   | liveness check                             |

Example, pulling just the foreground track into another project:

```python
import requests

BASE = "http://localhost:8000"

job_id = requests.post(
    f"{BASE}/api/upload",
    files={"file": open("meeting.wav", "rb")},
).json()["job_id"]

requests.post(f"{BASE}/api/process/{job_id}", json={
    "noise_threshold": 0.35,
    "foreground_percentile": 70,
})

foreground_audio = requests.get(f"{BASE}/api/download/{job_id}/foreground").content
open("foreground.wav", "wb").write(foreground_audio)
```

## 5. How the separation works

See the docstring at the top of `backend/audio_processor.py` for the
full explanation. Summary:

1. STFT the signal → complex spectrogram (magnitude + phase).
2. Per time frame, compute **spectral flatness** (tonal vs. noise-like).
3. Per time-frequency bin, compute its **energy percentile** relative to
   the rest of that frame.
4. Threshold those two features into three non-overlapping masks:
   `noise` (high flatness) → `foreground` (low flatness, high energy
   percentile) → `background` (everything else).
5. Apply each mask to the original complex spectrogram (preserving
   phase) and inverse-STFT back to a waveform.

This is a fully transparent, tunable heuristic — good for a first pass,
podcast/voice cleanup, or as a fast pre-filter. It will not separate,
say, two singers at the same volume in the same frequency range; that
needs a trained source-separation model.

## 6. Upgrading separation quality (optional)

For higher-fidelity separation (e.g. true vocal isolation), swap the
body of `separate_audio()` for a call to a pretrained model instead of
(or in addition to) the threshold masks:

```bash
pip install demucs
```

```python
# example sketch — run Demucs, then further split its "vocals" stem
# into foreground/background/noise with the same threshold logic if
# you still want three outputs instead of Demucs' four stems.
```

Keep the FastAPI routes and frontend unchanged — only
`audio_processor.py` needs to change, since the rest of the app only
depends on getting back three `np.ndarray` waveforms + a sample rate.

## 7. Notes on the "patented" part of the request

There's no single algorithm you need to reverse-engineer here — energy/
frequency-threshold based audio segmentation (what this project
implements) is standard, decades-old DSP built from openly published
techniques (STFT, spectral flatness, HPSS, etc.), all implemented with
open-source libraries (`librosa`, `numpy`, `scipy`). It's a reasonable
foundation for an open-source tool. If you're specifically trying to
replicate one named commercial product's exact behavior, avoid copying
its implementation/code or infringing its claims — you can always
reimplement independently from the published DSP theory, as this
project does, or build/train your own model.
