"""Benchmark stock Pipecat CPU adapters with synthetic speech, never a microphone.

The adapters download their official public models into their usual user cache.
No model API, credentials, personal audio, or live HUB service is used.
"""

import asyncio
import json
import time

from loguru import logger
from pipecat.frames.frames import ErrorFrame, TTSAudioRawFrame, TTSSpeakFrame, TranscriptionFrame
from pipecat.observers.base_observer import BaseObserver
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.tests.utils import run_test
from pipecat.transcriptions.language import Language

SENTENCE = "The blue notebook is on the kitchen table."


class AudioTiming(BaseObserver):
    """Measure first audio delivery without modifying the pipeline."""

    def __init__(self):
        super().__init__()
        self.started = None
        self.first_audio = None

    async def on_push_frame(self, data):
        if isinstance(data.frame, TTSSpeakFrame) and self.started is None:
            self.started = time.perf_counter()
        if isinstance(data.frame, TTSAudioRawFrame) and self.first_audio is None:
            self.first_audio = time.perf_counter()


async def main():
    """Synthesize two utterances, then transcribe both using CPU/int8 Whisper."""
    logger.remove()
    logger.add(lambda message: print(message, end="", flush=True), level="WARNING")
    report = {"scope": "synthetic local adapters only; no microphone/network-media test", "runs": []}
    print("Loading stock Kokoro model (first use may download public model files)…", flush=True)
    started = time.perf_counter()
    tts = KokoroTTSService(settings=KokoroTTSService.Settings(voice="af_heart", language=Language.EN_US), sample_rate=16000)
    report["tts_initialization_seconds"] = round(time.perf_counter() - started, 3)
    for run in range(2):
        # Reusing a cleaned-up processor is unsupported; a fresh adapter uses
        # the same downloaded model files, keeping initialization separate.
        if run:
            tts = KokoroTTSService(settings=KokoroTTSService.Settings(voice="af_heart", language=Language.EN_US), sample_rate=16000)
        timing = AudioTiming()
        started = time.perf_counter()
        down, up = await asyncio.wait_for(run_test(tts, frames_to_send=[TTSSpeakFrame(SENTENCE)], observers=[timing], start_timeout=10), timeout=90)
        assert not any(isinstance(frame, ErrorFrame) for frame in [*down, *up]), "TTS returned an error"
        audio = b"".join(frame.audio for frame in down if isinstance(frame, TTSAudioRawFrame))
        assert audio and timing.first_audio and timing.started, "No synthesized audio"
        row = {"tts_total_seconds": round(time.perf_counter() - started, 3),
               "tts_first_audio_seconds": round(timing.first_audio - timing.started, 3),
               "audio_seconds": round(len(audio) / 32000, 3)}
        if run == 0:
            print("Loading stock Whisper base.en CPU/int8 model…", flush=True)
            started = time.perf_counter()
            stt = WhisperSTTService(device="cpu", compute_type="int8", settings=WhisperSTTService.Settings(model="base.en", language=Language.EN))
            report["stt_initialization_seconds"] = round(time.perf_counter() - started, 3)
        started = time.perf_counter()
        frames = [frame async for frame in stt.run_stt(audio)]
        row["stt_seconds"] = round(time.perf_counter() - started, 3)
        transcript = " ".join(frame.text for frame in frames if isinstance(frame, TranscriptionFrame))
        assert not any(isinstance(frame, ErrorFrame) for frame in frames), "STT returned an error"
        row["expected_words_recognized"] = all(word in transcript.lower() for word in ["blue", "notebook", "kitchen", "table"])
        assert row["expected_words_recognized"], "Synthetic speech did not round-trip correctly"
        report["runs"].append(row)
        print(json.dumps(row), flush=True)
    print(json.dumps(report, indent=2), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
