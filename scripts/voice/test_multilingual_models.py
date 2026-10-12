"""Actual local model regression tests. Never opens a microphone or a phone call."""
import asyncio
import os
from pathlib import Path
import sys
import numpy as np
import pytest
pytestmark = pytest.mark.skipif(os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1", reason="Explicit cached-model acceptance check")
import soxr

sys.path.insert(0, str(Path(__file__).resolve().parents[2]/'packages/harness-overlay/voice'))
from streaming_asr import StreamingRecognizer
from bilingual_tts import LocalSpeechSynthesizer, BilingualTTSService
from supertonic_tts import SupertonicSynthesizer
from speech_health import SpeechHealth

SPEECH = {'engine':'supertonic','model':'supertonic-3','voice':'F1','language':'auto','steps':6}


@pytest.fixture(scope='module')
def recognizer():
    return StreamingRecognizer()


@pytest.mark.parametrize('code, text, expected', [
    ('tr','Merhaba, beni duyuyor musun?', 'beni duy'),
    ('en','Can you hear me? I am speaking quietly.', 'hear me'),
    ('tr','Merhaba.', 'merhaba'),
    ('en','Hello.', 'hello'),
])
def test_quiet_calls_switch_language_without_reusing_previous_utterance(recognizer, code, text, expected):
    settings = {'engine':'piper','model':'tr_TR-dfki-medium','voice':'tr_TR-dfki-medium'} if code=='tr' else {'engine':'kokoro','model':'82m','voice':'am_echo'}
    raw, rate = LocalSpeechSynthesizer(settings).synthesize(text)
    samples = soxr.resample(np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768,rate,16000)
    # The exact same input voices were used with the previous installation.
    samples = samples / max(np.max(np.abs(samples)),.001) * .01
    raw = (samples * 32767).astype('<i2').tobytes()
    recognizer.reset()
    drafts=[]
    for offset in range(0,len(raw),6400):
        drafts.append(recognizer.feed(raw[offset:offset+6400]))
    import time
    started=time.perf_counter()
    final=recognizer.finish()
    if text=='Merhaba.':
        assert time.perf_counter()-started < 1, 'A validated Turkish greeting must not await redundant decoders'
    assert expected in final.lower(), final
    assert not ('hello' in final.lower() and code=='tr'), final


@pytest.mark.parametrize('kind',['silence','quiet-noise','tone'])
def test_controls_do_not_create_commands(recognizer,kind):
    samples=np.zeros(48000) if kind=='silence' else np.random.default_rng(2026).normal(0,.0002,48000) if kind=='quiet-noise' else .002*np.sin(2*np.pi*440*np.arange(48000)/16000)
    raw=(samples*32767).astype('<i2').tobytes()
    recognizer.reset()
    for offset in range(0,len(raw),6400):recognizer.feed(raw[offset:offset+6400])
    assert not recognizer.finish()


@pytest.mark.asyncio
async def test_same_multilingual_speaker_uses_call_rate_without_errors_on_language_switch():
    from pipecat.frames.frames import TTSSpeakFrame, TTSAudioRawFrame, ErrorFrame
    from pipecat.tests.utils import run_test
    requests=[]
    class RecordingSpeech(BilingualTTSService):
        async def run_tts(self,text,context_id):
            audio=[]
            async for frame in super().run_tts(text,context_id):
                if isinstance(frame,TTSAudioRawFrame):audio.append(frame)
                yield frame
            requests.append((text,audio))
    tts=RecordingSpeech(SPEECH,sample_rate=16000)
    style=tts.synthesizer.style
    phrases=['Merhaba, seni duyuyorum.','Yes, I can hear you clearly.','Türkçe konuşmaya devam edebiliriz.','We can switch back to English.']
    down,up=await asyncio.wait_for(run_test(tts,frames_to_send=[TTSSpeakFrame(t) for t in phrases],start_timeout=15),90)
    assert tts.synthesizer.style is style
    assert not any(isinstance(f,ErrorFrame) for f in down+up)
    assert len(requests)==4
    for text,audio in requests:
        assert audio,text
        assert all(f.sample_rate==16000 for f in audio)
        assert any(np.max(np.abs(np.frombuffer(f.audio,dtype='<i2'))) > 500 for f in audio)


@pytest.mark.asyncio
async def test_real_streaming_service_sends_drafts_then_one_final_and_keeps_loop_alive():
    from native_streaming_stt import LocalStreamingSTTService
    from pipecat.frames.frames import VADUserStartedSpeakingFrame,VADUserStoppedSpeakingFrame,InputAudioRawFrame,TranscriptionFrame,InterimTranscriptionFrame
    from pipecat.tests.utils import run_test
    raw,rate=LocalSpeechSynthesizer({'engine':'kokoro','model':'82m','voice':'am_echo'}).synthesize('Can you hear me? Please show my notes in the application.')
    samples=soxr.resample(np.frombuffer(raw,dtype='<i2').astype(np.float32),rate,16000)*.1
    raw=samples.astype('<i2').tobytes()
    frames=[VADUserStartedSpeakingFrame()]+[InputAudioRawFrame(raw[offset:offset+6400],16000,1) for offset in range(0,len(raw),6400)]+[VADUserStoppedSpeakingFrame()]
    health=SpeechHealth();stt=LocalStreamingSTTService({'engine':'nemotron','model':'3.5-560ms','language':'auto'},health=health)
    ticks=[];done=False
    async def heartbeat():
        while not done:
            ticks.append(asyncio.get_running_loop().time());await asyncio.sleep(.025)
    task=asyncio.create_task(heartbeat())
    try:down,up=await asyncio.wait_for(run_test(stt,frames_to_send=frames,start_timeout=15),60)
    finally:done=True;await task
    finals=[f for f in down if isinstance(f,TranscriptionFrame)];drafts=[f for f in down if isinstance(f,InterimTranscriptionFrame)]
    assert len(finals)==1
    assert 'hear me' in finals[0].text.lower(),finals[0].text
    assert finals[0].finalized
    assert drafts and down.index(drafts[0])<down.index(finals[0])
    assert health.preview_ready and health.decode_ms>0
    assert max(b-a for a,b in zip(ticks,ticks[1:])) < .5


@pytest.mark.parametrize('code,text', [
    ('tr','Yedi kere sekiz ne yapar?'),
    ('en',"What's the meaning of life?"),
])
def test_reported_questions_preserve_numbers_and_intent(recognizer,code,text):
    synth=SupertonicSynthesizer({**SPEECH,'voice':'F5'})
    raw,rate=synth.synthesize(text,code)
    samples=soxr.resample(np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768,rate,16000)
    samples*=.05/max(float(np.max(np.abs(samples))),.001)
    raw=(samples*32767).astype('<i2').tobytes()
    recognizer.reset()
    for offset in range(0,len(raw),6400):recognizer.feed(raw[offset:offset+6400])
    final=recognizer.finish(raw).lower()
    if code=='tr':
        assert ('yedi' in final or '7' in final) and ('sekiz' in final or '8' in final),final
        assert 'kere' in final and 'ne yapar' in final and 'lira' not in final,final
    else:
        assert 'meaning of life' in final and 'pretty' not in final,final
