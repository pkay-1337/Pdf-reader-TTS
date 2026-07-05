import io
import os
import hashlib
import re
import soundfile as sf
from fastapi import FastAPI, HTTPException, Header
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse
from pydantic import BaseModel
from typing import Optional
from kokoro_onnx import Kokoro

app = FastAPI(title="Local PDF Reader TTS Engine")

# ─── CORS ───
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
    """Canonical path for a cached line: <book>/<page>_<line>.wav"""
    return os.path.join(book_dir, f"{page}_{line}.wav")


# ─── Request model ───

class TextPayload(BaseModel):
    text: str
    voice: str = "af_sarah"
    speed: float = 1.0


# ─── Core synthesis ───

async def synthesize_audio(text: str, voice: str, speed: float) -> bytes:
    """Run Kokoro and return raw WAV bytes."""
    if not kokoro:
        raise HTTPException(status_code=503, detail="Kokoro model not loaded.")
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    print(f"\n--- Synthesizing ---")
    print(f"  text  : {text!r}")
    print(f"  voice : {voice} | speed: {speed}")

    audio_data, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")

    if len(audio_data) == 0:
        raise ValueError("Model generated empty audio.")

    wav_io = io.BytesIO()
    sf.write(wav_io, audio_data, sample_rate, format='WAV', subtype='PCM_16')
    wav_io.seek(0)
    return wav_io.read()


# ─── Existing POST /synthesize (unchanged behaviour) ───

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

    Optional headers:
      X-Book-Name   – filename of the PDF (e.g. "my_book.pdf")
      X-Save-Audio  – "true" to persist the WAV to disk
      X-Page-Number – current page (integer)
      X-Line-Number – sentence/line index on the page (integer)
      X-Page-Range  – e.g. "5-10" (only used when X-Save-Audio=true)

    When X-Save-Audio=false (default):
      If a cached WAV exists for this book/page/line it is returned directly,
      skipping Kokoro synthesis entirely.

    When X-Save-Audio=true:
      The audio is synthesised, saved, and then streamed back.
    """
    save   = (x_save_audio or "false").lower() == "true"
    book   = x_book_name or ""
    page   = int(x_page_number) if x_page_number and x_page_number.isdigit() else None
    line   = int(x_line_number) if x_line_number and x_line_number.isdigit() else None

    # If we have enough metadata to attempt a cache lookup
    can_cache = bool(book and page is not None and line is not None)

    if can_cache:
        book_dir  = get_book_dir(book)
        cache_file = wav_path(book_dir, page, line)

        if not save and os.path.exists(cache_file):
            # ── Cache HIT: serve saved file directly ──
            print(f"[CACHE HIT] {cache_file}")
            return FileResponse(cache_file, media_type="audio/wav")

    # ── Synthesise ──
    try:
        wav_bytes = await synthesize_audio(payload.text, payload.voice, payload.speed)
    except Exception as e:
        print(f"ERROR: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # ── Save to disk if requested ──
    if save and can_cache:
        with open(cache_file, "wb") as f:
            f.write(wav_bytes)
        print(f"[SAVED] {cache_file}")

    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")


# ─── GET /play (browser-testable, unchanged) ───

@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    try:
        wav_bytes = await synthesize_audio(text, voice, speed)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")


# ─── POST /preload  (batch pre-generation for a page range) ───

class PreloadPayload(BaseModel):
    book_name:   str
    page_from:   int
    page_to:     int
    sentences:   dict   # { "page_line": "text", ... }  keyed as "5_0", "5_1" …
    voice:       str = "af_sarah"
    speed:       float = 1.0


@app.post("/preload")
async def preload(payload: PreloadPayload):
    """
    Accept a batch of sentences keyed by "page_line" and synthesise + save
    any that are not already cached.  The frontend can fire-and-forget this.
    """
    book_dir = get_book_dir(payload.book_name)
    saved    = 0
    skipped  = 0

    for key, text in payload.sentences.items():
        try:
            parts = key.split("_")
            page, line = int(parts[0]), int(parts[1])
        except (ValueError, IndexError):
            continue

        cache_file = wav_path(book_dir, page, line)
        if os.path.exists(cache_file):
            skipped += 1
            continue

        try:
            wav_bytes = await synthesize_audio(text, payload.voice, payload.speed)
            with open(cache_file, "wb") as f:
                f.write(wav_bytes)
            saved += 1
        except Exception as e:
            print(f"[PRELOAD ERROR] {key}: {e}")

    return {"saved": saved, "skipped": skipped, "book_dir": book_dir}


# ─── GET /cache_status ───

@app.get("/cache_status")
async def cache_status(book_name: str, page: int):
    """Return which line indices are already cached for a given page."""
    book_dir = get_book_dir(book_name)
    if not os.path.isdir(book_dir):
        return {"cached_lines": []}

    prefix   = f"{page}_"
    cached   = []
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            try:
                line = int(fname[len(prefix):-4])
                cached.append(line)
            except ValueError:
                pass

    return {"cached_lines": sorted(cached)}
