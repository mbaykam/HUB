"""Real VAD and local ASR preserve a pause inside one synthetic question."""
import asyncio,os,sys
from pathlib import Path
import numpy as np,soxr,pytest
pytestmark=pytest.mark.skipif(os.environ.get('HUB_VOICE_TEST_LOCAL_MODELS')!='1',reason='Explicit cached-model acceptance')
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packages/harness-overlay/voice'))


@pytest.mark.asyncio
async def test_thinking_pause_does_not_submit_two_questions():
    from voice_pipeline import voice_user_turn_params
    from native_streaming_stt import LocalStreamingSTTService
    from bilingual_tts import LocalSpeechSynthesizer
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.frames.frames import InputAudioRawFrame,TranscriptionFrame
    from pipecat.observers.base_observer import BaseObserver
    from pipecat.tests.utils import run_test,SleepFrame
    synth=LocalSpeechSynthesizer({'engine':'kokoro','model':'82m','voice':'am_echo'})
    parts=[]
    for text in ["What's",'the meaning of life?']:
        raw,rate=synth.synthesize(text)
        samples=soxr.resample(np.frombuffer(raw,dtype='<i2').astype(np.float32)/32768,rate,16000)
        audible=np.where(np.abs(samples)>.008)[0]
        samples=samples[max(0,audible[0]-320):min(len(samples),audible[-1]+321)]
        parts.append(samples)
    samples=np.concatenate([np.zeros(8000),parts[0],np.zeros(10400),parts[1],np.zeros(24000)])
    pcm=(np.clip(samples,-1,1)*32767).astype('<i2').tobytes()
    frames=[]
    for offset in range(0,len(pcm),640):
        frames.extend([InputAudioRawFrame(pcm[offset:offset+640],16000,1),SleepFrame(.02)])
    frames.append(SleepFrame(3))
    stt=LocalStreamingSTTService({'model':'3.5-560ms','language':'auto'})
    user,_=LLMContextAggregatorPair(LLMContext(),user_params=voice_user_turn_params())
    finals=[]
    class Observe(BaseObserver):
        async def on_push_frame(self,data):
            if data.source==stt and isinstance(data.frame,TranscriptionFrame):finals.append(data.frame.text)
    await asyncio.wait_for(run_test(Pipeline([stt,user]),frames_to_send=frames,observers=[Observe()],
        pipeline_params=PipelineParams(audio_in_sample_rate=16000,audio_out_sample_rate=16000),start_timeout=15),60)
    assert len(finals)==1,finals
    text=finals[0].lower().replace("what's",'what is')
    assert text.startswith('what') and 'meaning of life' in text,finals
