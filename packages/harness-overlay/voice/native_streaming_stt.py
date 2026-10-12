"""Pipecat VAD gates a local streaming ASR; drafts never start assistant work."""
import asyncio
import time
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame
from pipecat.services.settings import STTSettings
from pipecat.services.stt_service import SegmentedSTTService
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601
from lingua import Language as DetectedLanguage, LanguageDetectorBuilder
from streaming_asr import StreamingRecognizer
from playback_guard import EchoProtectedSTTMixin


class LocalStreamingSTTService(EchoProtectedSTTMixin, SegmentedSTTService):
    def __init__(self, speech, *, health=None, playback_gate=None, **kwargs):
        language = speech.get('language', 'auto')
        super().__init__(settings=STTSettings(model=speech['model'], language=None if language=='auto' else language),
                         sample_rate=16000, ttfs_p99_latency=.65, **kwargs)
        self.recognizer = StreamingRecognizer(language)
        self.health = health
        self.init_playback_guard(playback_gate)
        self.pending = bytearray()
        self.previous_draft = ''
        self.detector = LanguageDetectorBuilder.from_languages(DetectedLanguage.ENGLISH, DetectedLanguage.TURKISH).build()
        if health:
            health.preview_ready = True

    @property
    def wants_wav_segments(self):
        return False

    def language(self, text):
        if self.recognizer.language != 'auto':
            return Language.TR if self.recognizer.language=='tr' else Language.EN
        return Language.TR if self.detector.detect_language_of(text)==DetectedLanguage.TURKISH else Language.EN

    async def _handle_user_started_speaking(self, frame):
        await super()._handle_user_started_speaking(frame)
        await self.decode(self.recognizer.reset)
        self.pending.clear()
        self.previous_draft = ''
        if self.health:
            self.health.partial_text = ''
            self.health.stage = 'listening'
        # Include the actual audio arriving before VAD decided speech began.
        # Future frames feed once; no duplicate decoding of the full utterance.
        if self._audio_buffer:
            await self.decode(self.recognizer.feed, bytes(self._audio_buffer))

    async def process_audio_frame(self, frame, direction):
        if self.playback_suppressed() or self._muted:
            return
        generation = self.decode_generation()
        await super().process_audio_frame(frame, direction)
        if not self._user_speaking:
            return
        self.pending.extend(frame.audio)
        if len(self.pending) < 6400:
            return
        audio = bytes(self.pending)
        self.pending.clear()
        draft = await self.decode(self.recognizer.feed, audio)
        if not self.accepts_decode(generation):
            return
        if draft and draft != self.previous_draft:
            self.previous_draft = draft
            if self.health:
                self.health.partial_text = draft[-2000:]
                self.health.partial_at = time.perf_counter()
            await self.push_frame(InterimTranscriptionFrame(draft, self._user_id, time_now_iso8601(), self.language(draft)))

    async def run_stt(self, audio):
        if self.playback_suppressed() or self._muted:
            return
        generation = self.decode_generation()
        started = time.perf_counter()
        if self.health:
            self.health.stage = 'transcribing'
        await self.start_processing_metrics()
        try:
            if self.pending:
                pending = bytes(self.pending)
                self.pending.clear()
                await self.decode(self.recognizer.feed, pending)
            if not self.accepts_decode(generation):
                return
            text = await self.decode(self.recognizer.finish, audio)
            if text and self.accepts_decode(generation):
                if self.health:
                    self.health.recognition_source = self.recognizer.result_source
                    self.health.recognition_language = self.recognizer.result_language
                    self.health.utterance_ms = round(len(audio)/32)
                code = self.recognizer.result_language
                language = Language.TR if code=='tr' else Language.EN if code=='en' else self.language(text)
                yield TranscriptionFrame(text, self._user_id, time_now_iso8601(), language)
        finally:
            await self.stop_processing_metrics()
            if self.health:
                self.health.decode_ms = round((time.perf_counter()-started)*1000)
                self.health.partial_text = ''
                if self.accepts_decode(generation): self.health.stage = 'listening'
