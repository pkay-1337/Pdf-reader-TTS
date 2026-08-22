import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

from kokoro_onnx import Kokoro
from supertonic import TTS

BASE = Path(__file__).parent
REPO = BASE.parent
OUT = BASE / "output"

TEXTS = [
    ("short", "The quick brown fox jumps over the lazy dog."),
    ("medium", "Artificial intelligence has transformed the way we interact with technology, "
               "making everyday tools smarter and more responsive to human needs."),
    ("long", "The morning sun rose slowly over the quiet valley, casting long golden shadows "
             "across the fields. A gentle breeze carried the scent of wildflowers through the "
             "open window, and somewhere in the distance a church bell rang out seven times, "
             "marking the start of another peaceful day in the countryside."),
]

RUNS = 3
VOICE = sys.argv[1] if len(sys.argv) > 1 else "F1"


def bench(func, runs=RUNS):
    times, audio, sr = [], None, None
    for _ in range(runs):
        t0 = time.perf_counter()
        audio, sr = func()
        times.append(time.perf_counter() - t0)
    best = min(times)
    dur = len(audio) / sr
    return {"synth_s": best, "audio_s": dur, "rtf": best / dur, "xrt": dur / best,
            "audio": audio, "sr": sr}


def main():
    results = {}

    # --- Kokoro (af_bella) ---
    t0 = time.perf_counter()
    kokoro = Kokoro(str(REPO / "kokoro-v1.0.onnx"), str(REPO / "voices-v1.0.bin"))
    load_kokoro = time.perf_counter() - t0

    def kokoro_fn(t):
        return lambda: kokoro.create(t, voice="af_bella", speed=1.0, lang="en-us")

    kokoro.create("warmup.", voice="af_bella", speed=1.0, lang="en-us")  # warmup, untimed
    for name, text in TEXTS:
        results[("kokoro", name)] = bench(kokoro_fn(text))

    # --- Supertonic 3 (F1) ---
    t0 = time.perf_counter()
    tts = TTS(model="supertonic-3", model_dir=REPO / "supertonic-assets", auto_download=False)
    load_super = time.perf_counter() - t0
    style = tts.get_voice_style(VOICE)

    def super_fn(t):
        def run():
            wav, _dur = tts.synthesize(t, voice_style=style, lang="en", total_steps=5)
            return np.asarray(wav).squeeze(0), int(tts.sample_rate)
        return run

    super_fn("warmup.")()  # warmup, untimed
    for name, text in TEXTS:
        results[("supertonic3", name)] = bench(super_fn(text))

    print(f"\nmodel load:  kokoro {load_kokoro:.1f}s  |  supertonic3 {load_super:.1f}s\n")

    hdr = f"{'engine':12s} {'text':8s} {'audio':>7s} {'best synth':>11s} {'RTF':>6s} {'speed':>7s}"
    print(hdr)
    print("-" * len(hdr))
    for engine in ("kokoro", "supertonic3"):
        for name, _ in TEXTS:
            r = results[(engine, name)]
            print(f"{engine:12s} {name:8s} {r['audio_s']:6.1f}s {r['synth_s']:10.2f}s {r['rtf']:6.2f} {r['xrt']:6.1f}x")

    out = OUT
    out.mkdir(exist_ok=True)
    for (engine, name), r in results.items():
        sf.write(out / f"{engine}_{name}.wav", np.asarray(r["audio"], dtype="float32"), r["sr"])
    print(f"\nwav files written to {out}/")


if __name__ == "__main__":
    main()
