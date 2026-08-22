# DocReader Pro

A self-hosted PDF & EPUB reader with built-in neural text-to-speech. Open a document in the
browser, click any sentence to hear it read aloud, and let it auto-advance through pages.
Everything runs locally — no cloud, no API keys, works fully offline.

![Stack](https://img.shields.io/badge/backend-FastAPI-009688) ![Engines](https://img.shields.io/badge/TTS-Kokoro%20%7C%20Supertonic%203-blue)

## Features

- **PDF + EPUB** reading with sentence-level highlighting and click-to-listen
- **Two TTS engines**, switchable per voice:
  - **Kokoro 82M** (24 kHz) — ~30 voices (US/UK male & female)
  - **Supertonic 3** (44.1 kHz, `s3-F1`…`s3-M5`) — 31 languages, expression tags, ~3x faster on CPU
- **Lazy model loading** — only one engine is resident in RAM at a time; picking a voice from
  the other engine unloads the current model automatically (`TTS_KEEP_BOTH=1` to disable)
- **Per-sentence audio cache** with bulk preload of page ranges, plus cache management
- Playback speed, themes, focus mode, highlight styling, auto-advance — all persisted per book
- Session sync and live cache/preload progress over WebSockets
- 100% offline frontend (PDF.js, epub.js, fonts are vendored in `static/`)

## Quick Start

```bash
python -m venv tts-env
source tts-env/bin/activate
pip install -r requirements.txt

# One-time: download all models + frontend assets (~750 MB total)
./download-static-files.sh

./run.sh                     # http://127.0.0.1:8000
```

Documents go in `/home/pk/books/books/language` by default (see `PDF_DIR` below).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `KOKORO_MODEL` | `kokoro-v1.0.onnx` | Kokoro ONNX model path |
| `KOKORO_VOICES` | `voices-v1.0.bin` | Kokoro voice pack |
| `SUPERTONIC_ASSETS` | `supertonic-assets` | Supertonic 3 ONNX assets dir |
| `SUPERSONIC_STEPS` | `5` | Supertonic quality: 2 (fast) … 12 (best) |
| `TTS_KEEP_BOTH` | `0` | `1` keeps both models loaded in RAM |
| `TTS_WORKERS` | `2` | Synthesis thread pool size |
| `PRELOAD_CONCURRENCY` | `4` | Parallel sentences during preload |
| `PDF_DIR` | `/home/pk/books/books/language` | Document library folder |
| `AUDIO_CACHE_DIR` | `./tts_cache` | Per-book audio cache + settings |

## Benchmark

```bash
tts-env/bin/python benchmark/benchmark.py [VOICE]   # default F1
```

Best-of-3 synthesis times on a low-end CPU (short / medium / long texts):

| Engine | short | medium | long |
|---|---|---|---|
| Kokoro (`af_bella`) | 1.1x realtime | 1.1x | 1.1x |
| Supertonic 3 (`F5`, 5 steps) | 3.7x realtime | 3.1x | 3.0x |

WAVs are written to `benchmark/output/` for A/B listening; `benchmark/gen_voices.py`
generates a sample with every Supertonic voice.

## API Overview

| Endpoint | Method | Purpose |
|---|---|---|
| `/synthesize` | POST | TTS for arbitrary text (voice via JSON body) |
| `/play?text=...&voice=...` | GET | Quick one-shot synthesis |
| `/preload` | POST | Batch-generate audio for a page range |
| `/documents` | GET | List library documents |
| `/upload` | POST | Add a PDF/EPUB to the library |
| `/settings` | GET/POST | Persist per-book reader settings |
| `/cache_status_bulk` | GET | Which lines of a page range are cached |
| `/health` | GET | Server status + which engines are loaded |
| `/ws/tts` | WS | Streaming synthesis used by the reader UI |

Voices prefixed `s3-` (e.g. `s3-F5`) route to Supertonic 3; all others to Kokoro.

## License

Model weights keep their upstream licenses (Kokoro: Apache-2.0,
Supertonic 3: OpenRAIL-M). Project code is yours — do what you like.
