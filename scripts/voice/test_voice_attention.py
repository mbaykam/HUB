"""Local attention and real Pipecat gate; synthetic words, no devices/providers."""
import sys
from pathlib import Path
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from voice_attention import VoiceAttention, AttentionInputGate, attention_settings
from speech_health import SpeechHealth


def test_all_day_background_costs_no_model_turns_and_has_no_unbounded_context():
    clock=[0.0]
    state=VoiceAttention({'idleSeconds':180,'wakePhrases':['Vera'],'contextSeconds':60},clock=lambda:clock[0])
    clock[0]=181;state.tick();assert state.mode=='background'
    for _ in range(30000):
        clock[0]+=1
        assert state.accept('Someone else talking nearby. '*20)==(False,False)
    assert len(state.ring)<=24
    assert sum(len(t) for _,t in state.ring)<=1024
    assert all(at>=clock[0]-60 for at,_ in state.ring)
    assert state.accept('Vera, what was that about?')==(True,False)
    assert 0<len(state.take_context())<=1024
    assert state.take_context()==''
    assert state.mode=='active'


@pytest.mark.parametrize('text', ['a miracle', 'the mirror is broken', 'I spoke to Vera yesterday', 'Samira', 'Veras', 'veranda', 'very good'])
def test_name_inside_other_words_or_other_peoples_sentences_does_not_wake(text):
    state=VoiceAttention();state.set_mode('background')
    assert state.accept(text)==(False,False)
    assert state.take_context()==''
    assert state.mode=='background'


@pytest.mark.parametrize('text', ['Vera', 'VERA!', 'Hey Vera', 'Selam Vera.'])
def test_wake_only_resumes_locally_without_a_model_request(text):
    state=VoiceAttention();state.set_mode('background')
    assert state.accept(text)==(False,True)
    assert state.accept('Can you help me?')==(True,False)


@pytest.mark.parametrize('text',['Verabana yardım edermisin.','Verab bana yardım eder mis?','Vera, bana yardım eder misin?','Vera can you help me?'])
def test_cached_local_recognizer_name_to_pronoun_boundary_does_not_drop_the_wake_request(text):
    state=VoiceAttention();state.set_mode('background');assert state.accept(text)==(True,False)


def test_nearby_speech_is_kept_without_trying_to_identify_the_speaker():
    state=VoiceAttention();state.set_mode('background')
    assert state.accept('A nearby person is explaining the project.')==(False,False)
    assert state.accept('Vera, what did we just discuss?')==(True,False)
    assert state.take_context()=='A nearby person is explaining the project.'


@pytest.mark.parametrize('phrase,text',[('Hey assistant','Hey assistant, help me.'),('Véra','Merhaba Vera, yardım et.'),('Hello Vera','Hello Vera')])
def test_custom_multiword_or_accented_wake_phrases_are_usable(phrase,text):
    state=VoiceAttention({'idleSeconds':180,'wakePhrases':[phrase],'contextSeconds':60});state.set_mode('background')
    accepted,wake_only=state.accept(text);assert accepted or wake_only


def test_idle_is_reset_by_real_replies_and_explicit_resume_not_ambient_noise():
    clock=[0.0];state=VoiceAttention(clock=lambda:clock[0])
    clock[0]=200;state.tick(busy=True);assert state.mode=='active'
    clock[0]=379;state.tick();assert state.mode=='active'
    clock[0]=381;state.tick();assert state.mode=='background'
    state.set_mode('active');assert state.accept('Hello')==(True,False)
    disabled=VoiceAttention({'idleSeconds':0,'wakePhrases':['Jarvis'],'contextSeconds':0},clock=lambda:clock[0])
    clock[0]=90000;disabled.tick();assert disabled.mode=='active'


def test_optional_context_expires_and_manual_transition_discards_it():
    clock=[0.0];state=VoiceAttention({'idleSeconds':180,'wakePhrases':['Vera'],'contextSeconds':30},clock=lambda:clock[0])
    state.set_mode('background');state.accept('Private recent context.')
    clock[0]=31;state.accept('Vera');assert not state.take_context()
    state.set_mode('background');state.accept('Another private context.');state.close()
    assert not state.ring and not state.pending_context
    assert 'Private' not in str(state.snapshot())
    state.set_mode('background');state.accept('A topic before the wake.');state.accept('Vera');clock[0]+=31
    assert not state.take_context(),'A name-only wake cannot keep stale context until a much later question'


@pytest.mark.asyncio
async def test_gate_blocks_transcripts_audio_and_vad_until_same_utterance_wake():
    from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame
    from pipecat.tests.utils import run_test
    state=VoiceAttention();state.set_mode('background');health=SpeechHealth();health.attention=state
    heard=[]
    class Gate(AttentionInputGate):
        async def push_frame(self,frame,direction=None):
            if isinstance(frame,(TranscriptionFrame,InterimTranscriptionFrame,VADUserStartedSpeakingFrame,VADUserStoppedSpeakingFrame)):heard.append(frame)
            if direction is None:await super().push_frame(frame)
            else:await super().push_frame(frame,direction)
    frames=[VADUserStartedSpeakingFrame(),InterimTranscriptionFrame('People talking','',''),TranscriptionFrame('Order some food','',''),VADUserStoppedSpeakingFrame(),TranscriptionFrame('Vera, find my note','',''),TranscriptionFrame('Please show it','','')]
    await run_test(Gate(state,health),frames_to_send=frames)
    assert [f.text for f in heard]==['Vera, find my note','Please show it']


@pytest.mark.asyncio
async def test_background_defense_rejects_even_a_direct_llm_context_without_model_calls():
    from hub_native_llm import HubNativeLLMService
    from pipecat.frames.frames import LLMContextFrame
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.tests.utils import run_test
    class Bridge:
        async def heartbeat(self):pass
        async def close(self):pass
        async def turn(self,*args,**kwargs):raise AssertionError('No ambient model requests');yield
    state=VoiceAttention();state.set_mode('background');health=SpeechHealth();health.attention=state
    llm=HubNativeLLMService(Bridge(),health=health)
    await run_test(llm,frames_to_send=[LLMContextFrame(LLMContext([{'role':'user','content':'Random background speech'}]))])
    assert not llm._request_active


@pytest.mark.asyncio
async def test_wake_context_is_metadata_once_and_never_an_extra_model_turn():
    from hub_native_llm import HubNativeLLMService
    from pipecat.frames.frames import LLMContextFrame
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.tests.utils import run_test, SleepFrame
    calls=[]
    class Bridge:
        async def heartbeat(self):pass
        async def close(self):pass
        async def turn(self,utterance,text,**kwargs):
            calls.append((text,kwargs));yield {'type':'text','text':'A brief answer.'};yield {'type':'end','status':'completed'}
    state=VoiceAttention();state.set_mode('background');state.accept('Someone nearby discussed a project.');state.accept('Vera, what was that about?')
    health=SpeechHealth();health.attention=state
    await run_test(HubNativeLLMService(Bridge(),health=health),frames_to_send=[LLMContextFrame(LLMContext([{'role':'user','content':'Vera, what was that about?'}])),SleepFrame(sleep=.05),LLMContextFrame(LLMContext([{'role':'user','content':'Thank you.'}]))])
    assert calls==[('Vera, what was that about?',{'background_context':'Someone nearby discussed a project.'}),('Thank you.',{})]


@pytest.mark.parametrize('value', [{'idleSeconds':True,'wakePhrases':['Vera'],'contextSeconds':0},{'idleSeconds':180,'wakePhrases':['*'],'contextSeconds':0},{'idleSeconds':180,'wakePhrases':['---'],'contextSeconds':0},{'idleSeconds':180,'wakePhrases':['Vera'],'contextSeconds':999999}])
def test_invalid_settings_cannot_enable_unbounded_listening(value):
    with pytest.raises(ValueError):attention_settings(value)


@pytest.mark.asyncio
async def test_rtvi_cannot_publish_the_stt_frame_before_the_attention_gate():
    from types import SimpleNamespace
    from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIObserverParams
    from pipecat.frames.frames import TranscriptionFrame
    from pipecat.processors.frame_processor import FrameDirection
    stt,echo_gate,attention_gate=object(),object(),object()
    observer=RTVIObserver(params=RTVIObserverParams(ignored_sources=[stt,echo_gate]));sent=[]
    async def send(message):sent.append(message)
    observer.send_rtvi_message=send
    frame=TranscriptionFrame('Vera, tell me the result','','')
    for source in [stt,echo_gate]:
        await observer.on_push_frame(SimpleNamespace(source=source,frame=frame,direction=FrameDirection.DOWNSTREAM,timestamp=0))
    assert not sent
    await observer.on_push_frame(SimpleNamespace(source=attention_gate,frame=frame,direction=FrameDirection.DOWNSTREAM,timestamp=0))
    assert len(sent)==1
    assert sent[0].data.text==frame.text
