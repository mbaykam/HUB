"""A cancelled CPU synthesis cannot overlap or leak PCM into the next reply."""
import asyncio
from pathlib import Path
import sys
import threading
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from bilingual_tts import BilingualTTSService
from speech_health import SpeechHealth


@pytest.mark.asyncio
async def test_interrupted_synthesis_finishes_before_reuse_and_emits_no_old_pcm(monkeypatch):
    import bilingual_tts
    began = threading.Event()
    release = threading.Event()
    order = []
    class Speech:
        def __init__(self, settings): pass
        def synthesize(self, text):
            if text == 'old':
                began.set()
                assert release.wait(3)
            order.append(text)
            return b'\x01\x04' * 320, 16000
    monkeypatch.setattr(bilingual_tts, 'LocalSpeechSynthesizer', Speech)
    health = SpeechHealth()
    service = BilingualTTSService({'engine':'bilingual','model':'en-tr','voice':'test'}, sample_rate=16000, health=health)
    service._sample_rate = 16000
    async def audio_frames(chunks, **kwargs):
        async for chunk in chunks:
            yield chunk
    service._stream_audio_frames_from_iterator = audio_frames
    async def collect(text):
        return [frame async for frame in service.run_tts(text, text)]
    old = asyncio.create_task(collect('old'))
    while not began.is_set(): await asyncio.sleep(.005)
    old.cancel()
    new = asyncio.create_task(collect('new'))
    await asyncio.sleep(.02)
    assert order == []
    release.set()
    with pytest.raises(asyncio.CancelledError): await old
    assert await new == [b'\x01\x04' * 320]
    assert order == ['old', 'new']
    assert health.synthesizing == 0
    await service.cleanup()
