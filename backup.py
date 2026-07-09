import io
import os
import asyncio
import hashlib
import re
import soundfile as sf
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional
from kokoro_onnx import Kokoro
from concurrent.futures import ThreadPoolExecutor
from functools import partial


app = FastAPI(title="Local PDF Reader TTS Engine")

# ─── PDF library directory ───
PDF_DIR = os.path.abspath("/home/pk/books/books/language")
#PDF_DIR = os.path.join(os.path.dirname(__file__), "pdf")
os.makedirs(PDF_DIR, exist_ok=True)
print(f"[INIT] PDF library directory: {PDF_DIR}")

# ─── CORS ───
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cached", "X-Cache-Path"],  # expose custom headers to browser
)

# ─── GET /pdfs  — list available server-side PDFs ───

@app.get("/pdfs")
async def list_pdfs():
    """
    Return a list of PDF files available in the server's ./pdf directory.
    Each entry includes name, size (bytes), and a download URL.
    """
    if not os.path.isdir(PDF_DIR):
        print("[PDFS] PDF directory not found, returning empty list")
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
                "url":  f"/pdfs/{fname}",
            })
            print(f"[PDFS]   found: {fname} ({size:,} bytes)")
        except OSError as e:
            print(f"[PDFS]   skip {fname}: {e}")

    print(f"[PDFS] Listing {len(pdfs)} PDF(s)")
    return {"pdfs": pdfs}


# ─── GET /pdfs/{filename}  — serve a specific PDF ───

@app.get("/pdfs/{filename}")
async def serve_pdf(filename: str):
    """Serve a PDF file from the server's ./pdf directory."""
    # Sanitise: no path traversal
    safe_name = os.path.basename(filename)
    if not safe_name.lower().endswith(".pdf"):
        raise HTTPException(status_code=400, detail="Only PDF files are served here.")

    fpath = os.path.join(PDF_DIR, safe_name)
    if not os.path.isfile(fpath):
        print(f"[PDFS] 404: {safe_name} not found in {PDF_DIR}")
        raise HTTPException(status_code=404, detail=f"PDF '{safe_name}' not found on server.")

    print(f"[PDFS] Serving: {safe_name} ({os.path.getsize(fpath):,} bytes)")
    return FileResponse(fpath, media_type="application/pdf", filename=safe_name)


# ─── Audio cache root directory ───
AUDIO_CACHE_DIR = os.path.join(os.path.dirname(__file__), "tts_cache")
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

# ─── Kokoro model ───
try:
    print("Loading Kokoro model... this might take a second.")
    kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
    print("Model loaded successfully!")
except Exception as e:
    print(f"Error loading model: {e}")
    kokoro = None

# ─── Background preload queue ───
# Maps job_id -> {"total": N, "done": N, "errors": N, "status": "running"|"done"|"failed"}
_preload_jobs: dict[str, dict] = {}
_preload_lock = asyncio.Lock()

# Lock to ensure background jobs download strictly one page at a time
#_page_processing_lock = asyncio.Lock()
_page_processing_lock = asyncio.Semaphore(3)


# ─── Helpers ───

def sanitize_filename(name: str) -> str:
    """Strip unsafe characters for use as a folder name."""
    name = os.path.splitext(name)[0]          # drop .pdf
    name = re.sub(r'[^\w\s\-]', '', name)     # keep word chars, spaces, hyphens
    name = re.sub(r'\s+', '_', name.strip())
    return name or "unknown_book"


def get_book_dir(book_name: str) -> str:
    """Return (and create) the cache directory for a given book."""
    safe = sanitize_filename(book_name)
    path = os.path.join(AUDIO_CACHE_DIR, safe)
    os.makedirs(path, exist_ok=True)
    return path


def wav_path(book_dir: str, page: int, line: int) -> str:
    """Canonical path for a cached line: <book>/<page>_<line>.wav
    
    WAVs are ALWAYS saved at speed=1.0. Playback speed adjustment is handled
    client-side via the Web Audio API / audio.playbackRate.
    """
    return os.path.join(book_dir, f"{page}_{line}.wav")


# ─── Request models ───

class TextPayload(BaseModel):
    text: str
    voice: str = "af_sarah"
    speed: float = 1.0   # accepted but ignored for cache writes — always saved at 1.0


class PreloadPayload(BaseModel):
    book_name:   str
    page_from:   int
    page_to:     int
    sentences:   dict   # { "page_line": "text", ... }  keyed as "5_0", "5_1" …
    voice:       str = "af_sarah"
    # NOTE: speed is intentionally omitted — preloaded files are always at 1.0x.
    # The client applies playbackRate for speed changes.


# ─── Core synthesis ───
# Create a dedicated single-thread pool specifically for the TTS model.
# This prevents ONNX from creating memory leaks across multiple threads.
_tts_executor = ThreadPoolExecutor(max_workers=3)

async def synthesize_audio(text: str, voice: str, speed: float = 1.0) -> bytes:
    """Run Kokoro and return raw WAV bytes."""
    if not kokoro:
        raise HTTPException(status_code=503, detail="Kokoro model not loaded.")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    #print(f"\n--- Synthesizing ---")
    #print(f"  text  : {text!r}")
    #print(f"  voice : {voice} | speed: {speed}")

    func = partial(kokoro.create, text, voice=voice, speed=speed, lang="en-us")

    # Send the job to our dedicated single thread
    loop = asyncio.get_running_loop()
    # FIX: Added the missing arguments to run_in_executor
    audio_data, sample_rate = await loop.run_in_executor(_tts_executor, func)
    
    if len(audio_data) == 0:
        raise ValueError("Model generated empty audio.")

    wav_io = io.BytesIO()
    sf.write(wav_io, audio_data, sample_rate, format='WAV', subtype='PCM_16')
    wav_io.seek(0)
    return wav_io.read()


# ─── POST /synthesize ───

@app.post("/synthesize")
async def synthesize_post(
    payload: TextPayload,
    x_book_name:   Optional[str] = Header(default=None),
    x_save_audio:  Optional[str] = Header(default=None),
    x_page_number: Optional[str] = Header(default=None),
    x_line_number: Optional[str] = Header(default=None),
    x_page_range:  Optional[str] = Header(default=None),
):
    """
    Synthesise one sentence.

    SPEED NOTE: WAVs are always saved at speed=1.0. The client should apply
    audio.playbackRate for user-requested speed changes. The `speed` field in
    the request body is used for live (non-cached) synthesis only.

    Response headers:
      X-Cached: "true" | "false"  — whether this response came from disk cache
    """
    save   = (x_save_audio or "false").lower() == "true"
    book   = x_book_name or ""
    page   = int(x_page_number) if x_page_number and x_page_number.isdigit() else None
    line   = int(x_line_number) if x_line_number and x_line_number.isdigit() else None

    can_cache = bool(book and page is not None and line is not None)

    if can_cache:
        book_dir   = get_book_dir(book)
        cache_file = wav_path(book_dir, page, line)

        if not save and os.path.exists(cache_file):
            # ── Cache HIT: serve saved file directly ──
            print(f"[CACHE HIT] {cache_file}")
            return FileResponse(
                cache_file,
                media_type="audio/wav",
                headers={"X-Cached": "true"},
            )

    # ── Synthesise at 1.0x for saving; use requested speed for live play ──
    synthesis_speed = 1.0 if (save and can_cache) else payload.speed
    try:
        print(f"Page : {page} \t Line : {line}")
        wav_bytes = await synthesize_audio(payload.text, payload.voice, synthesis_speed)
    except Exception as e:
        print(f"ERROR: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # ── Save to disk if requested (always at 1.0x) ──
    if save and can_cache:
        with open(cache_file, "wb") as f:
            f.write(wav_bytes)
        print(f"[SAVED] {cache_file}")

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers={"X-Cached": "false"},
    )


# ─── GET /play (browser-testable, unchanged) ───

@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    try:
        wav_bytes = await synthesize_audio(text, voice, speed)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")


# ─── Background worker for preload ───

async def _run_preload_job(job_id: str, payload: PreloadPayload):
    """Process preload sentences one by one in the background."""
    book_dir = get_book_dir(payload.book_name)
    total    = len(payload.sentences)
    done     = 0
    errors   = 0

    # Sort by page then line so we process in reading order
    def sort_key(k):
        try:
            parts = k.split("_")
            return (int(parts[0]), int(parts[1]))
        except Exception:
            return (9999, 9999)

    sorted_items = sorted(payload.sentences.items(), key=lambda kv: sort_key(kv[0]))

    # FIX: Use the new lock to force page jobs to process one at a time sequentially
    async with _page_processing_lock:
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
                # Always synthesise at 1.0x for stored files
                print(f"Downloading -> Page : {page} \t Line : {line}")
                wav_bytes = await synthesize_audio(text, payload.voice, speed=1.0)
                with open(cache_file, "wb") as f:
                    f.write(wav_bytes)
                done += 1
            except Exception as e:
                print(f"[PRELOAD ERROR] {key}: {e}")
                errors += 1

            async with _preload_lock:
                _preload_jobs[job_id]["done"]   = done
                _preload_jobs[job_id]["errors"] = errors

            # Yield control so other requests aren't fully blocked
            await asyncio.sleep(0)

    async with _preload_lock:
        _preload_jobs[job_id]["status"] = "done"
        _preload_jobs[job_id]["done"]   = done
        _preload_jobs[job_id]["errors"] = errors

    print(f"[PRELOAD DONE] job={job_id} saved={done} errors={errors}")


# ─── POST /preload  (fire-and-forget batch pre-generation) ───

@app.post("/preload")
async def preload(payload: PreloadPayload, background_tasks: BackgroundTasks):
    """
    Accept a batch of sentences keyed by "page_line" and queue synthesis in the
    background. Returns immediately with a job_id — the browser does NOT need to
    stay open waiting for synthesis; the server processes everything autonomously.

    Poll /preload_status?job_id=<id> to check progress.
    """
    import uuid
    job_id = str(uuid.uuid4())

    async with _preload_lock:
        _preload_jobs[job_id] = {
            "status": "running",
            "total":  len(payload.sentences),
            "done":   0,
            "errors": 0,
            "book":   payload.book_name,
        }

    background_tasks.add_task(_run_preload_job, job_id, payload)

    return {
        "status":  "queued",
        "job_id":  job_id,
        "total":   len(payload.sentences),
        "book_dir": get_book_dir(payload.book_name),
    }


# ─── GET /preload_status ───

@app.get("/preload_status")
async def preload_status(job_id: str):
    """Return progress of a background preload job."""
    async with _preload_lock:
        job = _preload_jobs.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    return job


# ─── POST /preload_status_bulk ───

@app.post("/preload_status_bulk")
async def preload_status_bulk(job_ids: list[str]):
    """Return progress for multiple background preload jobs in a single request."""
    async with _preload_lock:
        return {jid: _preload_jobs.get(jid) for jid in job_ids}


# ─── GET /preload_jobs ───

@app.get("/preload_jobs")
async def list_preload_jobs():
    """List all known preload jobs (useful for debugging)."""
    async with _preload_lock:
        return list(_preload_jobs.values())


# ─── GET /cache_status ───

@app.get("/cache_status")
async def cache_status(book_name: str, page: int):
    """Return which line indices are already cached for a given page."""
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


# ─── GET /cache_status_bulk ───

@app.get("/cache_status_bulk")
async def cache_status_bulk(book_name: str, page_from: int, page_to: int):
    """
    Return cached line indices for a range of pages in one request.
    Response: { "pages": { "5": [0,1,2], "6": [0], ... } }
    """
    book_dir = get_book_dir(book_name)
    result: dict[str, list] = {}

    if not os.path.isdir(book_dir):
        for p in range(page_from, page_to + 1):
            result[str(p)] = []
        return {"pages": result}

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

    return {"pages": result}

