import io
import os
import re
import json
import uuid
import threading
import soundfile as sf
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs, unquote
from kokoro_onnx import Kokoro
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Optional, Dict
from email import message_from_bytes
from email.policy import HTTP as HTTP_POLICY

# --- Configuration ---
PDF_DIR         = os.getenv("PDF_DIR",         "/home/pk/books/books/language")
AUDIO_CACHE_DIR = os.getenv("AUDIO_CACHE_DIR", "./tts_cache")
KOKORO_MODEL_PATH   = os.getenv("KOKORO_MODEL",  "kokoro-v1.0.onnx")
KOKORO_VOICES_PATH  = os.getenv("KOKORO_VOICES", "voices-v1.0.bin")
MAX_WORKERS     = int(os.getenv("TTS_WORKERS", "1"))
PORT            = int(os.getenv("PORT", "8000"))

os.makedirs(PDF_DIR, exist_ok=True)
os.makedirs(AUDIO_CACHE_DIR, exist_ok=True)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# --- Kokoro model ---
kokoro = None
_tts_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS)
_model_lock = threading.Lock()

try:
    print("Loading Kokoro model...")
    kokoro = Kokoro(KOKORO_MODEL_PATH, KOKORO_VOICES_PATH)
    print("Model loaded.")
except Exception as e:
    print(f"Warning: Could not load Kokoro model: {e}")

# --- Background preload jobs ---
_preload_jobs: Dict[str, dict] = {}
_preload_lock = threading.Lock()

# --- Helper functions ---

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
    return os.path.join(get_book_dir(book_name), "settings.json")

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
    with open(get_settings_path(book_name), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)

LAST_DOC_FILE = os.path.join(AUDIO_CACHE_DIR, "last_document.json")

def get_last_document() -> Optional[str]:
    if os.path.exists(LAST_DOC_FILE):
        try:
            with open(LAST_DOC_FILE, "r") as f:
                return json.load(f).get("filename")
        except Exception:
            pass
    return None

def set_last_document(filename: str):
    with open(LAST_DOC_FILE, "w") as f:
        json.dump({"filename": filename}, f)

def synthesize_wav(text: str, voice: str, speed: float = 1.0) -> bytes:
    if not kokoro:
        raise RuntimeError("Kokoro model not loaded.")
    if not text.strip():
        raise ValueError("Text cannot be empty.")
    func = partial(kokoro.create, text, voice=voice, speed=speed, lang="en-us")
    with _model_lock:
        audio_data, sample_rate = _tts_executor.submit(func).result()
    if len(audio_data) == 0:
        raise ValueError("Model generated empty audio.")
    wav_io = io.BytesIO()
    sf.write(wav_io, audio_data, sample_rate, format='WAV', subtype='PCM_16')
    wav_io.seek(0)
    return wav_io.read()

def guess_mime(path: str) -> str:
    ext = os.path.splitext(path)[1].lower()
    return {
        ".html": "text/html; charset=utf-8",
        ".css":  "text/css",
        ".js":   "application/javascript",
        ".pdf":  "application/pdf",
        ".wav":  "audio/wav",
        ".json": "application/json",
        ".png":  "image/png",
        ".jpg":  "image/jpeg",
        ".svg":  "image/svg+xml",
        ".woff2":"font/woff2",
        ".woff": "font/woff",
        ".ttf":  "font/ttf",
    }.get(ext, "application/octet-stream")

def _run_preload_job(job_id: str, book_name: str, sentences: dict, voice: str):
    book_dir = get_book_dir(book_name)
    done = 0
    errors = 0

    def sort_key(k):
        parts = k.split("_")
        return (int(parts[0]), int(parts[1]))

    sorted_items = sorted(sentences.items(), key=lambda kv: sort_key(kv[0]))

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
            with _preload_lock:
                _preload_jobs[job_id]["done"] = done
            continue

        try:
            wav_bytes = synthesize_wav(text, voice, speed=1.0)
            with open(cache_file, "wb") as f:
                f.write(wav_bytes)
            done += 1
        except Exception as e:
            print(f"[PRELOAD ERROR] {key}: {e}")
            errors += 1

        with _preload_lock:
            _preload_jobs[job_id]["done"]   = done
            _preload_jobs[job_id]["errors"] = errors

    with _preload_lock:
        _preload_jobs[job_id]["status"] = "done"


# --- Request handler ---

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.address_string()}] {fmt % args}")

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status, detail):
        self.send_json({"detail": detail}, status)

    def send_bytes(self, data: bytes, mime: str, extra_headers: dict = None):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self._cors_headers()
        if extra_headers:
            for k, v in extra_headers.items():
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, fpath: str, mime: str = None, extra_headers: dict = None):
        mime = mime or guess_mime(fpath)
        with open(fpath, "rb") as f:
            data = f.read()
        self.send_bytes(data, mime, extra_headers)

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(length))

    def _cors_headers(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers","X-Cached, X-Cache-Path")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/") or "/"
        qs     = parse_qs(parsed.query)

        def q(key, default=None):
            vals = qs.get(key)
            return vals[0] if vals else default

        if path == "/":
            try:
                self.send_file("index.html", "text/html; charset=utf-8")
            except FileNotFoundError:
                self.send_error_json(404, "index.html not found")
            return

        if path.startswith("/static/"):
            rel   = path[len("/static/"):]
            fpath = os.path.join(STATIC_DIR, rel)
            if os.path.isfile(fpath):
                self.send_file(fpath)
            else:
                self.send_error_json(404, "Static file not found")
            return

        if path == "/health":
            self.send_json({"status": "ok", "model_loaded": kokoro is not None})
            return

        if path == "/pdfs":
            if not os.path.isdir(PDF_DIR):
                self.send_json({"pdfs": []})
                return
            pdfs = []
            for fname in sorted(os.listdir(PDF_DIR)):
                if not fname.lower().endswith(".pdf"):
                    continue
                fpath = os.path.join(PDF_DIR, fname)
                try:
                    pdfs.append({"name": fname, "size": os.path.getsize(fpath),
                                 "url": f"/pdfs/{fname}"})
                except OSError:
                    pass
            self.send_json({"pdfs": pdfs})
            return

        if path.startswith("/pdfs/"):
            fname = os.path.basename(unquote(path[len("/pdfs/"):]))
            if not fname.lower().endswith(".pdf"):
                self.send_error_json(400, "Only PDF files are served.")
                return
            fpath = os.path.join(PDF_DIR, fname)
            if not os.path.isfile(fpath):
                self.send_error_json(404, "PDF not found.")
                return
            self.send_file(fpath, "application/pdf")
            return

        if path == "/settings":
            book_name = q("book_name", "")
            data = load_settings(book_name)
            self.send_json({
                "book_name":     book_name,
                "page":          data.get("page", 1),
                "scale":         data.get("scale", 1.5),
                "sentenceIndex": data.get("sentenceIndex", 0),
            })
            return

        if path == "/last_document":
            self.send_json({"filename": get_last_document()})
            return

        if path == "/play":
            text  = q("text", "")
            voice = q("voice", "af_sarah")
            speed = float(q("speed", "1.0"))
            try:
                self.send_bytes(synthesize_wav(text, voice, speed), "audio/wav")
            except RuntimeError as e:
                self.send_error_json(503, str(e))
            except ValueError as e:
                self.send_error_json(400, str(e))
            return

        if path == "/cache_status":
            book_name = q("book_name", "")
            page_raw  = q("page")
            if page_raw is None:
                self.send_error_json(400, "Missing page parameter")
                return
            page_num = int(page_raw)
            book_dir = get_book_dir(book_name)
            if not os.path.isdir(book_dir):
                self.send_json({"cached_lines": []})
                return
            prefix = f"{page_num}_"
            cached = []
            for fname in os.listdir(book_dir):
                if fname.startswith(prefix) and fname.endswith(".wav"):
                    try:
                        cached.append(int(fname[len(prefix):-4]))
                    except ValueError:
                        pass
            self.send_json({"cached_lines": sorted(cached)})
            return

        if path == "/cache_status_bulk":
            book_name = q("book_name", "")
            page_from = int(q("page_from", "1"))
            page_to   = int(q("page_to",   "1"))
            book_dir  = get_book_dir(book_name)
            result    = {}
            if os.path.isdir(book_dir):
                all_files = os.listdir(book_dir)
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
            self.send_json({"pages": result})
            return

        if path == "/preload_status":
            job_id = q("job_id")
            if not job_id:
                self.send_error_json(400, "Missing job_id")
                return
            with _preload_lock:
                job = _preload_jobs.get(job_id)
            if not job:
                self.send_error_json(404, "Job not found")
                return
            self.send_json(job)
            return

        if path == "/preload_jobs":
            with _preload_lock:
                self.send_json(list(_preload_jobs.values()))
            return

        self.send_error_json(404, "Not found")

    def do_POST(self):
        parsed = urlparse(self.path)
        path   = parsed.path.rstrip("/") or "/"

        if path == "/settings":
            try:
                body = self.read_json_body()
            except Exception:
                self.send_error_json(400, "Invalid JSON")
                return
            if body.get("page", 1) < 1:
                self.send_error_json(400, "Invalid page number")
                return
            save_settings(body.get("book_name", ""), body)
            self.send_json({"status": "ok"})
            return

        if path == "/last_document":
            try:
                body = self.read_json_body()
            except Exception:
                self.send_error_json(400, "Invalid JSON")
                return
            set_last_document(body.get("filename", ""))
            self.send_json({"status": "ok"})
            return

        if path == "/synthesize":
            try:
                body = self.read_json_body()
            except Exception:
                self.send_error_json(400, "Invalid JSON")
                return
            text  = body.get("text",  "")
            voice = body.get("voice", "af_sarah")
            speed = float(body.get("speed", 1.0))

            x_book     = self.headers.get("X-Book-Name",   "")
            x_save     = self.headers.get("X-Save-Audio",  "false").lower() == "true"
            x_page_raw = self.headers.get("X-Page-Number", "")
            x_line_raw = self.headers.get("X-Line-Number", "")

            page = int(x_page_raw) if x_page_raw.isdigit() else None
            line = int(x_line_raw) if x_line_raw.isdigit() else None
            can_cache = bool(x_book and page is not None and line is not None)

            if can_cache:
                book_dir   = get_book_dir(x_book)
                cache_file = wav_path(book_dir, page, line)
                if not x_save and os.path.exists(cache_file):
                    self.send_file(cache_file, "audio/wav",
                                   extra_headers={"X-Cached": "true"})
                    return

            synth_speed = 1.0 if (x_save and can_cache) else speed
            try:
                wav_bytes = synthesize_wav(text, voice, synth_speed)
            except RuntimeError as e:
                self.send_error_json(503, str(e))
                return
            except ValueError as e:
                self.send_error_json(400, str(e))
                return

            if x_save and can_cache:
                with open(cache_file, "wb") as f:
                    f.write(wav_bytes)

            self.send_bytes(wav_bytes, "audio/wav", extra_headers={"X-Cached": "false"})
            return

        if path == "/preload":
            try:
                body = self.read_json_body()
            except Exception:
                self.send_error_json(400, "Invalid JSON")
                return
            book_name = body.get("book_name", "")
            sentences = body.get("sentences", {})
            voice     = body.get("voice", "af_sarah")
            job_id    = str(uuid.uuid4())
            with _preload_lock:
                _preload_jobs[job_id] = {
                    "status": "running",
                    "total":  len(sentences),
                    "done":   0,
                    "errors": 0,
                    "book":   book_name,
                }
            threading.Thread(
                target=_run_preload_job,
                args=(job_id, book_name, sentences, voice),
                daemon=True,
            ).start()
            self.send_json({"job_id": job_id, "total": len(sentences)})
            return

        if path == "/preload_status_bulk":
            try:
                job_ids = self.read_json_body()
            except Exception:
                self.send_error_json(400, "Invalid JSON")
                return
            with _preload_lock:
                result = {jid: _preload_jobs.get(jid) for jid in job_ids}
            self.send_json(result)
            return

        if path == "/upload_pdf":
            content_type = self.headers.get("Content-Type", "")
            if "multipart/form-data" not in content_type:
                self.send_error_json(400, "Expected multipart/form-data")
                return
            length = int(self.headers.get("Content-Length", 0))
            raw_body = self.rfile.read(length)

            # Parse multipart using email stdlib (cgi was removed in Python 3.13)
            # Reconstruct a minimal MIME message so email.parser can decode it.
            mime_bytes = f"Content-Type: {content_type}\r\n\r\n".encode() + raw_body
            msg = message_from_bytes(mime_bytes)

            file_data = None
            file_name = None
            for part in msg.walk():
                cd = part.get("Content-Disposition", "")
                if 'name="file"' not in cd and "name=file" not in cd:
                    continue
                # Extract filename from Content-Disposition
                for token in cd.split(";"):
                    token = token.strip()
                    if token.lower().startswith("filename="):
                        file_name = token[9:].strip().strip('"')
                file_data = part.get_payload(decode=True)
                break

            if not file_data or not file_name:
                self.send_error_json(400, "No file provided")
                return
            if not file_name.lower().endswith(".pdf"):
                self.send_error_json(400, "Only PDF files are allowed")
                return
            safe_name = os.path.basename(file_name)
            fpath = os.path.join(PDF_DIR, safe_name)
            if os.path.exists(fpath):
                self.send_error_json(409, f"File {safe_name} already exists on server")
                return
            with open(fpath, "wb") as f:
                f.write(file_data)
            self.send_json({"status": "uploaded", "filename": safe_name})
            return

        self.send_error_json(404, "Not found")


# --- Entry point ---

if __name__ == "__main__":
    import socket
    local_ip = socket.gethostbyname(socket.gethostname())
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"\033[0;34mDocReader Pro serving on http://{local_ip}:{PORT} (LAN) and http://127.0.0.1:{PORT} (local)\033[0m")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()
