import io
import os
import asyncio
import re
import json
import uuid
import soundfile as sf
from fastapi import FastAPI, HTTPException, Header, BackgroundTasks, UploadFile, File, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse, FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from typing import Optional, List, Dict, Set
from kokoro_onnx import Kokoro
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import numpy as np
import time
from datetime import datetime
import sys

# --- Rich logging (optional) ---
try:
    from rich.console import Console
    from rich.table import Table
    from rich.panel import Panel
    from rich.text import Text
    from rich import box
    RICH_AVAILABLE = True
except ImportError:
    RICH_AVAILABLE = False
    # Fallback to simple print
    class Console:
        def print(self, *args, **kwargs):
            print(*args)
    console = Console()

if RICH_AVAILABLE:
    console = Console()
else:
    console = Console()  # fallback

# --- Configuration ---
PDF_DIR = os.getenv("PDF_DIR", "/home/pk/books/books/language")
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", "./tts_cache")
KOKORO_MODEL_PATH = os.getenv("KOKORO_MODEL", "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH = os.getenv("KOKORO_VOICES", "voices-v1.0.bin")
MAX_WORKERS = int(os.getenv("TTS_WORKERS", "1"))

os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

app = FastAPI(title="DocReader Pro Backend")

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Cached", "X-Cache-Path"],
)

# --- Serve static assets ---
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# --- Logging helpers ---

def log_startup():
    """Print a beautiful startup banner."""
    if RICH_AVAILABLE:
        banner = Panel(
            f"[bold cyan]DocReader Pro Server[/bold cyan]\n"
            f"[green]PDF Directory:[/green] {PDF_DIR}\n"
            f"[green]Audio Cache:[/green] {AUDIO_CACHE_DIR}\n"
            f"[green]Model:[/green] {KOKORO_MODEL_PATH}\n"
            f"[green]Voices:[/green] {KOKORO_VOICES_PATH}\n"
            f"[green]Workers:[/green] {MAX_WORKERS}",
            title="🚀 Startup",
            border_style="bold blue"
        )
        console.print(banner)
    else:
        console.print("="*60)
        console.print("DocReader Pro Server")
        console.print(f"PDF Directory: {PDF_DIR}")
        console.print(f"Audio Cache: {AUDIO_CACHE_DIR}")
        console.print(f"Model: {KOKORO_MODEL_PATH}")
        console.print(f"Voices: {KOKORO_VOICES_PATH}")
        console.print(f"Workers: {MAX_WORKERS}")
        console.print("="*60)

def log_request(endpoint: str, method: str, details: dict = None):
    """Log an HTTP request in a consistent format."""
    if RICH_AVAILABLE:
        table = Table(title=f"{method} {endpoint}", box=box.ROUNDED, show_header=False)
        table.add_column("Key", style="bold cyan")
        table.add_column("Value", style="white")
        if details:
            for k, v in details.items():
                if v is not None:
                    table.add_row(k, str(v))
        console.print(table)
    else:
        console.print(f"[{datetime.now().strftime('%H:%M:%S')}] {method} {endpoint}")
        if details:
            for k, v in details.items():
                if v is not None:
                    console.print(f"  {k}: {v}")

def log_ws_connect(room: str, client_id: str = ""):
    if RICH_AVAILABLE:
        console.print(f"[green]🔗 WebSocket connected[/green] room={room} id={client_id}")
    else:
        console.print(f"[{datetime.now().strftime('%H:%M:%S')}] WS connected room={room}")

def log_ws_disconnect(room: str, client_id: str = ""):
    if RICH_AVAILABLE:
        console.print(f"[red]🔗 WebSocket disconnected[/red] room={room} id={client_id}")
    else:
        console.print(f"[{datetime.now().strftime('%H:%M:%S')}] WS disconnected room={room}")

def log_ws_message(room: str, msg_type: str, data: dict = None):
    if RICH_AVAILABLE:
        console.print(f"[yellow]📩 WS message[/yellow] room={room} type={msg_type}")
        if data:
            console.print(f"   {data}")
    else:
        console.print(f"[{datetime.now().strftime('%H:%M:%S')}] WS message room={room} type={msg_type}")

def log_tts(book: str, page: int, line: int, voice: str, text_len: int, cached: bool = False, duration: float = None):
    if RICH_AVAILABLE:
        status = "[green]CACHED[/green]" if cached else "[yellow]SYNTHESIZED[/yellow]"
        table = Table(title="TTS Synthesis", box=box.SIMPLE, show_header=False)
        table.add_row("Book", book or "N/A")
        table.add_row("Page", str(page))
        table.add_row("Line", str(line))
        table.add_row("Voice", voice)
        table.add_row("Text length", str(text_len))
        table.add_row("Cached", "✅" if cached else "🆕")
        if duration:
            table.add_row("Duration", f"{duration:.2f}s")
        console.print(table)
    else:
        console.print(f"[TTS] book={book} page={page} line={line} voice={voice} cached={cached} len={text_len}")

def log_preload_job(job_id: str, book: str, total: int, done: int = 0, errors: int = 0, status: str = "running"):
    if RICH_AVAILABLE:
        table = Table(title=f"Preload Job {job_id[:8]}", box=box.SIMPLE, show_header=False)
        table.add_row("Book", book)
        table.add_row("Total sentences", str(total))
        table.add_row("Done", str(done))
        table.add_row("Errors", str(errors))
        table.add_row("Status", status)
        console.print(table)
    else:
        console.print(f"[PRELOAD] {job_id[:8]} book={book} {done}/{total} errors={errors} status={status}")

def log_cache_operation(book: str, page: int, action: str, count: int = None):
    if RICH_AVAILABLE:
        console.print(f"[magenta]📦 Cache {action}[/magenta] book={book} page={page}" + (f" count={count}" if count is not None else ""))
    else:
        console.print(f"[CACHE] {action} book={book} page={page}")

def log_settings(book: str, page: int, scale: float, speed: float, topSkip: int, bottomSkip: int):
    if RICH_AVAILABLE:
        table = Table(title="Settings Update", box=box.SIMPLE, show_header=False)
        table.add_row("Book", book)
        table.add_row("Page", str(page))
        table.add_row("Scale", f"{scale:.2f}")
        table.add_row("Speed", f"{speed:.2f}x")
        table.add_row("Skip Top", str(topSkip))
        table.add_row("Skip Bottom", str(bottomSkip))
        console.print(table)
    else:
        console.print(f"[SETTINGS] book={book} page={page} scale={scale} speed={speed}")

log_startup()

# ─── WebSocket Connection Manager ───
class ConnectionManager:
    def __init__(self):
        self.rooms: Dict[str, Set[WebSocket]] = {}

    async def connect(self, room: str, ws: WebSocket):
        await ws.accept()
        self.rooms.setdefault(room, set()).add(ws)
        log_ws_connect(room, id(ws))

    def disconnect(self, room: str, ws: WebSocket):
        self.rooms.get(room, set()).discard(ws)
        log_ws_disconnect(room, id(ws))

    async def broadcast(self, room: str, data: dict):
        dead = set()
        for ws in self.rooms.get(room, set()):
            try:
                await ws.send_json(data)
            except Exception:
                dead.add(ws)
        for ws in dead:
            self.rooms[room].discard(ws)

    async def send(self, ws: WebSocket, data: dict):
        try:
            await ws.send_json(data)
        except Exception:
            pass

mgr = ConnectionManager()

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

def get_duration_seconds(wav_file: str) -> float:
    try:
        info = sf.info(wav_file)
        return info.duration
    except Exception:
        return 0.0

def update_duration(book_dir: str, page: int, line: int, duration: float):
    durations = load_durations(book_dir)
    key = f"{page}_{line}"
    durations[key] = duration
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
    topSkipLines: int = 0
    bottomSkipLines: int = 0

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
        mid = len(text) // 2
        cut = max(text.rfind('.', 0, mid), text.rfind('!', 0, mid), text.rfind('?', 0, mid))
        if cut <= 0:
            cut = text.rfind(' ', 0, mid)
        if cut <= 0:
            cut = mid
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
    log_request("/health", "GET", {"model_loaded": kokoro is not None})
    return {"status": "ok", "model_loaded": kokoro is not None}

@app.get("/documents")
async def list_documents():
    log_request("/documents", "GET")
    if not os.path.isdir(PDF_DIR):
        return {"documents": [], "pdfs": []}
    docs = []
    for fname in sorted(os.listdir(PDF_DIR)):
        fl = fname.lower()
        if not (fl.endswith(".pdf") or fl.endswith(".epub")):
            continue
        fpath = os.path.join(PDF_DIR, fname)
        try:
            size = os.path.getsize(fpath)
            doc_type = "epub" if fl.endswith(".epub") else "pdf"
            docs.append({"name": fname, "size": size, "type": doc_type, "url": f"/documents/{fname}"})
        except OSError:
            pass
    log_request("/documents", "GET", {"count": len(docs)})
    # Also return pdfs key for backward compat with old library WS handler
    return {"documents": docs, "pdfs": docs}

@app.get("/pdfs")
async def list_pdfs():
    result = await list_documents()
    return {"pdfs": result["documents"]}

@app.get("/documents/{filename}")
async def serve_document(filename: str):
    safe_name = os.path.basename(filename)
    fl = safe_name.lower()
    if not (fl.endswith(".pdf") or fl.endswith(".epub")):
        raise HTTPException(status_code=400, detail="Only PDF and EPUB files are served.")
    fpath = os.path.join(PDF_DIR, safe_name)
    if not os.path.isfile(fpath):
        raise HTTPException(status_code=404, detail="Document not found.")
    log_request("/documents/{filename}", "GET", {"filename": safe_name, "path": fpath})
    media_type = "application/epub+zip" if fl.endswith(".epub") else "application/pdf"
    return FileResponse(fpath, media_type=media_type, filename=safe_name)

@app.get("/pdfs/{filename}")
async def serve_pdf(filename: str):
    return await serve_document(filename)

# ─── Settings endpoints ───

@app.get("/settings")
async def get_settings(book_name: str):
    data = load_settings(book_name)
    log_request("/settings", "GET", {"book_name": book_name})
    return {
        "book_name": book_name,
        "page": data.get("page", 1),
        "scale": data.get("scale", 1.5),
        "sentenceIndex": data.get("sentenceIndex", 0),
        "speed": data.get("speed", 1.0),
        "topSkipLines": data.get("topSkipLines", 0),
        "bottomSkipLines": data.get("bottomSkipLines", 0),
    }

@app.post("/settings")
async def set_settings(payload: SettingsPayload):
    if payload.page < 1:
        raise HTTPException(status_code=400, detail="Invalid page number")
    save_settings(payload.book_name, payload.dict())
    log_settings(payload.book_name, payload.page, payload.scale, payload.speed, payload.topSkipLines, payload.bottomSkipLines)
    # Broadcast to any open session sockets for this book
    await mgr.broadcast(f"session:{payload.book_name}", {"type": "settings", **payload.dict()})
    return {"status": "ok"}

# ─── Last document endpoints ───

@app.get("/last_document")
async def get_last():
    filename = get_last_document()
    log_request("/last_document", "GET", {"filename": filename})
    return {"filename": filename} if filename else {"filename": None}

@app.post("/last_document")
async def set_last(payload: LastDocPayload):
    set_last_document(payload.filename)
    log_request("/last_document", "POST", {"filename": payload.filename})
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
    save        = (x_save_audio or "false").lower() == "true"
    force_regen = (x_force_regenerate or "false").lower() == "true"
    book        = x_book_name or ""
    page        = int(x_page_number) if x_page_number and x_page_number.isdigit() else None
    line        = int(x_line_number) if x_line_number and x_line_number.isdigit() else None

    can_cache = bool(book and page is not None and line is not None)
    cached = False
    duration = None

    if can_cache:
        book_dir   = get_book_dir(book)
        cache_file = wav_path(book_dir, page, line)
        if not save and not force_regen and os.path.exists(cache_file):
            duration = get_duration_seconds(cache_file)
            cached = True
            log_tts(book, page, line, payload.voice, len(payload.text), cached=True, duration=duration)
            return FileResponse(
                cache_file,
                media_type="audio/wav",
                headers={"X-Cached": "true", "X-Cache-Path": cache_file},
            )

    synthesis_speed = 1.0 if (can_cache and (save or force_regen)) else payload.speed
    wav_bytes = await synthesize_audio(payload.text, payload.voice, synthesis_speed)

    if can_cache and (save or force_regen):
        with open(cache_file, "wb") as f:
            f.write(wav_bytes)
        duration = get_duration_seconds(cache_file)
        update_duration(book_dir, page, line, duration)
        log_tts(book, page, line, payload.voice, len(payload.text), cached=False, duration=duration)
        # Push cache update
        cached_lines = _get_cached_lines(book_dir, page)
        await mgr.broadcast(f"cache:{book}", {
            "type": "cache_update",
            "page": page,
            "cached_lines": cached_lines,
        })
    else:
        log_tts(book or "unknown", page or 0, line or 0, payload.voice, len(payload.text), cached=False)

    # Build headers safely
    headers = {"X-Cached": "false"}
    if can_cache:
        headers["X-Cache-Path"] = cache_file

    return StreamingResponse(
        io.BytesIO(wav_bytes),
        media_type="audio/wav",
        headers=headers,
    )

@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    log_request("/play", "GET", {"text_len": len(text), "voice": voice, "speed": speed})
    wav_bytes = await synthesize_audio(text, voice, speed)
    return StreamingResponse(io.BytesIO(wav_bytes), media_type="audio/wav")

# ─── WebSocket: TTS streaming ───

@app.websocket("/ws/tts")
async def ws_tts(websocket: WebSocket):
    await websocket.accept()
    log_ws_connect("tts", id(websocket))
    try:
        while True:
            data = await websocket.receive_json()
            text  = data.get("text", "")
            voice = data.get("voice", "af_sarah")
            speed = data.get("speed", 1.0)
            book  = data.get("book_name", "")
            page  = data.get("page")
            line  = data.get("line")
            save  = data.get("save", False)

            can_cache = bool(book and page is not None and line is not None)
            cached = False
            duration = None

            if can_cache:
                book_dir   = get_book_dir(book)
                cache_file = wav_path(book_dir, page, line)
                
                # ── FIXED: Removed 'not save' so it always serves from cache if the file exists ──
                if os.path.exists(cache_file):
                    cached = True
                    duration = get_duration_seconds(cache_file)
                    log_tts(book, page, line, voice, len(text), cached=True, duration=duration)
                    with open(cache_file, "rb") as f:
                        chunk = f.read(8192)
                        while chunk:
                            await websocket.send_bytes(chunk)
                            chunk = f.read(8192)
                    await websocket.send_json({"type": "done", "cached": True})
                    continue

            try:
                wav_bytes = await synthesize_audio(text, voice, 1.0 if save else speed)
            except Exception as e:
                log_ws_message("tts", "error", {"detail": str(e)})
                await websocket.send_json({"type": "error", "detail": str(e)})
                continue

            if can_cache: # Save newly generated audio if caching is enabled
                with open(cache_file, "wb") as f:
                    f.write(wav_bytes)
                duration = get_duration_seconds(cache_file)
                update_duration(book_dir, page, line, duration)
                log_tts(book, page, line, voice, len(text), cached=False, duration=duration)
                cached_lines = _get_cached_lines(book_dir, page)
                await mgr.broadcast(f"cache:{book}", {
                    "type": "cache_update",
                    "page": page,
                    "cached_lines": cached_lines,
                })
            else:
                log_tts(book or "unknown", page or 0, line or 0, voice, len(text), cached=False)

            chunk_size = 8192
            for i in range(0, len(wav_bytes), chunk_size):
                await websocket.send_bytes(wav_bytes[i:i + chunk_size])
            await websocket.send_json({"type": "done", "cached": False})

    except WebSocketDisconnect:
        log_ws_disconnect("tts", id(websocket))
        pass

# ─── WebSocket: Session sync ───

@app.websocket("/ws/session/{book_name}")
async def ws_session(websocket: WebSocket, book_name: str):
    room = f"session:{book_name}"
    await mgr.connect(room, websocket)
    # Send current settings on connect
    settings = load_settings(book_name)
    await mgr.send(websocket, {"type": "init", **settings})
    try:
        while True:
            data = await websocket.receive_json()
            if data.get("type") == "settings":
                save_settings(book_name, data)
                log_settings(book_name, data.get("page"), data.get("scale"), data.get("speed"),
                             data.get("topSkipLines"), data.get("bottomSkipLines"))
                await mgr.broadcast(room, {"type": "settings_sync", **data})
            else:
                log_ws_message(room, data.get("type"), data)
    except WebSocketDisconnect:
        mgr.disconnect(room, websocket)

# ─── WebSocket: Preload progress ───

@app.websocket("/ws/preload/{job_id}")
async def ws_preload(websocket: WebSocket, job_id: str):
    room = f"preload:{job_id}"
    await mgr.connect(room, websocket)
    try:
        while True:
            async with _preload_lock:
                job = _preload_jobs.get(job_id)
            if job:
                await mgr.send(websocket, job)
                if job.get("status") == "done":
                    break
            await asyncio.sleep(0.25)
    except WebSocketDisconnect:
        pass
    finally:
        mgr.disconnect(room, websocket)

# ─── WebSocket: Cache events ───

@app.websocket("/ws/cache/{book_name}")
async def ws_cache(websocket: WebSocket, book_name: str):
    room = f"cache:{book_name}"
    await mgr.connect(room, websocket)
    try:
        while True:
            # Wait for client messages (e.g., to request cache status for a page)
            data = await websocket.receive_json()
            if data.get("type") == "get_status":
                page = data.get("page")
                if page is not None:
                    book_dir = get_book_dir(book_name)
                    cached_lines = _get_cached_lines(book_dir, page)
                    await mgr.send(websocket, {
                        "type": "cache_update",
                        "page": page,
                        "cached_lines": cached_lines,
                    })
            else:
                log_ws_message(room, data.get("type"), data)
    except WebSocketDisconnect:
        pass
    finally:
        mgr.disconnect(room, websocket)

# ─── WebSocket: Library updates ───

@app.websocket("/ws/library")
async def ws_library(websocket: WebSocket):
    await mgr.connect("library", websocket)
    # Send current list on connect
    docs_data = await list_documents()
    await mgr.send(websocket, {"type": "init", "documents": docs_data["documents"], "pdfs": docs_data["documents"]})
    try:
        await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        mgr.disconnect("library", websocket)

# ─── Helper: get cached lines for a page ───

def _get_cached_lines(book_dir: str, page: int) -> list:
    if not os.path.isdir(book_dir):
        return []
    prefix = f"{page}_"
    cached = []
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            try:
                cached.append(int(fname[len(prefix):-4]))
            except ValueError:
                pass
    return sorted(cached)

# ─── Page sentence durations ───

@app.get("/page_sentence_durations")
async def page_sentence_durations(book_name: str, page: int):
    log_request("/page_sentence_durations", "GET", {"book_name": book_name, "page": page})
    book_dir = get_book_dir(book_name)
    if not os.path.isdir(book_dir):
        return {"durations": {}}
    durations = load_durations(book_dir)
    result = {}
    prefix = f"{page}_"
    missing = False
    for fname in os.listdir(book_dir):
        if fname.startswith(prefix) and fname.endswith(".wav"):
            key = fname[:-4]
            if key in durations:
                dur = durations[key]
            else:
                wav_file = os.path.join(book_dir, fname)
                dur = get_duration_seconds(wav_file)
                if dur > 0:
                    durations[key] = dur
                    missing = True
            if dur is not None and dur > 0:
                line = int(key.split("_")[1])
                result[line] = dur
    # Only save if we added new durations
    if missing:
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
                await mgr.broadcast(f"preload:{job_id}", _preload_jobs[job_id])
                continue

            try:
                wav_bytes = await synthesize_audio(text, payload.voice, speed=1.0)
                with open(cache_file, "wb") as f:
                    f.write(wav_bytes)
                duration = get_duration_seconds(cache_file)
                update_duration(book_dir, page, line, duration)
                log_tts(payload.book_name, page, line, payload.voice, len(text), cached=False, duration=duration)
                done += 1
                # Broadcast cache update
                cached_lines = _get_cached_lines(book_dir, page)
                await mgr.broadcast(f"cache:{payload.book_name}", {
                    "type": "cache_update",
                    "page": page,
                    "cached_lines": cached_lines,
                })
            except Exception as e:
                print(f"[PRELOAD ERROR] {key}: {e}")
                errors += 1

            async with _preload_lock:
                _preload_jobs[job_id]["done"] = done
                _preload_jobs[job_id]["errors"] = errors

            # Broadcast preload progress
            await mgr.broadcast(f"preload:{job_id}", _preload_jobs[job_id])
            await asyncio.sleep(0)

    async with _preload_lock:
        _preload_jobs[job_id]["status"] = "done"
    log_preload_job(job_id, payload.book_name, total, done, errors, "done")
    await mgr.broadcast(f"preload:{job_id}", _preload_jobs[job_id])

    # Clean up after 60 seconds
    async def cleanup():
        await asyncio.sleep(60)
        async with _preload_lock:
            _preload_jobs.pop(job_id, None)
    asyncio.create_task(cleanup())

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
    log_preload_job(job_id, payload.book_name, len(payload.sentences), status="started")
    background_tasks.add_task(_run_preload_job, job_id, payload)
    return {"job_id": job_id, "total": len(payload.sentences)}

@app.get("/preload_status")
async def preload_status(job_id: str):
    async with _preload_lock:
        job = _preload_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    log_request("/preload_status", "GET", {"job_id": job_id})
    return job

@app.post("/preload_status_bulk")
async def preload_status_bulk(job_ids: List[str]):
    async with _preload_lock:
        result = {jid: _preload_jobs.get(jid) for jid in job_ids}
    log_request("/preload_status_bulk", "POST", {"count": len(job_ids)})
    return result

@app.get("/preload_jobs")
async def list_preload_jobs():
    async with _preload_lock:
        jobs = list(_preload_jobs.values())
    log_request("/preload_jobs", "GET", {"count": len(jobs)})
    return jobs

# ─── Cache status ───

@app.get("/cache_status")
async def cache_status(book_name: str, page: int):
    log_request("/cache_status", "GET", {"book_name": book_name, "page": page})
    book_dir = get_book_dir(book_name)
    return {"cached_lines": _get_cached_lines(book_dir, page)}

@app.get("/cache_status_bulk")
async def cache_status_bulk(book_name: str, page_from: int, page_to: int):
    log_request("/cache_status_bulk", "GET", {"book_name": book_name, "page_from": page_from, "page_to": page_to})
    book_dir = get_book_dir(book_name)
    result = {}
    if os.path.isdir(book_dir):
        all_files = os.listdir(book_dir)  # list once
        for p in range(page_from, page_to + 1):
            prefix = f"{p}_"
            cached = []
            for fname in all_files:
                if fname.startswith(prefix) and fname.endswith(".wav"):
                    try:
                        cached.append(int(fname[len(prefix):-4]))
                    except ValueError:
                        pass
            result[str(p)] = sorted(cached)
    else:
        for p in range(page_from, page_to + 1):
            result[str(p)] = []
    return {"pages": result}

@app.get("/page_duration")
async def page_duration(book_name: str, page: int):
    log_request("/page_duration", "GET", {"book_name": book_name, "page": page})
    book_dir = get_book_dir(book_name)
    durations = load_durations(book_dir)
    prefix = f"{page}_"
    needed = set()
    all_files = os.listdir(book_dir)  # list once
    for fname in all_files:
        if fname.startswith(prefix) and fname.endswith(".wav"):
            needed.add(fname[:-4])
    missing = needed - set(durations.keys())
    if missing:
        for key in missing:
            wav_file = os.path.join(book_dir, f"{key}.wav")
            if os.path.exists(wav_file):
                durations[key] = get_duration_seconds(wav_file)
        save_durations(book_dir, durations)
    total = sum(durations.get(key, 0.0) for key in needed)
    return {"duration": total}

@app.get("/chapter_duration")
async def chapter_duration(book_name: str, start_page: int, end_page: int):
    log_request("/chapter_duration", "GET", {"book_name": book_name, "start_page": start_page, "end_page": end_page})
    book_dir = get_book_dir(book_name)
    durations = load_durations(book_dir)
    needed = set()
    all_files = os.listdir(book_dir)  # list once
    for p in range(start_page, end_page + 1):
        prefix = f"{p}_"
        for fname in all_files:
            if fname.startswith(prefix) and fname.endswith(".wav"):
                needed.add(fname[:-4])
    missing = needed - set(durations.keys())
    if missing:
        for key in missing:
            wav_file = os.path.join(book_dir, f"{key}.wav")
            if os.path.exists(wav_file):
                durations[key] = get_duration_seconds(wav_file)
        save_durations(book_dir, durations)
    total = sum(durations.get(key, 0.0) for key in needed)
    return {"duration": total}

# ─── Delete cache range ───

@app.post("/delete_cache_range")
async def delete_cache_range(payload: DeleteCacheRangePayload):
    log_request("/delete_cache_range", "POST", {"book_name": payload.book_name, "page_from": payload.page_from, "page_to": payload.page_to})
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
                    key = fname[:-4]
                    if key in durations:
                        del durations[key]
                except OSError:
                    pass
        # Notify cache listeners
        await mgr.broadcast(f"cache:{payload.book_name}", {
            "type": "cache_cleared",
            "page": p,
            "cached_lines": [],
        })
    save_durations(book_dir, durations)
    log_cache_operation(payload.book_name, payload.page_from, "deleted_range", deleted)
    return {"deleted": deleted}

# ─── Upload PDF ───

@app.post("/upload")
async def upload_document(file: UploadFile = File(...)):
    fl = (file.filename or "").lower()
    if not (fl.endswith(".pdf") or fl.endswith(".epub")):
        raise HTTPException(400, "Only PDF and EPUB files are allowed")
    safe_name = os.path.basename(file.filename)
    fpath = os.path.join(PDF_DIR, safe_name)
    if os.path.exists(fpath):
        raise HTTPException(409, f"File {safe_name} already exists on server")
    content = await file.read()
    with open(fpath, "wb") as f:
        f.write(content)
    size = os.path.getsize(fpath)
    doc_type = "epub" if fl.endswith(".epub") else "pdf"
    log_request("/upload", "POST", {"filename": safe_name, "size": size, "type": doc_type})
    doc = {"name": safe_name, "size": size, "type": doc_type, "url": f"/documents/{safe_name}"}
    await mgr.broadcast("library", {
        "type": "added",
        "document": doc,
        "pdf": doc,  # backward compat
    })
    return {"status": "uploaded", "filename": safe_name}

@app.post("/upload_pdf")
async def upload_pdf(file: UploadFile = File(...)):
    return await upload_document(file)

@app.get("/", response_class=HTMLResponse)
async def serve_index():
    try:
        with open("index.html", "r", encoding="utf-8") as f:
            return f.read()
    except FileNotFoundError:
        return HTMLResponse("<h1>DocReader Pro</h1><p>index.html not found.</p>", status_code=404)
