"""
main.py - FastAPI backend for the audio stem-splitter.

Endpoints
---------
POST /api/upload
    Accepts a multipart file upload (wav/mp3), saves it under a
    per-request UUID, and returns a job_id.

POST /api/process/{job_id}
    Runs the threshold-based separation (audio_processor.separate_audio)
    on the uploaded file for that job_id. Accepts optional JSON body with
    threshold overrides. Returns URLs for the three generated stems.

GET /api/download/{job_id}/{stem}
    Streams one of foreground.wav / background.wav / noise.wav back to
    the client as a file download.

GET /api/waveform/{job_id}/{stem}
    Returns a small downsampled array of peak values for drawing a quick
    waveform preview client-side (used if you don't wire up WaveSurfer.js
    directly against the audio URL).

Security notes
---------------
- Uploaded filenames are never trusted directly; every job gets a random
  UUID directory, and only a fixed allow-list of stem names
  (foreground/background/noise/original) can be requested for download -
  this prevents path traversal.
- File extension + content-type are checked against an allow-list
  (.wav/.mp3) before saving.
- A max upload size is enforced.
"""

import os
import uuid
import shutil
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, UploadFile, File, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel

from audio_processor import SeparationParams, separate_audio, save_wav

BASE_DIR = Path(__file__).parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)

ALLOWED_EXTENSIONS = {".wav", ".mp3"}
ALLOWED_STEMS = {"foreground", "background", "noise", "original"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

app = FastAPI(title="Audio Stem Splitter API")

# Allow the static frontend (served from a different port/file://) to call us.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class ProcessRequest(BaseModel):
    noise_threshold: Optional[float] = 0.35
    foreground_percentile: Optional[float] = 70.0


def _job_dir(job_id: str) -> Path:
    """Resolve (and validate) the directory for a given job id."""
    # uuid.UUID() raises ValueError if job_id isn't a well-formed UUID,
    # which blocks path-traversal attempts like "../../etc".
    uuid.UUID(job_id)
    d = OUTPUT_DIR / job_id
    if not d.exists():
        raise HTTPException(status_code=404, detail="Unknown job_id")
    return d


@app.post("/api/upload")
async def upload_audio(file: UploadFile = File(...)):
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {sorted(ALLOWED_EXTENSIONS)}",
        )

    job_id = str(uuid.uuid4())
    job_upload_dir = UPLOAD_DIR / job_id
    job_upload_dir.mkdir(parents=True, exist_ok=True)
    job_output_dir = OUTPUT_DIR / job_id
    job_output_dir.mkdir(parents=True, exist_ok=True)

    dest_path = job_upload_dir / f"original{ext}"

    size = 0
    with open(dest_path, "wb") as out_file:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > MAX_UPLOAD_BYTES:
                out_file.close()
                shutil.rmtree(job_upload_dir, ignore_errors=True)
                shutil.rmtree(job_output_dir, ignore_errors=True)
                raise HTTPException(status_code=413, detail="File too large (max 50 MB).")
            out_file.write(chunk)

    return {"job_id": job_id, "filename": dest_path.name, "size_bytes": size}


@app.post("/api/process/{job_id}")
async def process_audio(job_id: str, body: ProcessRequest = Body(default=ProcessRequest())):
    uuid.UUID(job_id)  # validate shape
    job_upload_dir = UPLOAD_DIR / job_id
    job_output_dir = OUTPUT_DIR / job_id

    if not job_upload_dir.exists():
        raise HTTPException(status_code=404, detail="Unknown job_id. Upload a file first.")

    # find the original upload regardless of its extension
    originals = list(job_upload_dir.glob("original.*"))
    if not originals:
        raise HTTPException(status_code=404, detail="No uploaded audio found for this job.")
    input_path = originals[0]

    params = SeparationParams(
        noise_threshold=float(body.noise_threshold),
        foreground_percentile=float(body.foreground_percentile),
    )

    try:
        foreground, background, noise, sr = separate_audio(str(input_path), params)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Failed to process audio: {e}")

    job_output_dir.mkdir(parents=True, exist_ok=True)
    save_wav(str(job_output_dir / "foreground.wav"), foreground, sr)
    save_wav(str(job_output_dir / "background.wav"), background, sr)
    save_wav(str(job_output_dir / "noise.wav"), noise, sr)

    return {
        "job_id": job_id,
        "sample_rate": sr,
        "stems": {
            "foreground": f"/api/download/{job_id}/foreground",
            "background": f"/api/download/{job_id}/background",
            "noise": f"/api/download/{job_id}/noise",
        },
    }


@app.get("/api/download/{job_id}/{stem}")
async def download_stem(job_id: str, stem: str):
    if stem not in ALLOWED_STEMS:
        raise HTTPException(status_code=400, detail="Invalid stem name.")

    job_output_dir = _job_dir(job_id)

    if stem == "original":
        job_upload_dir = UPLOAD_DIR / job_id
        matches = list(job_upload_dir.glob("original.*"))
        if not matches:
            raise HTTPException(status_code=404, detail="Original file not found.")
        path = matches[0]
    else:
        path = job_output_dir / f"{stem}.wav"
        if not path.exists():
            raise HTTPException(status_code=404, detail=f"{stem}.wav not generated yet. Call /api/process first.")

    return FileResponse(path, media_type="audio/wav", filename=path.name)


@app.get("/api/health")
async def health():
    return {"status": "ok"}
