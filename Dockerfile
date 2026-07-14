# ─────────────────────────────────────────────
#  DocReader Pro — Dockerfile (fully offline)
# ─────────────────────────────────────────────
FROM python:3.11-slim

# System dependencies required by kokoro-onnx / phonemizer
RUN apt-get update && apt-get install -y --no-install-recommends \
        espeak-ng \
        libsndfile1 \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (layer cache friendly)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY main.py .
COPY index.html .

# Copy Kokoro model files (must be present on the build host)
COPY kokoro-v1.0.onnx .
COPY voices-v1.0.bin  .

# Copy the offline static assets tree:
#   static/
#     pdfjs/
#       pdf.min.js
#       pdf.worker.min.js
#       pdf_viewer.min.css
#     fonts/
#       fonts.css        ← @font-face declarations pointing at woff2 files
#       Inter-*.woff2    ← font files
#       JetBrainsMono-*.woff2
COPY static/ ./static/

VOLUME ["/app/pdf", "/app/tts_cache"]


# ─── Environment defaults (override with -e or docker-compose) ───
ENV PDF_DIR=/app/pdf \
    AUDIO_CACHE_DIR=/app/tts_cache \
    KOKORO_MODEL=kokoro-v1.0.onnx \
    KOKORO_VOICES=voices-v1.0.bin \
    TTS_WORKERS=1

EXPOSE 8000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
