import time
from pathlib import Path

from supertonic import TTS
import soundfile as sf
import numpy as np

BASE = Path(__file__).parent

tts = TTS(model="supertonic-3", model_dir=REPO / "supertonic-assets", auto_download=False)
print("voices:", tts.voice_style_names)

TEXT = "Hello! This is the {voice} voice from Supertonic 3, generated offline on my CPU."

for name in tts.voice_style_names:
    style = tts.get_voice_style(name)
    t0 = time.time()
    wav, dur = tts.synthesize(TEXT.format(voice=name), voice_style=style, lang="en", total_steps=5)
    out = BASE / "output" / f"{name}.wav"
    out.parent.mkdir(exist_ok=True)
    sf.write(out, wav.squeeze(), tts.sample_rate)
    print(f"{name:4s} -> {out.name:7s} {float(dur[0]) if hasattr(dur, '__len__') else dur:5.1f}s audio in {time.time() - t0:5.1f}s")

samples = [sf.read(BASE / "output" / f"{n}.wav", dtype="float32")[0] for n in tts.voice_style_names]
gap = np.zeros(22050, dtype="float32")
combined = np.concatenate([s for pair in zip(samples, [gap] * len(samples)) for s in pair])
sf.write(BASE / "output" / "all_voices.wav", combined, tts.sample_rate)
print("combined -> output/all_voices.wav")
