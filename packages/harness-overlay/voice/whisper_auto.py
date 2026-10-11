"""Enable faster-whisper auto language detection through Pipecat 1.8.1.

The stock adapter incorrectly treats None as an unsupported language before
calling faster-whisper, whose documented auto detection uses language=None.
Keep every other stock validation and segmentation/barge-in behavior.
"""
from pipecat.services.whisper.stt import WhisperSTTService
from faster_whisper import WhisperModel
from functools import lru_cache
import asyncio
import numpy as np
import time
import re
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601
from playback_guard import EchoProtectedSTTMixin

@lru_cache(maxsize=2)
def whisper_runtime(path, device, compute_type):
    return WhisperModel(path, device=device, compute_type=compute_type)

class AutomaticWhisperSTTService(EchoProtectedSTTMixin, WhisperSTTService):
    def __init__(self, *, health=None, playback_gate=None, **kwargs):
        self.health=health
        self._preview_buffer=bytearray();self._last_language=None
        self._preview_language=None;self._preview_words=''
        super().__init__(**kwargs)
        self.init_playback_guard(playback_gate)
        try:
            from streaming_preview import StreamingPreview
            language=self._settings.language or 'auto'
            self._preview=StreamingPreview(language)
            if health:health.preview_ready=True
        except (ImportError,RuntimeError,OSError):
            self._preview=None

    async def _handle_user_started_speaking(self, frame):
        await super()._handle_user_started_speaking(frame)
        if self._preview:await self.decode(self._preview.reset)
        self._preview_language=None;self._preview_words=''
        if self.health:self.health.stage='listening';self.health.partial_text=''

    async def process_audio_frame(self, frame, direction):
        if self.playback_suppressed() or self._muted:return
        generation=self.decode_generation()
        await super().process_audio_frame(frame,direction)
        if not self._preview:return
        self._preview_buffer.extend(frame.audio)
        if not self._user_speaking:
            del self._preview_buffer[:-6400]
            return
        if len(self._preview_buffer)<6400:return
        audio=bytes(self._preview_buffer);self._preview_buffer.clear()
        result=await self.decode(self._preview.feed,audio,self._last_language)
        if result and self.accepts_decode(generation):
            text,code=result
            self._preview_language=code;self._preview_words=text
            if self.health:self.health.partial_text=text[-2000:];self.health.partial_at=time.perf_counter()
            await self.push_frame(InterimTranscriptionFrame(text,self._user_id,time_now_iso8601(),Language.TR if code=='tr' else Language.EN))
    def _load(self):
        self._model = whisper_runtime(self._settings.model, self._device, self._compute_type)
        unsupported = self._unsupported_language()
        if unsupported:
            raise ValueError(unsupported)

    def _unsupported_language(self):
        supported = getattr(self._model, "supported_languages", [])
        if self._settings.language is None and "en" in supported and "tr" in supported:
            return None
        return super()._unsupported_language()

    def _transcribe_audio(self, audio):
        """Consume the lazy decoder here, entirely off the real-time loop.

        Whisper returns a generator: offloading only transcribe() leaves the
        actual decoding on the event loop and stalls audio/heartbeats. Its
        combined speech/log-probability filter is more appropriate than the
        stock adapter's extra unconditional 0.4 no-speech cutoff.
        """
        samples = np.frombuffer(audio, dtype="<i2").astype(np.float32) / 32768.0
        peak = float(np.max(np.abs(samples))) if len(samples) else 0
        if peak < 0.0001:
            return "", None
        # Improve softly recorded speech, without unboundedly boosting silence.
        if peak < .12:
            samples *= min(8.0, .12 / peak)
        language = self._settings.language
        if language is None and len(samples) <= 16000 * 4:
            # Whisper's language detection is unreliable for a lone greeting
            # (quiet Merhaba became the English name "Matt Hauber"). Use only
            # an unambiguous greeting actually heard by the local recognizer;
            # do not seed words into the decoder or promote draft text.
            draft = re.findall(r'\w+', getattr(self, '_preview_words', '').lower())
            code = getattr(self, '_preview_language', None)
            greetings = {'tr': {'merhaba','selam','evet','hayır','tamam','teşekkürler'},
                         'en': {'hello','hi','yes','no','thanks','okay'}}
            if code in greetings and draft and all(word in greetings[code] for word in draft):
                language = code
        segments, info = self._model.transcribe(samples, language=language, beam_size=3,
            condition_on_previous_text=False, no_speech_threshold=.6)
        if language is None and info.language not in ("en", "tr"):
            probabilities = dict(info.all_language_probs or [])
            language = max(("en", "tr"), key=lambda code: probabilities.get(code, 0))
            segments, info = self._model.transcribe(samples, language=language, beam_size=3,
                condition_on_previous_text=False, no_speech_threshold=.6)
        text = " ".join(segment.text.strip() for segment in segments if segment.text.strip()).strip()
        return text, info.language

    async def run_stt(self, audio):
        if self.playback_suppressed() or self._muted:return
        generation=self.decode_generation()
        health=getattr(self,'health',None)
        started=time.perf_counter()
        if health:health.stage='transcribing'
        await self.start_processing_metrics()
        try:
            text, code = await self.decode(self._transcribe_audio, audio)
        finally:
            await self.stop_processing_metrics()
            if health:
                health.decode_ms=round((time.perf_counter()-started)*1000);health.partial_text=''
                if self.accepts_decode(generation):health.stage='listening'
        if text and self.accepts_decode(generation):
            self._last_language=code
            language = Language.TR if code == "tr" else Language.EN
            await self._handle_transcription(text, True, language)
            yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), language)
