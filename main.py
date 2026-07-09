import io
import os
import asyncio
import re
import json
import uuid
import soundfile as sf
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List, Dict
from kokoro_onnx import Kokoro
from concurrent.futures import ThreadPoolExecutor
from functools import partial

# ─── Configuration ───
PDF_DIR = os.getenv("PDF_DIR", "/home/pk/books/books/language")
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", "./tts_cache")
KOKORO_MODEL_PATH = os.getenv("KOKORO_MODEL", "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH = os.getenv("KOKORO_VOICES", "voices-v1.0.bin")
MAX_WORKERS = int(os.getenv("TTS_WORKERS", "1"))

os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

app = FastAPI(title="DocReader Pro Backend")

# ─── CORS ───
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cached", "X-Cache-Path"],
)

# ─── Serve the HTML page at the root ───
# Place your index.html in the same directory as this script.
# Or you can serve it from a static directory.
@app.get("/", response_class=HTMLResponse)
async def serve_index():
    # If you have index.html in the same folder, read and return it.
    # Otherwise, you can mount a static folder.
    with open("index.html", "r", encoding="utf-8") as f:
        return f.read()

# Alternatively, if you want to keep your HTML separate, you can mount a static directory:
# app.mount("/", StaticFiles(directory=".", html=True), name="static")

# ─── Kokoro model (global, with lock for thread safety) ───
kokoro = None
_model_lock = asyncio.Lock()
_tts_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)

try:
    print("Loading Kokoro model...")
    kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
    print("Model loaded.")
except Exception as e:
    print(f"Error loading Kokoro: {e}")
    kokoro = None

# ─── Background preload jobs ───
_preload_jobs: Dict[str, dict] = {}
_preload_lock = asyncio.Lock()
_page_processing_semaphore = asyncio.Semaphore(3)

# ─── Helper functions ───

def sanitize_filename(name: str) -> str:
    name = os.path.splitext(name)[0]
    name = re.sub(r'[^\w\s\-]', '', name)
    name = re.sub(r'\s+', '_', name.strip())
    return name or "unknown_book"

def get_book_dir(book_name: str) -> str:
    safe = sanitize_filename(book_name)
    path = os.path.join(AUDIO_CACHE_DIR, safe)
    os.makedirs(path, exist_ok=True)
    return path

def wav_path(book_dir: str, page: int, line: int) -> str:
    return os.path.join(book_dir, f"{page}_{line}.wav")

def get_settings_path(book_name: str) -> str:
    book_dir = get_book_dir(book_name)
    return os.path.join(book_dir, "settings.json")

def load_settings(book_name: str) -> dict:
    path = get_settings_path(book_name)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

def save_settings(book_name: str, data: dict) -> None:
    path = get_settings_path(book_name)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

# ─── Pydantic models ───

class TextPayload(BaseModel):
    text: str
    voice: str = "af_sarah"
    speed: float = 1.0

class PreloadPayload(BaseModel):
    book_name: str
    page_from: int
    page_to: int
    sentences: Dict[str, str]
    voice: str = "af_sarah"

class SettingsPayload(BaseModel):
    book_name: str
    page: int
    scale: float
    sentenceIndex: int = 0

# ─── Core TTS synthesis ───

async def synthesize_audio(text: str, voice: str, speed: float = 1.0) -> bytes:
    if not kokoro:
        raise HTTPException(status_code=503, detail="Kokoro model not loaded.")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    func = partial(kokoro.create, text, voice=voice, speed=speed, lang="en-us")
    loop = asyncio.get_running_loop()
    async with _model_lock:
        audio_data, sample_rate = await loop.run_in_executor(_tts_executor, func)

    if len(audio_data) == 0:
        raise ValueError("Model generated empty audio.")

    wav_io = io.BytesIO()
    sf.write(wav_io, audio_data, sample_rate, format='WAV', subtype='PCM_16')
    wav_io.seek(0)
    return wav_io.read()

# ─── Endpoints ───

@app.get("/health")
async def health():
    return {"status": "ok", "model_loaded": kokoro is not None}

@app.get("/pdfs")
async def list_pdfs():
    if not os.path.isdir(PDF_DIR):
        return {"pdfs": []}
    pdfs = []
    for fname in sorted(os.listdir(PDF_DIR)):
        if not fname.lower().endswith(".pdf"):
            continue
        fpath = os.path.join(PDF_DIR, fname)
        try:
            size = os.path.getsize(fpath)
            pdfs.append({
                "name": fname,
                "size": size,
                "url": f"/pdfs/{fname}",
            })
        except OSError:
            pass
    return {"pdfs": pdfs}

@app.get("/pdfs/{filename}")
async def serve_pdf(filename: str):
    safe_name = os.path.basename(filename)
    if not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are served.")
    fpath = os.path.join(PDF_DIR, safe_name)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail="PDF not found.")
    return FileResponse(fpath, media_type="application/pdf", filename=safe_name)

# ─── Settings endpoints (NEW) ───

@app.get("/settings")
async def get_settings(book_name: str):
    data = load_settings(book_name)
    return {
        "book_name": book_name,
        "page": data.get("page", 1),
        "scale": data.get("scale", 1.5),
        "sentenceIndex": data.get("sentenceIndex", 0),
    }

@app.post("/settings")
async def set_settings(payload: SettingsPayload):
    if payload.page < 1:
        raise HTTPException(status_code=400, detail="Invalid page number")
    save_settings(payload.book_name, payload.dict())
    return {"status": "ok"}

# ─── TTS synthesis ───

@app.post("/synthesize")
async def synthesize_post(
    payload: TextPayload,
    x_book_name: Optional[str] = Header(default=None),
    x_save_audio: Optional[str] = Header(default=None),
    x_page_number: Optional[str] = Header(default=None),
    x_line_number: Optional[str] = Header(default=None),
):
    save = (x_save_audio or "false").lower() == "true"
    book = x_book_name or ""
    page = int(x_page_number) if x_page_number and x_page_number.isdigit() else None
    line = int(x_line_number) if x_line_number and x_line_number.isdigit() else None

    can_cache = bool(book and page is not None and line is not None)

    if can_cache:
        book_dir = get_book_dir(book)
        cache_file = wav_path(book_dir, page, line)

        if not save and os.path.exists(cache_file):
            return FileResponse(
                cache_file,
                media_type="audio/wav",
                headers={"X-Cached": "true"},
            )

    synthesis_speed = 1.0 if (save and can_cache) else payload.speed
    wav_bytes = await synthesize_audio(payload.text, payload.voice, synthesis_speed)

    if save and can_cache:
        with open(cache_file, "wb") as f:
            f.write(wav_bytes)

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={"X-Cached": "false"},
    )

@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    wav_bytes = await synthesize_audio(text, voice, speed)
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")

# ─── Preload ───

async def _run_preload_job(job_id: str, payload: PreloadPayload):
    book_dir = get_book_dir(payload.book_name)
    total = len(payload.sentences)
    done = 0
    errors = 0

    def sort_key(k):
        parts = k.split("_")
        return (int(parts[0]), int(parts[1]))

    sorted_items = sorted(payload.sentences.items(), key=lambda kv: sort_key(kv[0]))

    async with _page_processing_semaphore:
        for key, text in sorted_items:
            try:
                parts = key.split("_")
                page, line = int(parts[0]), int(parts[1])
            except (ValueError, IndexError):
                errors += 1
                continue

            cache_file = wav_path(book_dir, page, line)
            if os.path.exists(cache_file):
                done += 1
                async with _preload_lock:
                    _preload_jobs[job_id]["done"] = done
                continue

            try:
                wav_bytes = await synthesize_audio(text, payload.voice, speed=1.0)
                with open(cache_file, "wb") as f:
                    f.write(wav_bytes)
                done += 1
            except Exception as e:
                print(f"[PRELOAD ERROR] {key}: {e}")
                errors += 1

            async with _preload_lock:
                _preload_jobs[job_id]["done"] = done
                _preload_jobs[job_id]["errors"] = errors

            await asyncio.sleep(0)

    async with _preload_lock:
        _preload_jobs[job_id]["status"] = "done"

@app.post("/preload")
async def preload(payload: PreloadPayload, background_tasks: BackgroundTasks):
    job_id = str(uuid.uuid4())
    async with _preload_lock:
        _preload_jobs[job_id] = {
            "status": "running",
            "total": len(payload.sentences),
            "done": 0,
            "errors": 0,
            "book": payload.book_name,
        }
    background_tasks.add_task(_run_preload_job, job_id, payload)
    return {"job_id": job_id, "total": len(payload.sentences)}

@app.get("/preload_status")
async def preload_status(job_id: str):
    async with _preload_lock:
        job = _preload_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job

@app.post("/preload_status_bulk")
async def preload_status_bulk(job_ids: List[str]):
    async with _preload_lock:
        return {jid: _preload_jobs.get(jid) for jid in job_ids}

@app.get("/preload_jobs")
async def list_preload_jobs():
    async with _preload_lock:
        return list(_preload_jobs.values())

# ─── Cache status ───

@app.get("/cache_status")
async def cache_status(book_name: str, page: int):
    book_dir = get_book_dir(book_name)
    if not os.path.isdir(book_dir):
        return {"cached_lines": []}
    prefix = f"{page}_"
    cached = []
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            try:
                line = int(fname[len(prefix):-4])
                cached.append(line)
            except ValueError:
                pass
    return {"cached_lines": sorted(cached)}

@app.get("/cache_status_bulk")
async def cache_status_bulk(book_name: str, page_from: int, page_to: int):
    book_dir = get_book_dir(book_name)
    result = {}
    if os.path.isdir(book_dir):
        all_files = os.listdir(book_dir)
        for p in range(page_from, page_to + 1):
            prefix = f"{p}_"
            cached = []
            for fname in all_files:
                if fname.startswith(prefix) and fname.endswith(".wav"):
                    try:
                        line = int(fname[len(prefix):-4])
                        cached.append(line)
                    except ValueError:
                        pass
            result[str(p)] = sorted(cached)
    else:
        for p in range(page_from, page_to + 1):
            result[str(p)] = []
    return {"pages": result}

# ─── Optional upload endpoint ───
@app.post("/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "Only PDF files are allowed")
    safe_name = os.path.basename(file.filename)
    fpath = os.path.join(PDF_DIR, safe_name)
    if os.path.exists(fpath):
        raise HTTPException(409, f"File {safe_name} already exists on server")
    with open(fpath, "wb") as f:
        content = await file.read()
        f.write(content)
    return {"status": "uploaded", "filename": safe_name}

# ─── Run with: uvicorn server:app --host 0.0.0.0 --port 8000
