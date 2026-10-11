"""Real offline speech and turn boundaries; no ambient microphone or provider calls."""
import sys
import os
from pathlib import Path
import numpy as np
import pytest
import soxr

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from pipecat.frames.frames import (VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame,
    InterimTranscriptionFrame, TranscriptionFrame, BotStartedSpeakingFrame)
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy


@pytest.mark.asyncio
async def test_background_vad_and_provisional_words_cannot_interrupt_a_reply():
    strategy = MinWordsUserTurnStartStrategy(min_words=1, use_interim=False)
    starts = []
    @strategy.event_handler('on_user_turn_started')
    async def started(*args):
        starts.append(args)
    await strategy.process_frame(BotStartedSpeakingFrame())
    for _ in range(3):
        await strategy.process_frame(VADUserStartedSpeakingFrame())
        await strategy.process_frame(InterimTranscriptionFrame('hello', '', ''))
        await strategy.process_frame(VADUserStoppedSpeakingFrame())
    assert not starts
    await strategy.process_frame(TranscriptionFrame('Can you hear me?', '', ''))
    assert len(starts) == 1


@pytest.fixture(scope='module')
def stt():
    if os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1":
        pytest.skip("Explicit cached-model acceptance check")
    from whisper_auto import AutomaticWhisperSTTService
    from pipecat.services.whisper.stt import WhisperSTTService
    from speech_settings import whisper_path
    return AutomaticWhisperSTTService(device='cpu', compute_type='int8',
        settings=WhisperSTTService.Settings(model=str(whisper_path('base')), language=None))


@pytest.mark.parametrize('kind', ['silence', 'quiet-noise', 'tone'])
def test_non_speech_does_not_invent_hello(stt, kind):
    count = 32000
    if kind == 'silence': samples = np.zeros(count)
    elif kind == 'quiet-noise': samples = np.random.default_rng(42).normal(0, .002, count)
    else: samples = .015 * np.sin(2 * np.pi * 440 * np.arange(count) / 16000)
    text, _ = stt._transcribe_audio((samples * 32767).astype('<i2').tobytes())
    assert not text, (kind, text)


@pytest.mark.parametrize('code,text,expected', [
    ('tr', 'Merhaba, beni duyuyor musun?', 'beni duy'),
    ('en', 'Can you hear me? I am speaking quietly.', 'hear me'),
])
def test_quiet_bilingual_speech_still_reaches_final_transcription(stt, code, text, expected):
    from bilingual_tts import LocalSpeechSynthesizer
    settings = {'engine':'piper', 'model':'tr_TR-dfki-medium', 'voice':'tr_TR-dfki-medium'} if code == 'tr' else {'engine':'kokoro', 'model':'82m', 'voice':'am_echo'}
    raw, rate = LocalSpeechSynthesizer(settings).synthesize(text)
    samples = soxr.resample(np.frombuffer(raw, dtype='<i2').astype(np.float32), rate, 16000)
    samples *= .03 * 32767 / max(abs(samples))
    final, language = stt._transcribe_audio(samples.astype('<i2').tobytes())
    assert expected in final.lower(), final
    assert language == code


@pytest.mark.asyncio
@pytest.mark.parametrize('texts', [
    ['Merhaba, seni duyuyorum.', 'Yes, I can hear you clearly.', 'Türkçe konuşmaya devam edebiliriz.'],
    ['Yes, I can hear you clearly.', 'Merhaba, seni duyuyorum.', 'We can switch back to English.'],
])
@pytest.mark.skipif(os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1", reason="Explicit cached-model acceptance check")
async def test_selected_bella_and_turkish_voice_both_emit_audio_after_language_switches(texts):
    import asyncio
    from bilingual_tts import BilingualTTSService
    from pipecat.frames.frames import TTSSpeakFrame, TTSAudioRawFrame, ErrorFrame
    from pipecat.tests.utils import run_test
    emitted = []
    class RecordingSpeech(BilingualTTSService):
        async def run_tts(self, text, context_id):
            audio = []
            async for frame in super().run_tts(text, context_id):
                if isinstance(frame, TTSAudioRawFrame): audio.append(frame)
                yield frame
            emitted.append((text, audio))
    tts = RecordingSpeech({'engine':'bilingual', 'model':'kokoro-piper', 'voice':'af_bella',
                          'turkishVoice':'tr_TR-dfki-medium', 'language':'auto'}, sample_rate=16000)
    down, up = await asyncio.wait_for(run_test(tts,
        frames_to_send=[TTSSpeakFrame(text) for text in texts], start_timeout=15), 90)
    assert not any(isinstance(frame, ErrorFrame) for frame in down + up)
    assert len(emitted) == len(texts)
    for text, audio in emitted:
        assert audio, text
        assert all(frame.sample_rate == 16000 for frame in audio)
        assert any(np.any(np.frombuffer(frame.audio, dtype='<i2')) for frame in audio)
