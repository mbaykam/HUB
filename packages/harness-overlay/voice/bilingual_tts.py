"""Local English Kokoro + Turkish Piper; route each spoken sentence by language."""
import asyncio
import os
import time
from functools import lru_cache
import numpy as np
import onnxruntime as ort
import soxr
from lingua import Language as DetectedLanguage, LanguageDetectorBuilder
from kokoro_onnx import Kokoro
from piper import PiperVoice
from pipecat.services.tts_service import TTSService
from pipecat.services.settings import TTSSettings
from speech_settings import kokoro_paths, piper_paths

SAMPLES = {"en": "Hello. We can talk in English and switch to Turkish whenever you like.",
           "tr": "Merhaba. Türkçe konuşabiliriz; istersen İngilizceye de geçebiliriz."}

@lru_cache(maxsize=1)
def kokoro_runtime():
    model, voices = kokoro_paths()
    # The default ORT pool competes with ASR, VAD and audio on a small CPU.
    options = ort.SessionOptions()
    options.intra_op_num_threads = min(4, max(1, (os.cpu_count() or 2) // 2))
    options.inter_op_num_threads = 1
    return Kokoro.from_session(ort.InferenceSession(str(model), sess_options=options,
                              providers=['CPUExecutionProvider']), str(voices))

@lru_cache(maxsize=2)
def piper_runtime(voice):
    model, _ = piper_paths(voice)
    return PiperVoice.load(str(model))

class LocalSpeechSynthesizer:
    def __init__(self, settings):
        self.settings = settings
        self.detector = LanguageDetectorBuilder.from_languages(DetectedLanguage.ENGLISH, DetectedLanguage.TURKISH).build()
        self.kokoro = None
        self.piper = None
        if settings["engine"] in ("kokoro", "bilingual"):
            self.kokoro = kokoro_runtime()
        if settings["engine"] in ("piper", "bilingual"):
            self.piper = piper_runtime(settings.get("turkishVoice", settings["voice"]))

    def language(self, text, hint="en"):
        forced = self.settings.get("language", "auto")
        if forced != "auto":
            return forced
        if self.settings["engine"] == "piper":
            return "tr" if self.settings["voice"].startswith("tr_") else "en"
        if self.settings["engine"] == "kokoro":
            return "en"
        found = self.detector.detect_language_of(text)
        return "tr" if found == DetectedLanguage.TURKISH else "en" if found == DetectedLanguage.ENGLISH else hint

    def synthesize(self, text, hint="en"):
        language = self.language(text, hint)
        if self.piper is not None and (self.kokoro is None or language == "tr"):
            return b"".join(chunk.audio_int16_bytes for chunk in self.piper.synthesize(text)), self.piper.config.sample_rate
        voice = self.settings["voice"]
        samples, rate = self.kokoro.create(text, voice=voice, speed=1.0, lang="en-gb" if voice.startswith("b") else "en-us")
        return (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes(), rate

class BilingualTTSService(TTSService):
    def __init__(self, speech, *, health=None, **kwargs):
        super().__init__(push_start_frame=True, push_stop_frames=True,
                         settings=TTSSettings(model=speech['model'], voice=speech["voice"], language=None), **kwargs)
        from speech_segments import SpeechSegmentAggregator
        self._text_aggregator = SpeechSegmentAggregator()
        if speech['engine'] == 'supertonic':
            from supertonic_tts import SupertonicSynthesizer
            self.synthesizer = SupertonicSynthesizer(speech)
        else:
            self.synthesizer = LocalSpeechSynthesizer(speech)
        self.health = health
        self._synthesis_lock = asyncio.Lock()

    async def run_tts(self, text, context_id):
        def synthesize_call_audio():
            audio, rate = self.synthesizer.synthesize(text)
            # Pipecat keeps one streaming resampler for this TTS service. Piper
            # returns 22050 Hz, Kokoro 24000 Hz: changing its input rate on a
            # language switch makes later sentences fail silently. Normalize
            # each already-buffered sentence before it enters that stream.
            if rate != self.sample_rate:
                samples = soxr.resample(np.frombuffer(audio, dtype='<i2').astype(np.float32),
                                       rate, self.sample_rate)
                audio = np.rint(np.clip(samples, -32768, 32767)).astype('<i2').tobytes()
            return audio, self.sample_rate
        if self.health:
            self.health.synthesizing += 1
            if not self.health.bot_speaking:self.health.stage = 'thinking'
        try:
            began = time.perf_counter()
            async with self._synthesis_lock:
                task = asyncio.create_task(asyncio.to_thread(synthesize_call_audio))
                try:
                    audio, rate = await asyncio.shield(task)
                except asyncio.CancelledError:
                    # Stop playback immediately through Pipecat, but let the
                    # bounded CPU synthesis finish before this voice is reused.
                    # Its abandoned PCM must never enter a later response.
                    await task
                    raise
            if self.health:
                self.health.tts_ms = round((time.perf_counter() - began) * 1000)
                if audio and self.health.first_pcm_at is None:
                    self.health.first_pcm_at = time.perf_counter()
            async def chunks():
                for start in range(0, len(audio), rate // 5 * 2):
                    yield audio[start:start + rate // 5 * 2]
            async for frame in self._stream_audio_frames_from_iterator(chunks(), in_sample_rate=rate, context_id=context_id):
                yield frame
        finally:
            if self.health:self.health.synthesizing -= 1
