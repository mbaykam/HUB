"""Real Pipecat TTS/output queues with synthetic audio and slow next clauses."""
import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from bilingual_tts import BilingualTTSService
from playback_guard import PlaybackGate, PlaybackInputGuard, PlaybackOutputProbe, SpokenReplyProbe
from pipecat.frames.frames import (LLMFullResponseStartFrame, LLMFullResponseEndFrame,
    LLMTextFrame, TranscriptionFrame, TTSSpeakFrame, InterruptionFrame)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.tests.utils import run_test, SleepFrame
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams


class PacedOutput(BaseOutputTransport):
    def __init__(self):
        super().__init__(TransportParams(audio_out_enabled=True, audio_out_sample_rate=16000))
        self.writes = 0

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame):
        self.writes += 1
        await asyncio.sleep(len(frame.audio) / (frame.sample_rate * frame.num_channels * 2))
        return True


class CaptureInput(FrameProcessor):
    def __init__(self):
        super().__init__()
        self.texts = []

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame):
            self.texts.append(frame.text)
        await self.push_frame(frame, direction)


def fixture_pipeline(monkeypatch, *, slow_seconds):
    import bilingual_tts
    class Synth:
        def __init__(self, _settings):
            self.calls = 0

        def synthesize(self, _text):
            self.calls += 1
            # Simulate CPU synthesis, never a microphone or network service.
            time.sleep(.15 if self.calls == 1 else slow_seconds)
            return b'\x01\x04' * 1920, 16000
    monkeypatch.setattr(bilingual_tts, 'LocalSpeechSynthesizer', Synth)
    gate = PlaybackGate(tail_seconds=.05)
    capture = CaptureInput()
    output = PacedOutput()
    processors = [PlaybackInputGuard(gate), capture]
    # Reproduce the old unprotected gap with the identical stock TTS/transport.
    if not os.environ.get('HUB_TEST_ORIGINAL_REPLY_GATE'):
        processors.append(SpokenReplyProbe(gate))
    processors.extend([BilingualTTSService({'engine':'bilingual','model':'en-tr','voice':'test'},
                                          sample_rate=16000), output, PlaybackOutputProbe(gate)])
    return Pipeline(processors), gate, capture, output


@pytest.mark.asyncio
async def test_echo_during_slow_next_clause_is_dropped_and_real_thanks_afterward_is_accepted(monkeypatch):
    pipeline, gate, capture, output = fixture_pipeline(monkeypatch, slow_seconds=4.5)
    await asyncio.wait_for(run_test(pipeline, frames_to_send=[
        LLMFullResponseStartFrame(),
        LLMTextFrame('People find meaning in relationships, creativity, kindness, learning and purpose. '),
        LLMTextFrame('There is no single answer, and your own answer can change over time. '),
        LLMFullResponseEndFrame(),
        SleepFrame(3.7), TranscriptionFrame('Thank you.', '', ''),
        SleepFrame(1.8), TranscriptionFrame('Thank you, that helps.', '', ''),
    ]), timeout=12)
    assert output.writes >= 6
    assert capture.texts == ['Thank you, that helps.']
    assert not gate.pending_replies and not gate.blocked


@pytest.mark.asyncio
async def test_notifications_release_guard_after_playback_and_explicit_interrupt_keeps_pipeline_usable(monkeypatch):
    pipeline, gate, capture, output = fixture_pipeline(monkeypatch, slow_seconds=.15)
    await asyncio.wait_for(run_test(pipeline, frames_to_send=[
        TTSSpeakFrame('Your research task has finished.'),
        SleepFrame(.04), TranscriptionFrame('speaker echo', '', ''), InterruptionFrame(),
        SleepFrame(.3), TTSSpeakFrame('You can keep talking.'),
        SleepFrame(.7), TranscriptionFrame('Thank you.', '', ''),
    ]), timeout=5)
    assert output.writes and capture.texts == ['Thank you.']
    assert not gate.pending_replies and not gate.blocked
