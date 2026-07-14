#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  download_static_assets.sh
#  Run this ONCE on any machine that has internet access to pull down every
#  file that index.html previously loaded from CDNs.
#  After it finishes, the entire project works 100 % offline.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PDFJS_VERSION="3.11.174"
PDFJS_BASE="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${PDFJS_VERSION}"

STATIC_DIR="$(dirname "$0")/static"
PDFJS_DIR="${STATIC_DIR}/pdfjs"
FONTS_DIR="${STATIC_DIR}/fonts"

mkdir -p "$PDFJS_DIR" "$FONTS_DIR"

# ─── 1. PDF.js core files ───────────────────────────────────────────────────
echo "⬇  Downloading PDF.js ${PDFJS_VERSION}..."
curl -fsSL "${PDFJS_BASE}/pdf.min.js"           -o "${PDFJS_DIR}/pdf.min.js"
curl -fsSL "${PDFJS_BASE}/pdf.worker.min.js"    -o "${PDFJS_DIR}/pdf.worker.min.js"
curl -fsSL "${PDFJS_BASE}/pdf_viewer.min.css"   -o "${PDFJS_DIR}/pdf_viewer.min.css"
echo "   ✓ PDF.js done"

# ─── 2. Inter font (variable-weight subset used by the UI) ──────────────────
echo "⬇  Downloading Inter font..."
INTER_BASE="https://fonts.gstatic.com/s/inter/v13"

# weights 300 400 500 600 700 — latin subset
declare -A INTER_FILES=(
    ["Inter-Light.woff2"]="UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
    ["Inter-Regular.woff2"]="UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
    ["Inter-Medium.woff2"]="UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
    ["Inter-SemiBold.woff2"]="UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
    ["Inter-Bold.woff2"]="UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2"
)

# Google Fonts API returns the right woff2 per weight — easier to just hit the API
# (this request itself is the only internet call needed, after which you're offline)
INTER_CSS_URL="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
JETBRAINS_CSS_URL="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"

# Download the CSS files to extract the woff2 URLs
INTER_CSS=$(curl -fsSL -A "Mozilla/5.0" "$INTER_CSS_URL")
JETBRAINS_CSS=$(curl -fsSL -A "Mozilla/5.0" "$JETBRAINS_CSS_URL")

# Extract woff2 URLs and download each one
download_fonts_from_css() {
    local css="$1"
    local prefix="$2"
    local i=0
    while IFS= read -r url; do
        local fname="${prefix}_${i}.woff2"
        curl -fsSL "$url" -o "${FONTS_DIR}/${fname}"
        i=$((i+1))
    done < <(echo "$css" | grep -oP "(?<=url\()https://[^)]+\.woff2")
}

download_fonts_from_css "$INTER_CSS"     "Inter"
download_fonts_from_css "$JETBRAINS_CSS" "JetBrainsMono"
echo "   ✓ Fonts downloaded"

# ─── 3. Generate fonts.css ──────────────────────────────────────────────────
echo "⬇  Generating static/fonts/fonts.css ..."

# Re-embed the CSS with local paths instead of remote URLs
echo "$INTER_CSS $JETBRAINS_CSS" | \
    grep -oP "src: url\(https://[^)]+\.woff2\)[^;]+;" | \
    nl -nrz -w1 | \
    awk '{print NR, $0}' > /dev/null   # just a placeholder

# Build fonts.css by rewriting remote URLs to local ones
python3 - << 'PYEOF'
import re, os, sys

fonts_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "fonts")

inter_css_path = None
jetbrains_css_path = None

# Read the CSS strings we already downloaded
import subprocess
inter_css = subprocess.check_output([
    "curl", "-fsSL", "-A", "Mozilla/5.0",
    "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap"
]).decode()
jetbrains_css = subprocess.check_output([
    "curl", "-fsSL", "-A", "Mozilla/5.0",
    "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"
]).decode()

combined = inter_css + "\n" + jetbrains_css
urls = re.findall(r'url\((https://[^)]+\.woff2)\)', combined)

local_css = combined
for i, url in enumerate(urls):
    fname = f"font_{i}.woff2"
    local_css = local_css.replace(url, f"/static/fonts/{fname}")
    # download
    if not os.path.exists(os.path.join(fonts_dir, fname)):
        import urllib.request
        urllib.request.urlretrieve(url, os.path.join(fonts_dir, fname))

out = os.path.join(fonts_dir, "fonts.css")
with open(out, "w") as f:
    f.write(local_css)
print(f"   Written {out} with {len(urls)} font URLs rewritten.")
PYEOF

echo ""
echo "✅  All static assets downloaded."
echo "    Layout:"
echo "    static/"
echo "    ├── pdfjs/"
echo "    │   ├── pdf.min.js"
echo "    │   ├── pdf.worker.min.js"
echo "    │   └── pdf_viewer.min.css"
echo "    └── fonts/"
echo "        ├── fonts.css"
echo "        └── font_*.woff2"
echo ""
echo "Now start the server — it will work fully offline:"
echo "    ./run.sh"
echo "    # or inside Docker:"
echo "    docker build -t docreader-pro . && docker run -p 8000:8000 docreader-pro"
