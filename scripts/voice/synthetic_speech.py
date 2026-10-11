"""Emit a synthetic WAV fixture using already-cached local Kokoro; no recordings."""
import base64
import io
from pathlib import Path
import wave
import argparse

import numpy as np
from kokoro_onnx import Kokoro

cache = Path.home() / ".cache/pipecat/kokoro-onnx"
model = Kokoro(str(cache / "kokoro-v1.0.onnx"), str(cache / "voices-v1.0.bin"))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--text", default="My favorite color is purple. Can you remember that?")
args = parser.parse_args()
samples, rate = model.create(args.text, voice="af_heart", speed=1.0, lang="en-us")
output = io.BytesIO()
with wave.open(output, "wb") as wav:
    wav.setnchannels(1)
    wav.setsampwidth(2)
    wav.setframerate(rate)
    wav.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
print(base64.b64encode(output.getvalue()).decode("ascii"))
