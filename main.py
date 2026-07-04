import io
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from kokoro_onnx import Kokoro

app = FastAPI(title="Local PDF Reader TTS Engine")

# --- NEW: CORS Configuration ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], # Allows your frontend on port 8080 to talk to port 8000
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

try:
    print("Loading Kokoro model... this might take a second.")
    kokoro = Kokoro("kokoro-v1.0.onnx", "voices-v1.0.bin")
    print("Model loaded successfully!")
except Exception as e:
    print(f"Error loading model: {e}")

class TextPayload(BaseModel):
    text: str
    voice: str = "af_sarah"
    speed: float = 1.0

# We keep the POST endpoint for your future frontend web app
@app.post("/synthesize")
async def synthesize_post(payload: TextPayload):
    return await process_audio(payload.text, payload.voice, payload.speed)

# We add a GET endpoint so you can test it directly in your browser
@app.get("/play")
async def synthesize_get(text: str, voice: str = "af_sarah", speed: float = 1.0):
    return await process_audio(text, voice, speed)

# Core logic with step-by-step logging
async def process_audio(text: str, voice: str, speed: float):
    if not text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty.")

    try:
        print(f"\n--- New TTS Request ---")
        print(f"1. Text received: '{text}'")
        print(f"2. Voice selected: {voice}")
        print(f"2. Speed selected: {speed}")
        
        print("3. Generating audio with Kokoro...")
        audio_data, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
        
        print(f"4. Success! Audio array size generated: {len(audio_data)}")
        
        if len(audio_data) == 0:
            print("ERROR: Array is empty. Phonemizer failed.")
            raise ValueError("Model generated empty audio.")

        print("5. Converting to WAV format...")
        wav_io = io.BytesIO()
        sf.write(wav_io, audio_data, sample_rate, format='WAV', subtype='PCM_16')
        wav_io.seek(0)

        print("6. Streaming audio back to client.")
        return StreamingResponse(wav_io, media_type="audio/wav")

    except Exception as e:
        print(f"ERROR CAUGHT: {e}")
        raise HTTPException(status_code=500, detail=str(e))
