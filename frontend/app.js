// app.js
// Wires up the Stemwork UI to the FastAPI backend:
//   - file upload / drag-drop
//   - in-browser recording (MediaRecorder API)
//   - threshold sliders
//   - calling /api/upload -> /api/process -> rendering results
//   - lightweight canvas waveform preview (decoded client-side via Web Audio API)

const API_BASE = "http://localhost:8000"; // change if backend runs elsewhere

// ---------- DOM refs ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const recordBtn = document.getElementById("recordBtn");
const recordTimer = document.getElementById("recordTimer");
const processBtn = document.getElementById("processBtn");
const statusLine = document.getElementById("statusLine");
const emptyState = document.getElementById("emptyState");
const stemList = document.getElementById("stemList");

const noiseThresholdInput = document.getElementById("noiseThreshold");
const noiseThresholdVal = document.getElementById("noiseThresholdVal");
const fgPercentileInput = document.getElementById("fgPercentile");
const fgPercentileVal = document.getElementById("fgPercentileVal");

// ---------- State ----------
let selectedFile = null;      // File object, either chosen or recorded
let mediaRecorder = null;
let recordedChunks = [];
let recordTimerHandle = null;
let recordSeconds = 0;
let currentJobId = null;

// ---------- Slider labels ----------
noiseThresholdInput.addEventListener("input", () => {
  noiseThresholdVal.textContent = noiseThresholdInput.value;
});
fgPercentileInput.addEventListener("input", () => {
  fgPercentileVal.textContent = fgPercentileInput.value;
});

// ---------- File selection (click) ----------
fileInput.addEventListener("change", () => {
  if (fileInput.files.length > 0) {
    setSelectedFile(fileInput.files[0]);
  }
});

// ---------- Drag & drop ----------
["dragenter", "dragover"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag-over");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("drag-over");
  })
);
dropzone.addEventListener("drop", (e) => {
  const file = e.dataTransfer.files[0];
  if (file) setSelectedFile(file);
});

function setSelectedFile(file) {
  const okTypes = [".wav", ".mp3"];
  const lower = file.name.toLowerCase();
  if (!okTypes.some((ext) => lower.endsWith(ext))) {
    showStatus("Please choose a .wav or .mp3 file.", true);
    return;
  }
  selectedFile = file;
  fileNameEl.textContent = `Selected: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`;
  processBtn.disabled = false;
  showStatus("");
}

// ---------- Recording ----------
recordBtn.addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recordTimerHandle);
      recordBtn.classList.remove("record-btn-active");
      recordBtn.innerHTML = `<span class="dot" aria-hidden="true"></span> Record from microphone`;

      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      const file = new File([blob], "recording.wav", { type: "audio/wav" });
      // Note: browsers record to webm/ogg containers, not true wav. We keep
      // the .wav name for the backend's extension check but send the real
      // blob type; the backend/ffmpeg-based decoders (librosa/soundfile via
      // audioread) can still read webm/ogg in most environments. For strict
      // WAV-only setups, transcode client-side or accept audio/webm server-side.
      setSelectedFile(file);
    };

    mediaRecorder.start();
    recordSeconds = 0;
    recordTimer.textContent = "00:00";
    recordTimerHandle = setInterval(() => {
      recordSeconds += 1;
      const m = String(Math.floor(recordSeconds / 60)).padStart(2, "0");
      const s = String(recordSeconds % 60).padStart(2, "0");
      recordTimer.textContent = `${m}:${s}`;
    }, 1000);

    recordBtn.classList.add("record-btn-active");
    recordBtn.innerHTML = `<span class="dot" aria-hidden="true"></span> Stop recording`;
  } catch (err) {
    showStatus("Microphone access was denied or unavailable.", true);
  }
});

// ---------- Process button ----------
processBtn.addEventListener("click", async () => {
  if (!selectedFile) return;

  processBtn.disabled = true;
  showStatus("Uploading audio…");

  try {
    const jobId = await uploadFile(selectedFile);
    currentJobId = jobId;

    showStatus("Splitting into foreground / background / noise…");

    const result = await processJob(jobId, {
      noise_threshold: parseFloat(noiseThresholdInput.value),
      foreground_percentile: parseFloat(fgPercentileInput.value),
    });

    renderStems(jobId, result.stems);
    showStatus("Done. Stems are ready below.");
  } catch (err) {
    console.error(err);
    showStatus(err.message || "Something went wrong while processing.", true);
  } finally {
    processBtn.disabled = false;
  }
});

async function uploadFile(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    body: formData,
  });
  if (!res.ok) {
    const detail = await safeDetail(res);
    throw new Error(`Upload failed: ${detail}`);
  }
  const data = await res.json();
  return data.job_id;
}

async function processJob(jobId, thresholds) {
  const res = await fetch(`${API_BASE}/api/process/${jobId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(thresholds),
  });
  if (!res.ok) {
    const detail = await safeDetail(res);
    throw new Error(`Processing failed: ${detail}`);
  }
  return res.json();
}

async function safeDetail(res) {
  try {
    const data = await res.json();
    return data.detail || res.statusText;
  } catch {
    return res.statusText;
  }
}

// ---------- Render results ----------
function renderStems(jobId, stems) {
  emptyState.hidden = true;
  stemList.hidden = false;

  Object.entries(stems).forEach(([stem, path]) => {
    const url = `${API_BASE}${path}`;

    const audioEl = document.querySelector(`.stem-audio[data-stem="${stem}"]`);
    const linkEl = document.querySelector(`.stem-download[data-stem="${stem}"]`);
    const canvasEl = document.querySelector(`canvas.waveform[data-stem="${stem}"]`);

    audioEl.src = url;
    linkEl.href = url;
    linkEl.setAttribute("download", `${stem}.wav`);

    drawWaveform(url, canvasEl, stem);
  });
}

// ---------- Lightweight client-side waveform preview ----------
async function drawWaveform(url, canvas, stem) {
  try {
    const res = await fetch(url);
    const arrayBuffer = await res.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
    const raw = audioBuffer.getChannelData(0);

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 300;
    const height = canvas.height;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    const samplesPerPixel = Math.max(1, Math.floor(raw.length / width));
    const colorMap = {
      foreground: "#ffb454",
      background: "#5ec8c0",
      noise: "#ef5d76",
    };
    ctx.fillStyle = colorMap[stem] || "#e8ecf2";

    for (let x = 0; x < width; x++) {
      let min = 1.0, max = -1.0;
      const start = x * samplesPerPixel;
      const end = Math.min(start + samplesPerPixel, raw.length);
      for (let i = start; i < end; i++) {
        const v = raw[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const yMin = (1 + min) * (height / 2);
      const yMax = (1 + max) * (height / 2);
      ctx.fillRect(x, yMin, 1, Math.max(1, yMax - yMin));
    }
    audioCtx.close();
  } catch (e) {
    // Non-fatal: waveform preview is a bonus feature, playback still works.
    console.warn(`Could not draw waveform for ${stem}:`, e);
  }
}

// ---------- Status helper ----------
function showStatus(msg, isError = false) {
  statusLine.textContent = msg;
  statusLine.classList.toggle("error", isError);
}
