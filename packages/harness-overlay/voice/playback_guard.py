"""Per-call speakerphone protection through synthesis, playback and its tail.

Browser/Telegram echo cancellation is best effort. Do not turn returned speaker
audio into a new user command. Keep silence flowing through VAD while playback
and its short acoustic/network tail are blocked. No audio is retained here.
"""
import asyncio
import time
from dataclasses import dataclass
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    DataFrame, InputAudioRawFrame, InterimTranscriptionFrame, TranscriptionFrame,
    InterruptionFrame, LLMFullResponseStartFrame, LLMFullResponseEndFrame,
    LLMTextFrame, TTSSpeakFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


@dataclass
class SpokenReplyFinishedFrame(DataFrame):
    """Ordered behind TTS contexts and transport audio; never a client event."""
    reply_id: int


class PlaybackGate:
    def __init__(self, *, tail_seconds=.9, clock=time.perf_counter):
        self.tail_seconds = tail_seconds
        self.clock = clock
        self.speaking = False
        self.until = 0
        self.generation = 0
        self.suppressed_frames = 0
        self.pending_replies = set()

    @property
    def blocked(self):
        return self.speaking or bool(self.pending_replies) or self.clock() < self.until

    @property
    def reason(self):
        return ('playback' if self.speaking else 'reply' if self.pending_replies
                else 'echo-tail' if self.blocked else None)

    def begin_reply(self, reply_id):
        if reply_id not in self.pending_replies:
            self.pending_replies.add(reply_id)
            # Invalidate a decode that began before the response was queued.
            self.generation += 1

    def finish_reply(self, reply_id):
        if reply_id in self.pending_replies:
            self.pending_replies.remove(reply_id)
            self.until = max(self.until, self.clock() + self.tail_seconds)

    def interrupt_reply(self):
        # Explicit Interrupt cancels queued synthesis. Actual playback still
        # needs its transport stop signal and acoustic tail before unmuting.
        self.pending_replies.clear()

    def observe(self, frame):
        if isinstance(frame, BotStartedSpeakingFrame) and not self.speaking:
            self.speaking = True
            self.generation += 1
        elif isinstance(frame, BotStoppedSpeakingFrame) and self.speaking:
            self.speaking = False
            self.until = self.clock() + self.tail_seconds
        # Interruption/error frames cannot open the microphone. Only the audio
        # transport's actual stopped signal starts the release countdown.


class SpokenReplyProbe(FrameProcessor):
    """Hold input from the first spoken text until all of that reply plays.

    BotStopped can occur between slow sentences. A data-frame marker survives
    neither interruption nor cancellation, and both TTS and the output transport
    order it after their audio queues. A stale marker cannot release a new reply.
    """
    def __init__(self, gate):
        super().__init__()
        self.gate = gate
        self.reply_id = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InterruptionFrame):
            self.gate.interrupt_reply()
            self.reply_id = None
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, LLMFullResponseStartFrame):
                self.reply_id = frame.id
            elif isinstance(frame, LLMTextFrame) and not frame.skip_tts and frame.text.strip():
                if self.reply_id is None:
                    self.reply_id = frame.id
                self.gate.begin_reply(self.reply_id)
            elif isinstance(frame, TTSSpeakFrame) and frame.text.strip():
                self.gate.begin_reply(frame.id)
                await self.push_frame(frame, direction)
                await self.push_frame(SpokenReplyFinishedFrame(frame.id), direction)
                return
            elif isinstance(frame, LLMFullResponseEndFrame):
                reply_id, self.reply_id = self.reply_id, None
                await self.push_frame(frame, direction)
                if reply_id in self.gate.pending_replies:
                    await self.push_frame(SpokenReplyFinishedFrame(reply_id), direction)
                return
        await self.push_frame(frame, direction)


class PlaybackOutputProbe(FrameProcessor):
    def __init__(self, gate):
        super().__init__()
        self.gate = gate

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, SpokenReplyFinishedFrame):
            if direction == FrameDirection.DOWNSTREAM:
                self.gate.finish_reply(frame.reply_id)
            return
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
