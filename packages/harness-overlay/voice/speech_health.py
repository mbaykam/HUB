"""Ephemeral input diagnostics and current draft. No audio recordings or saved drafts."""
import math
import time
import numpy as np
from pipecat.frames.frames import (InputAudioRawFrame, TranscriptionFrame, VADUserStartedSpeakingFrame,
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

    def snapshot(self):
        now = time.perf_counter()
        gate = self.playback_gate
        paused = bool(gate and gate.blocked)
        return {"inputFrames": self.frames, "sampleRate": self.sample_rate, "channels": self.channels,
                "inputLevel": round(self.level if now-self.last_audio < 2 else 0, 4),
                "receivingAudio": bool(self.frames and now-self.last_audio < 2),
                "recentSound": bool(self.last_loud_audio and now-self.last_loud_audio < 2),
                "speechStarts": self.speech_starts, "transcriptions": self.transcriptions,
                "partialText":self.partial_text if now-self.partial_at<15 else '',"previewReady":self.preview_ready,
                "stage":('speaking' if gate.speaking else 'echo-tail') if paused else self.stage,
                "decodeMs":self.decode_ms,"inputPaused":paused,
                "inputPauseReason":gate.reason if gate else None,
                "echoSuppressedFrames":gate.suppressed_frames if gate else 0}

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
        elif isinstance(frame, VADUserStartedSpeakingFrame):
            state.speech_starts += 1
            state.user_speaking = True
        elif isinstance(frame, VADUserStoppedSpeakingFrame):
            state.user_speaking = False
        elif isinstance(frame, BotStartedSpeakingFrame):
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
        if isinstance(frame, TranscriptionFrame) and frame.text.strip():
            self.health.transcriptions += 1
        await self.push_frame(frame, direction)
