"""Actual local TTS framing/transport primitives, without devices or APIs."""
import asyncio
from pathlib import Path
import sys
from types import SimpleNamespace

import numpy as np
import pytest
import soxr

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from bilingual_tts import BilingualTTSService
from voice_pipeline import CALL_OUTPUT_SAMPLE_RATE
from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.audio.resamplers.soxr_stream_resampler import SOXRStreamAudioResampler


@pytest.mark.asyncio
@pytest.mark.parametrize('source_rate', [22050, 24000, 44100])
async def test_complete_speech_tail_reaches_native_call_rate_after_synthesis_gaps(monkeypatch, source_rate):
    import bilingual_tts
    # A very short final syllable after silence exposes retained resampler tails.
    samples = np.zeros(source_rate, dtype='<i2')
    tail = source_rate // 50
    samples[-tail:] = (np.sin(2*np.pi*300*np.arange(tail)/source_rate)*12000).astype('<i2')

    class Synth:
        def __init__(self, settings): pass
        def synthesize(self, text): return samples.tobytes(), source_rate

    monkeypatch.setattr(bilingual_tts, 'LocalSpeechSynthesizer', Synth)
    service = BilingualTTSService({'engine':'bilingual','model':'fixture','voice':'fixture'},
                                  sample_rate=CALL_OUTPUT_SAMPLE_RATE)
    service._sample_rate = CALL_OUTPUT_SAMPLE_RATE
    output_resampler = SOXRStreamAudioResampler()
    reference = np.rint(np.clip(soxr.resample(samples.astype(np.float32), source_rate, 48000),
                               -32768, 32767)).astype('<i2').tobytes()
    try:
        for text in ['The last word.', 'Son kelime.']:
            # A subsequent sentence must not depend on the previous converter's
            # retained history, regardless of time spent generating its audio.
            output_resampler._last_resample_time = 0
            frames = [f async for f in service.run_tts(text, text)]
            assert frames and all(isinstance(f, TTSAudioRawFrame) for f in frames)
            delivered = b''.join([await output_resampler.resample(f.audio, f.sample_rate, 48000)
                                  for f in frames])
            assert delivered == reference
            assert len(delivered) == 48000*2
            assert np.max(np.abs(np.frombuffer(delivered[-1920:], dtype='<i2'))) > 10000
    finally:
        await service.cleanup()


@pytest.mark.asyncio
async def test_pwa_and_telegram_raw_playback_preserve_every_sample(monkeypatch):
    from pipecat.transports.smallwebrtc.transport import RawAudioTrack
    import pipecat.transports.smallwebrtc.transport as webrtc
    import telegram_transport
    from pipecat.transports.base_transport import TransportParams

    assert CALL_OUTPUT_SAMPLE_RATE == 48000
    samples = (np.arange(4800, dtype=np.int32) % 24001 - 12000).astype('<i2')
    original = samples.tobytes()
    clock = [0.0]
    def now():
        clock[0] += .01
        return clock[0]
    monkeypatch.setattr(webrtc.time, 'time', now)
    track = RawAudioTrack(CALL_OUTPUT_SAMPLE_RATE, auto_silence=False)
    done = track.add_audio_bytes(original)
    received = b''.join([(await track.recv()).to_ndarray().tobytes() for _ in range(10)])
    await done
    assert received == original

    sent = []
    async def send_frame(peer, device, audio): sent.append(audio)
    owner = SimpleNamespace(ready=True, peer=1, calls=SimpleNamespace(send_frame=send_frame))
    output = telegram_transport.TelegramOutput(TransportParams(), owner)
    monkeypatch.setattr(telegram_transport.time, 'perf_counter', now)
    assert await output.write_audio_frame(TTSAudioRawFrame(original, 48000, 1))
    assert len(sent) == 10 and all(len(chunk) == 960 for chunk in sent)
    assert b''.join(sent) == original
    assert not output.pending
