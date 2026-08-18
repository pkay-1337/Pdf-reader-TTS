#!/bin/bash

source tts-env/bin/activate

# ─── Environment variables (customise as needed) ───
export PDF_DIR="/home/pk/books/books/language"      
export AUDIO_CACHE_DIR="./tts_cache"                
export KOKORO_MODEL="kokoro-v1.0.onnx"
export KOKORO_VOICES="voices-v1.0.bin"
export TTS_WORKERS="2"                              

# Add this variable to control parallel preload downloads
export PRELOAD_CONCURRENCY="2" 

# ─── Start the server ───
echo -e "\033[0;34mStarting DocReader Pro backend on port 8000...\033[0m"
uvicorn main:app --host 127.0.0.1 --port 8000
