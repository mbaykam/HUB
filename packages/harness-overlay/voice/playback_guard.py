"""Per-call speakerphone protection, driven by audio playback rather than LLM text.

Browser/Telegram echo cancellation is best effort. Do not turn returned speaker
audio into a new user command. Keep silence flowing through VAD while playback
and its short acoustic/network tail are blocked. No audio is retained here.
"""
import asyncio
import time
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    InputAudioRawFrame, InterimTranscriptionFrame, TranscriptionFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.processors.frame_processor import FrameProcessor


class PlaybackGate:
    def __init__(self, *, tail_seconds=.9, clock=time.perf_counter):
        self.tail_seconds = tail_seconds
        self.clock = clock
        self.speaking = False
        self.until = 0
        self.generation = 0
        self.suppressed_frames = 0

    @property
    def blocked(self):
        return self.speaking or self.clock() < self.until

    @property
    def reason(self):
        return 'playback' if self.speaking else 'echo-tail' if self.blocked else None

    def observe(self, frame):
        if isinstance(frame, BotStartedSpeakingFrame) and not self.speaking:
            self.speaking = True
            self.generation += 1
        elif isinstance(frame, BotStoppedSpeakingFrame) and self.speaking:
            self.speaking = False
            self.until = self.clock() + self.tail_seconds
        # Interruption/error frames cannot open the microphone. Only the audio
        # transport's actual stopped signal starts the release countdown.


class PlaybackOutputProbe(FrameProcessor):
    def __init__(self, gate):
        super().__init__()
        self.gate = gate

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        self.gate.observe(frame)
        await self.push_frame(frame, direction)


class PlaybackInputGuard(FrameProcessor):
    def __init__(self, gate, *, mask_audio=True):
        super().__init__()
        self.gate = gate
        self.mask_audio = mask_audio

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if self.gate.blocked:
            if isinstance(frame, InputAudioRawFrame) and self.mask_audio:
                self.gate.suppressed_frames += 1
                # VAD must see silence, rather than retaining the previous
                # speaking state or having its clock stop during bot playback.
                frame.audio = bytes(len(frame.audio))
            elif isinstance(frame, (InterimTranscriptionFrame, TranscriptionFrame,
                                    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)):
                return
        await self.push_frame(frame, direction)


class EchoProtectedSTTMixin:
    """Respect the gate before buffering and discard decoding from an old turn.

SegmentedSTTService does not honor its base service's mute flag when buffering.
Clearing PCM/drafts is essential: otherwise echoed words reappear after unmute.
The ASR stream is reset only at the next real VAD start, never concurrently with
an in-flight decoder. Cancellation also waits for that bounded decode to finish.
"""
    def init_playback_guard(self, gate):
        self.playback_gate = gate
        self._playback_generation = gate.generation if gate else 0
        self._decode_lock = asyncio.Lock()

    def playback_suppressed(self):
        gate = self.playback_gate
        changed = bool(gate and gate.generation != self._playback_generation)
        if changed:
            self._playback_generation = gate.generation
        blocked = bool(gate and gate.blocked)
        if changed or blocked:
            self._audio_buffer.clear()
            self._user_speaking = False
            for name in ('pending', '_preview_buffer'):
                value = getattr(self, name, None)
                if value is not None: value.clear()
            self.previous_draft = ''
            self._preview_words = ''
            self._preview_language = None
            if self.health: self.health.partial_text = ''
        return blocked

    def decode_generation(self):
        return self.playback_gate.generation if self.playback_gate else 0

    def accepts_decode(self, generation):
        return not self.playback_suppressed() and self.decode_generation() == generation

    async def decode(self, function, *args):
        async with self._decode_lock:
            task = asyncio.create_task(asyncio.to_thread(function, *args))
            try:
                return await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise

    async def process_frame(self, frame, direction):
        blocked = self.playback_suppressed()
        if isinstance(frame, (VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)):
            if blocked or isinstance(frame, VADUserStoppedSpeakingFrame) and not self._user_speaking:
                return
        await super().process_frame(frame, direction)
