"""Speakerphone feedback boundaries and concurrent decoder delivery."""
import asyncio
import sys
import threading
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from playback_guard import PlaybackGate, PlaybackInputGuard
from speech_health import SpeechHealth
from pipecat.frames.frames import (BotStartedSpeakingFrame, BotStoppedSpeakingFrame,
    InterruptionFrame, ErrorFrame, InputAudioRawFrame, TranscriptionFrame,
    VADUserStartedSpeakingFrame)
from pipecat.processors.frame_processor import FrameDirection


def test_only_actual_playback_stopped_releases_mic_and_duplicate_signal_does_not_extend_tail():
    now = [10.0]
    gate = PlaybackGate(clock=lambda: now[0])
    assert not gate.blocked
    gate.observe(BotStartedSpeakingFrame())
    gate.observe(BotStartedSpeakingFrame())
    assert gate.generation == 1 and gate.reason == 'playback'
    gate.observe(InterruptionFrame()); gate.observe(ErrorFrame('recoverable'))
    assert gate.blocked
    gate.observe(BotStoppedSpeakingFrame()); now[0] += .5
    gate.observe(BotStoppedSpeakingFrame())
    assert gate.reason == 'echo-tail'
    now[0] += .41
    assert not gate.blocked


def test_diagnostics_do_not_advertise_listening_during_playback_or_its_echo_tail():
    now = [10.0]; gate = PlaybackGate(clock=lambda:now[0]); health = SpeechHealth()
    health.playback_gate = gate
    gate.observe(BotStartedSpeakingFrame())
    assert health.snapshot()['inputPaused'] and health.snapshot()['stage']=='speaking'
    gate.observe(BotStoppedSpeakingFrame())
    assert health.snapshot()['stage']=='echo-tail'
    now[0] += 1
    assert not health.snapshot()['inputPaused']


@pytest.mark.asyncio
async def test_gate_keeps_vad_clock_running_with_silence_and_allows_explicit_interrupt():
    gate = PlaybackGate(); gate.observe(BotStartedSpeakingFrame())
    guard = PlaybackInputGuard(gate)
    from pipecat.tests.utils import run_test
    audio = InputAudioRawFrame(audio=b'\x01\x7f'*320,sample_rate=16000,num_channels=1)
    # A manual interruption uses the existing pipeline, without creating text.
    down,up=await run_test(guard,frames_to_send=[audio,TranscriptionFrame('echo','', ''),
        VADUserStartedSpeakingFrame(),InterruptionFrame()])
    assert any(isinstance(f,InputAudioRawFrame) and f.audio==bytes(640) for f in down)
    assert not any(isinstance(f,(TranscriptionFrame,VADUserStartedSpeakingFrame,ErrorFrame)) for f in down+up)
    assert any(isinstance(f,InterruptionFrame) for f in down) and gate.blocked


@pytest.fixture
def stt(monkeypatch):
    import native_streaming_stt as module
    class Recognizer:
        language='auto'; result_language='en'
        def __init__(self,*args): pass
        def reset(self): pass
        def feed(self,audio): return 'speaker echo'
        def finish(self,audio): return 'speaker echo'
    monkeypatch.setattr(module,'StreamingRecognizer',Recognizer)
    gate=PlaybackGate(tail_seconds=.01)
    service=module.LocalStreamingSTTService({'model':'3.5-560ms','language':'auto'},health=SpeechHealth(),playback_gate=gate)
    async def noop(*args): pass
    service.start_processing_metrics=noop; service.stop_processing_metrics=noop
    return service,gate


@pytest.mark.asyncio
async def test_echo_never_enters_segment_or_draft_buffer_and_next_human_can_speak(stt):
    service,gate=stt
    service._audio_buffer.extend(b'old');service.pending.extend(b'old');service.previous_draft='old'
    service.health.partial_text='old';service._user_speaking=True
    gate.observe(BotStartedSpeakingFrame())
    audio=InputAudioRawFrame(audio=b'\x01\x7f'*320,sample_rate=16000,num_channels=1)
    await service.process_audio_frame(audio,FrameDirection.DOWNSTREAM)
    assert not service._audio_buffer and not service.pending and not service.health.partial_text
    assert not service._user_speaking
    gate.observe(BotStoppedSpeakingFrame());await asyncio.sleep(.02)
    await service._handle_user_started_speaking(VADUserStartedSpeakingFrame())
    service.recognizer.finish=lambda _audio:'Can you hear me?'
    frames=[f async for f in service.run_stt(bytes(640))]
    assert len(frames)==1 and frames[0].text=='Can you hear me?'


@pytest.mark.asyncio
async def test_decode_that_finishes_after_playback_unmutes_is_still_discarded(stt):
    service,gate=stt; began=threading.Event(); release=threading.Event()
    def slow_finish(_audio):
        began.set();assert release.wait(3);return 'late speaker echo'
    service.recognizer.finish=slow_finish
    async def collect(): return [f async for f in service.run_stt(bytes(640))]
    decoding=asyncio.create_task(collect())
    while not began.is_set():await asyncio.sleep(.005)
    gate.observe(BotStartedSpeakingFrame());gate.observe(BotStoppedSpeakingFrame())
    await asyncio.sleep(.02);release.set()
    assert await decoding==[]
    assert not service.health.partial_text


@pytest.mark.asyncio
async def test_cancel_waits_for_stream_decoder_before_resetting_it(stt):
    service,_=stt; began=threading.Event(); release=threading.Event(); order=[]
    def slow():began.set();release.wait(3);order.append('decoded')
    first=asyncio.create_task(service.decode(slow))
    while not began.is_set():await asyncio.sleep(.005)
    first.cancel();second=asyncio.create_task(service.decode(lambda:order.append('reset')))
    await asyncio.sleep(.02);assert order==[]
    release.set()
    with pytest.raises(asyncio.CancelledError):await first
    await second
    assert order==['decoded','reset']
