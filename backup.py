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
import numpy as np  # add this at the top if not already there

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

# ─── Serve static assets ───
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return HTMLResponse("<h1>DocReader Pro</h1><p>index.html not found.</p>", status_code=404)

# ─── Kokoro model ───
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
_page_processing_semaphore = asyncio.Semaphore(2)

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

def get_durations_path(book_dir: str) -> str:
    return os.path.join(book_dir, "durations.json")

def load_durations(book_dir: str) -> dict:
    path = get_durations_path(book_dir)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError):
        return {}

def save_durations(book_dir: str, durations: dict):
    path = get_durations_path(book_dir)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(durations, f, indent=2)

def get_duration_seconds(wav_path: str) -> float:
    try:
        info = sf.info(wav_path)
        return info.duration
    except Exception:
        return 0.0

def update_duration(book_dir: str, page: int, line: int, duration: float):
    durations = load_durations(book_dir)
    key = f"{page}_{line}"
    durations[key] = duration
    save_durations(book_dir, durations)

def backfill_page_durations(book_dir: str, page: int):
    """Compute and store durations for all WAV files of a given page, if missing."""
    durations = load_durations(book_dir)
    prefix = f"{page}_"
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            key = fname[:-4]  # remove .wav
            if key not in durations:
                wav_file = os.path.join(book_dir, fname)
                dur = get_duration_seconds(wav_file)
                if dur > 0:
                    durations[key] = dur
    if durations:
        save_durations(book_dir, durations)

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

# ─── Last document persistence ───
LAST_DOC_FILE = os.path.join(AUDIO_CACHE_DIR, "last_document.json")

def get_last_document() -> Optional[str]:
    if os.path.exists(LAST_DOC_FILE):
        try:
            with open(LAST_DOC_FILE, "r") as f:
                data = json.load(f)
                return data.get("filename")
        except:
            pass
    return None

def set_last_document(filename: str):
    with open(LAST_DOC_FILE, "w") as f:
        json.dump({"filename": filename}, f)

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
    speed: float = 1.0

class LastDocPayload(BaseModel):
    filename: str

class DeleteCacheRangePayload(BaseModel):
    book_name: str
    page_from: int
    page_to: int

# ─── Core TTS synthesis ───

async def synthesize_audio(text: str, voice: str, speed: float = 1.0) -> bytes:
    if not kokoro:
        raise HTTPException(status_code=503, detail="Kokoro model not loaded.")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    func = partial(kokoro.create, text, voice=voice, speed=speed, lang="en-us")
    loop = asyncio.get_running_loop()

    try:
        audio_data, sample_rate = await loop.run_in_executor(_tts_executor, func)

    except IndexError as e:
        if "index 510 is out of bounds" not in str(e):
            raise

        # Kokoro phoneme overflow — split at midpoint sentence boundary and merge
        mid = len(text) // 2
        cut = max(text.rfind('.', 0, mid), text.rfind('!', 0, mid), text.rfind('?', 0, mid))
        if cut <= 0:
            cut = text.rfind(' ', 0, mid)  # fallback: word boundary
        if cut <= 0:
            cut = mid  # last resort: hard cut

        part1 = text[:cut + 1].strip()
        part2 = text[cut + 1:].strip()

        parts = []
        for part in (part1, part2):
            if not part:
                continue
            f = partial(kokoro.create, part, voice=voice, speed=speed, lang="en-us")
            ad, sample_rate = await loop.run_in_executor(_tts_executor, f)
            if len(ad) > 0:
                parts.append(ad)

        if not parts:
            raise ValueError("Model generated empty audio after split.")

        audio_data = np.concatenate(parts) if len(parts) > 1 else parts[0]

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

# ─── Settings endpoints ───

@app.get("/settings")
async def get_settings(book_name: str):
    data = load_settings(book_name)
    return {
        "book_name": book_name,
        "page": data.get("page", 1),
        "scale": data.get("scale", 1.5),
        "sentenceIndex": data.get("sentenceIndex", 0),
        "speed": data.get("speed", 1.0),
    }

@app.post("/settings")
async def set_settings(payload: SettingsPayload):
    if payload.page < 1:
        raise HTTPException(status_code=400, detail="Invalid page number")
    save_settings(payload.book_name, payload.dict())
    return {"status": "ok"}

# ─── Last document endpoints ───

@app.get("/last_document")
async def get_last():
    filename = get_last_document()
    return {"filename": filename} if filename else {"filename": None}

@app.post("/last_document")
async def set_last(payload: LastDocPayload):
    set_last_document(payload.filename)
    return {"status": "ok"}

# ─── TTS synthesis ───

@app.post("/synthesize")
async def synthesize_post(
    payload: TextPayload,
    x_book_name: Optional[str] = Header(default=None),
    x_save_audio: Optional[str] = Header(default=None),
    x_page_number: Optional[str] = Header(default=None),
    x_line_number: Optional[str] = Header(default=None),
    x_force_regenerate: Optional[str] = Header(default=None),
):
    save             = (x_save_audio or "false").lower() == "true"
    force_regen      = (x_force_regenerate or "false").lower() == "true"
    book             = x_book_name or ""
    page             = int(x_page_number) if x_page_number and x_page_number.isdigit() else None
    line             = int(x_line_number) if x_line_number and x_line_number.isdigit() else None

    can_cache = bool(book and page is not None and line is not None)

    if can_cache:
        book_dir   = get_book_dir(book)
        cache_file = wav_path(book_dir, page, line)

        # Serve from cache only when NOT forced to regenerate and NOT a save request
        if not save and not force_regen and os.path.exists(cache_file):
            return FileResponse(
                cache_file,
                media_type="audio/wav",
                headers={"X-Cached": "true", "X-Cache-Path": cache_file},
            )

    synthesis_speed = 1.0 if (can_cache and (save or force_regen)) else payload.speed
    wav_bytes = await synthesize_audio(payload.text, payload.voice, synthesis_speed)

    # Write to disk when:
    #   • explicit save request, OR
    #   • force-regenerate (always overwrite existing cache so the new
    #     normalised text replaces the old audio)
    if can_cache and (save or force_regen):
        with open(cache_file, "wb") as f:
            f.write(wav_bytes)
        # Compute and store duration
        duration = get_duration_seconds(cache_file)
        update_duration(book_dir, page, line, duration)

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={
            "X-Cached": "false",
            **({"X-Cache-Path": cache_file} if can_cache else {}),
        },
    )

@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    wav_bytes = await synthesize_audio(text, voice, speed)
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")

@app.get("/page_sentence_durations")
async def page_sentence_durations(book_name: str, page: int):
    """
    Returns a dict of sentence_index -> duration_seconds for the given page.
    Uses cached durations if available, otherwise estimates from WAV file info.
    """
    book_dir = get_book_dir(book_name)
    if not os.path.isdir(book_dir):
        return {"durations": {}}

    durations = load_durations(book_dir)
    result = {}
    prefix = f"{page}_"
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            key = fname[:-4]          # "page_line"
            if key in durations:
                dur = durations[key]
            else:
                # Compute duration from the WAV file
                wav_file = os.path.join(book_dir, fname)
                dur = get_duration_seconds(wav_file)
                if dur > 0:
                    durations[key] = dur
            if dur is not None and dur > 0:
                line = int(key.split("_")[1])
                result[line] = dur

    if durations:
        save_durations(book_dir, durations)
    return {"durations": result}
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
                # Store duration
                duration = get_duration_seconds(cache_file)
                update_duration(book_dir, page, line, duration)
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

@app.get("/page_duration")
async def page_duration(book_name: str, page: int):
    book_dir = get_book_dir(book_name)
    durations = load_durations(book_dir)
    # Check if we have all durations for this page
    prefix = f"{page}_"
    needed = set()
    # Gather all cached line numbers for this page
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            key = fname[:-4]  # remove .wav
            needed.add(key)
    # Compute missing durations
    missing = needed - set(durations.keys())
    if missing:
        for key in missing:
            wav_file = os.path.join(book_dir, f"{key}.wav")
            if os.path.exists(wav_file):
                dur = get_duration_seconds(wav_file)
                durations[key] = dur
        save_durations(book_dir, durations)
    total = sum(durations.get(key, 0.0) for key in needed)
    return {"duration": total}

@app.get("/chapter_duration")
async def chapter_duration(book_name: str, start_page: int, end_page: int):
    book_dir = get_book_dir(book_name)
    durations = load_durations(book_dir)
    # Gather all needed keys
    needed = set()
    for p in range(start_page, end_page + 1):
        prefix = f"{p}_"
        for fname in os.listdir(book_dir):
            if fname.startswith(prefix) and fname.endswith(".wav"):
                key = fname[:-4]
                needed.add(key)
    # Compute missing durations
    missing = needed - set(durations.keys())
    if missing:
        for key in missing:
            wav_file = os.path.join(book_dir, f"{key}.wav")
            if os.path.exists(wav_file):
                dur = get_duration_seconds(wav_file)
                durations[key] = dur
        save_durations(book_dir, durations)
    total = sum(durations.get(key, 0.0) for key in needed)
    return {"duration": total}
# ─── Delete cache range ───

@app.post("/delete_cache_range")
async def delete_cache_range(payload: DeleteCacheRangePayload):
    book_dir = get_book_dir(payload.book_name)
    if not os.path.isdir(book_dir):
        return {"deleted": 0}
    deleted = 0
    durations = load_durations(book_dir)
    for p in range(payload.page_from, payload.page_to + 1):
        prefix = f"{p}_"
        for fname in os.listdir(book_dir):
            if fname.startswith(prefix) and fname.endswith(".wav"):
                try:
                    os.remove(os.path.join(book_dir, fname))
                    deleted += 1
                    # Also remove from durations
                    key = fname[:-4]
                    if key in durations:
                        del durations[key]
                except OSError:
                    pass
    save_durations(book_dir, durations)
    return {"deleted": deleted}

# ─── Upload PDF ───

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
