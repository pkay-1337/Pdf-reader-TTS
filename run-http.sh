#!/bin/bash

source tts-env/bin/activate

# --- Environment variables (customise as needed) ---
export PDF_DIR="/home/pk/books/books/language"  # your PDF library folder
export AUDIO_CACHE_DIR="./tts_cache"            # where audio files and settings are stored
export KOKORO_MODEL="kokoro-v1.0.onnx"
export KOKORO_VOICES="voices-v1.0.bin"
export TTS_WORKERS="1"                          # keep 1 for safety (thread-safe)
export PORT="8000"

# --- Start the server ---
echo -e "\033[0;34mStarting DocReader Pro on port ${PORT} (accessible from LAN)...\033[0m"
python main2.py
