"""Ephemeral input diagnostics and current draft. No audio recordings or saved drafts."""
import math
import time
import numpy as np
from pipecat.frames.frames import (InputAudioRawFrame, TranscriptionFrame, InterimTranscriptionFrame, VADUserStartedSpeakingFrame,
    BotStartedSpeakingFrame, BotStoppedSpeakingFrame, InterruptionFrame, ErrorFrame, VADUserStoppedSpeakingFrame)
from pipecat.processors.frame_processor import FrameProcessor

class SpeechHealth:
    def __init__(self):
        self.frames = 0
        self.last_audio = 0
        self.last_loud_audio = 0
        self.sample_rate = 0
        self.channels = 0
        self.level = 0.0
        self.speech_starts = 0
        self.transcriptions = 0
        self.partial_text='';self.partial_at=0;self.preview_ready=False;self.stage='listening';self.decode_ms=0
        self.model_active = False
        self.bot_speaking = False
        self.synthesizing = 0
        self.playback_gate = None
        self.user_speaking = False
        self.recognition_source = None
        self.recognition_language = None
        self.last_transcription_text = None
        self.last_transcription_language = None
        self.utterance_ms = None
        self.last_input_sound = 0
        self.input_end_at = None
        self.model_start_at = None
        self.first_text_at = None
        self.first_pcm_at = None
        self.first_playback_at = None
        self.tts_ms = None
        self.attention = None
        self.cloud_recognition = None

    def begin_turn(self):
        self.input_end_at = self.last_input_sound or None
        self.model_start_at = time.perf_counter()
        self.first_text_at = None
        self.first_pcm_at = None
        self.first_playback_at = None
        self.tts_ms = None

    def snapshot(self):
        now = time.perf_counter()
        gate = self.playback_gate
        paused = bool(gate and gate.input_blocked)
        if self.attention:
            self.attention.tick(self.model_active or self.bot_speaking or self.synthesizing or self.user_speaking or self.stage=='transcribing' or paused)
        return {"cloudRecognition":self.cloud_recognition,
                "inputFrames": self.frames, "sampleRate": self.sample_rate, "channels": self.channels,
                "inputLevel": round(self.level if now-self.last_audio < 2 else 0, 4),
                "receivingAudio": bool(self.frames and now-self.last_audio < 2),
                "recentSound": bool(self.last_loud_audio and now-self.last_loud_audio < 2),
                "speechStarts": self.speech_starts, "transcriptions": self.transcriptions,
                "partialText":self.partial_text if now-self.partial_at<15 and not (self.attention and self.attention.mode=='background') else '',"previewReady":self.preview_ready,
                "attention": self.attention.snapshot() if self.attention else None,
                "stage":('speaking' if gate.speaking else 'thinking' if gate.pending_replies else 'echo-tail') if gate and gate.blocked else self.stage,
                "canInterrupt":bool(gate and gate.barge_in and gate.foreground()),
                "decodeMs":self.decode_ms,"inputPaused":paused,
                "recognition":{"source":self.recognition_source,"language":self.recognition_language,"audioMs":self.utterance_ms},
                "inputPauseReason":gate.reason if gate else None,
                "echoSuppressedFrames":gate.suppressed_frames if gate else 0,
                "timing": {"asrAfterSoundMs": self._elapsed(self.input_end_at, self.model_start_at),
                           "modelFirstTextMs": self._elapsed(self.model_start_at, self.first_text_at),
                           "firstPcmAfterSoundMs": self._elapsed(self.input_end_at, self.first_pcm_at),
                           "firstPlaybackAfterSoundMs": self._elapsed(self.input_end_at, self.first_playback_at),
                           "ttsSynthesisMs": self.tts_ms}}

    @staticmethod
    def _elapsed(start, end):
        return round(max(0, end-start)*1000) if start is not None and end is not None else None

class SpeechHealthProbe(FrameProcessor):
    def __init__(self, health):
        super().__init__()
        self.health = health

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        state = self.health
        if isinstance(frame, InputAudioRawFrame):
            state.frames += 1
            state.last_audio = time.perf_counter()
            state.sample_rate, state.channels = frame.sample_rate, frame.num_channels
            samples = np.frombuffer(frame.audio, dtype="<i2").astype(np.float32) / 32768
            rms = float(np.sqrt(np.mean(samples*samples))) if len(samples) else 0
            state.level = max(rms, state.level*.85)
            if rms > .0008:
                state.last_loud_audio = state.last_audio
                if not state.playback_gate or not state.playback_gate.input_blocked:
                    state.last_input_sound = state.last_audio
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            state.speech_starts += 1
            state.user_speaking = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            state.user_speaking = False
        elif isinstance(frame, BotStartedSpeakingFrame):
            if state.first_playback_at is None:
                state.first_playback_at = time.perf_counter()
            state.user_speaking = False
            state.bot_speaking = True
            state.stage = 'speaking'
        elif isinstance(frame, BotStoppedSpeakingFrame):
            state.bot_speaking = False
            if state.stage != 'transcribing':
                state.stage = 'thinking' if state.model_active or state.synthesizing else 'listening'
        elif isinstance(frame, (InterruptionFrame, ErrorFrame)):
            state.bot_speaking = False
            if state.stage != 'transcribing':
                state.stage = 'listening'
        await self.push_frame(frame, direction)

class TranscriptionHealthProbe(FrameProcessor):
    def __init__(self, health):
        super().__init__()
        self.health = health

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and not isinstance(frame, InterimTranscriptionFrame) and frame.text.strip():
            self.health.transcriptions += 1
            self.health.last_transcription_text = frame.text
            value = getattr(frame.language, 'value', frame.language)
            language = str(value).lower().split('-')[0] if value else None
            self.health.last_transcription_language = language if language in ('en', 'tr') else None
        await self.push_frame(frame, direction)
