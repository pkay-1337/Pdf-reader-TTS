#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  download-static-files.sh
#  Run this ONCE on any machine with internet access. Pulls down every file
#  that isn't checked into git (large binaries + frontend vendor assets).
#  After it finishes, the entire project works 100% offline.
#
#  Downloads:
#    static/pdfjs/            PDF.js core files
#    static/epubjs/           epub.js
#    static/jszip.min.js      JSZip (epub dependency)
#    static/fonts/            webfonts + generated fonts.css
#    kokoro-v1.0.onnx         Kokoro TTS model        (~310 MB)
#    voices-v1.0.bin          Kokoro voice pack       (~27 MB)
#    supertonic-assets/       Supertonic 3 ONNX assets(~383 MB)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
STATIC_DIR="${ROOT}/static"

PDFJS_VERSION="3.11.174"
PDFJS_BASE="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}"
EPUBJS_URL="https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js"
JSZIP_URL="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"

KOKORO_BASE="https://huggingface.co/hexgrad/Kokoro-82M-v1.0-onnx/resolve/main"
SUPERSONIC_BASE="https://huggingface.co/Supertone/supertonic-3/resolve/main"
SUPERTONIC_ONNX=(
    tts.json
    unicode_indexer.json
    duration_predictor.onnx
    text_encoder.onnx
    vector_estimator.onnx
    vocoder.onnx
)
SUPERTONIC_VOICES=(F1 F2 F3 F4 F5 M1 M2 M3 M4 M5)

fetch() { # fetch <url> <dest> — skip if dest already exists
    local url="$1" dest="$2"
    if [[ -s "$dest" ]]; then
        echo "✓ $(realpath --relative-to="$ROOT" "$dest") (already exists)"
    else
        mkdir -p "$(dirname "$dest")"
        echo "⬇  $(realpath --relative-to="$ROOT" "$dest")"
        curl -fL --retry 3 -o "${dest}.part" "$url"
        mv "${dest}.part" "$dest"
    fi
}

# ─── 1. Frontend vendor assets ──────────────────────────────────────────────
echo "── Frontend assets ──"
fetch "${PDFJS_BASE}/pdf.min.js"         "${STATIC_DIR}/pdfjs/pdf.min.js"
fetch "${PDFJS_BASE}/pdf.worker.min.js"  "${STATIC_DIR}/pdfjs/pdf.worker.min.js"
fetch "${PDFJS_BASE}/pdf_viewer.min.css" "${STATIC_DIR}/pdfjs/pdf_viewer.min.css"
fetch "${EPUBJS_URL}"                    "${STATIC_DIR}/epubjs/epub.min.js"
fetch "${JSZIP_URL}"                     "${STATIC_DIR}/jszip.min.js"

# ─── 2. Fonts (Inter + JetBrains Mono) ──────────────────────────────────────
echo ""
echo "── Fonts ──"
if [[ -s "${STATIC_DIR}/fonts/fonts.css" ]]; then
    echo "✓ static/fonts/fonts.css (already exists)"
else
    python3 - << 'PYEOF'
import os, re, urllib.request

root = os.path.dirname(os.path.abspath(__file__))
fonts_dir = os.path.join(root, "static", "fonts")
os.makedirs(fonts_dir, exist_ok=True)

CSS_URLS = [
    "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap",
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap",
]

# A modern Chrome UA is required or Google serves .ttf instead of .woff2
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

combined = ""
for url in CSS_URLS:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    combined += urllib.request.urlopen(req).read().decode() + "\n"

urls = re.findall(r"url\((https://[^)]+\.(?:woff2|woff|ttf))\)", combined)
for i, u in enumerate(urls):
    ext = u.rsplit(".", 1)[-1]
    fname = f"font_{i}.{ext}"
    dest = os.path.join(fonts_dir, fname)
    if not os.path.exists(dest):
        urllib.request.urlretrieve(u, dest)

local_css = combined
for i, u in enumerate(urls):
    local_css = local_css.replace(u, f"/static/fonts/font_{i}.{u.rsplit('.', 1)[-1]}")

with open(os.path.join(fonts_dir, "fonts.css"), "w") as f:
    f.write(local_css)
print(f"   ✓ static/fonts/fonts.css ({len(urls)} woff2 files)")
PYEOF
fi

# ─── 3. Kokoro TTS model ────────────────────────────────────────────────────
echo ""
echo "── Kokoro model (~337 MB) ──"
fetch "${KOKORO_BASE}/kokoro-v1.0.onnx" "${ROOT}/kokoro-v1.0.onnx"
fetch "${KOKORO_BASE}/voices-v1.0.bin"  "${ROOT}/voices-v1.0.bin"

# ─── 4. Supertonic 3 assets ─────────────────────────────────────────────────
echo ""
echo "── Supertonic 3 assets (~383 MB) ──"
fetch "${SUPERSONIC_BASE}/config.json" "${ROOT}/supertonic-assets/config.json"
for f in "${SUPERTONIC_ONNX[@]}"; do
    fetch "${SUPERSONIC_BASE}/onnx/${f}" "${ROOT}/supertonic-assets/onnx/${f}"
done
for v in "${SUPERTONIC_VOICES[@]}"; do
    fetch "${SUPERSONIC_BASE}/voice_styles/${v}.json" "${ROOT}/supertonic-assets/voice_styles/${v}.json"
done

echo ""
echo "✅  All assets downloaded. Project works fully offline:"
echo "    ./run.sh"
echo "    # or inside Docker:"
echo "    docker build -t docreader-pro . && docker run -p 8000:8000 docreader-pro"
