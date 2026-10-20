"""Protocol/attention regression fixtures. No provider or real microphone."""
import asyncio
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packages/harness-overlay/voice'))
from soniox_stt import SonioxWakeSTTService, soniox_config
from voice_attention import VoiceAttention
from speech_health import SpeechHealth
from playback_guard import PlaybackGate
from pipecat.frames.frames import TranscriptionFrame, InterimTranscriptionFrame, ErrorFrame, TTSSpeakFrame, STTMuteFrame, InputAudioRawFrame, LLMContextFrame
from pipecat.processors.frame_processor import FrameDirection
from wake_word import LocalWakeDetector, wake_prefix
from types import SimpleNamespace


class WakeTests(unittest.TestCase):
    def test_only_a_whole_phrase_at_the_utterance_start_can_wake(self):
        for text in ('Vera, help me.','Hey Vera','Merhaba Vera, yardım et.'):
            self.assertEqual(wake_prefix(text,['Vera']),'Vera')
        for text in ('I spoke to Vera yesterday.','Very good.','veranda','Veraish','Thank you.'):
            self.assertIsNone(wake_prefix(text,['Vera']))
        self.assertEqual(wake_prefix('Hello new assistant, help.',['new assistant']),'new assistant')

    def test_silence_does_not_decode_and_speech_buffers_are_bounded(self):
        import numpy as np
        calls=[];voiced=[False]
        class Model:
            def transcribe(self,audio,**kwargs):
                calls.append(len(audio));self.kwargs=kwargs
                return iter([SimpleNamespace(text='Nearby chatter.',no_speech_prob=.01,avg_logprob=-.2)]),None
        model=Model();wake=LocalWakeDetector(['Vera'],model=model,vad=SimpleNamespace(voice_confidence=lambda _:float(voiced[0])))
        for _ in range(50):self.assertIsNone(wake.feed(bytes(3200)))
        self.assertEqual(calls,[])
        voiced[0]=True;audio=(np.ones(1600,dtype='<i2')*2000).tobytes()
        for _ in range(200):self.assertIsNone(wake.feed(audio))
        self.assertLessEqual(len(calls),5);self.assertLessEqual(max(calls),49000)
        self.assertTrue(wake.exhausted);self.assertFalse(wake.speech)
        self.assertEqual(model.kwargs['temperature'],0.0);self.assertEqual(model.kwargs['max_new_tokens'],24)
        voiced[0]=False
        for _ in range(10):wake.feed(bytes(3200))
        self.assertFalse(wake.exhausted);self.assertFalse(wake.speech)
        wake.reset();self.assertFalse(wake.pending);self.assertFalse(wake.lookback)


class Socket:
    def __init__(self):
        self.queue=asyncio.Queue()
        self.sent=[]
        self.closed=False
    def __aiter__(self): return self
    async def __anext__(self):
        item=await self.queue.get()
        if item is None: raise StopAsyncIteration
        return json.dumps(item)
    async def send(self,value):
        if self.closed: raise ConnectionError()
        self.sent.append(value)
    async def close(self):
        self.closed=True
        self.queue.put_nowait(None)


class Wake:
    def __init__(self): self.hit=False;self.feeds=0
    def reset(self): pass
    def feed(self,audio):
        self.feeds+=1
        result='Vera' if self.hit else None
        self.hit=False
        return result


class HybridTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sockets=[];self.headers=[];self.frames=[];self.proposals=[]
        self.attention=VoiceAttention({'idleSeconds':120,'wakePhrases':['Vera'],'contextSeconds':60})
        self.health=SpeechHealth();self.health.attention=self.attention
        self.gate=PlaybackGate();self.wake=Wake()
        async def connect(url,**kwargs):
            self.headers.append(kwargs['additional_headers']);socket=Socket();self.sockets.append(socket);return socket
        self.stt=SonioxWakeSTTService({'language':'en-tr'},api_key='fixture-private-key-123',attention=self.attention,
            health=self.health,playback_gate=self.gate,connector=connect,wake=self.wake)
        async def push(frame,*args): self.frames.append(frame)
        async def broadcast(frame,*args): self.proposals.append(frame)
        self.stt.push_frame=push;self.stt.broadcast_frame=broadcast
        self.audio=b'\x01\x00'*1600
    async def asyncTearDown(self): await self.stt._close()
    async def feed(self,audio=None):
        async for _ in self.stt.run_stt(self.audio if audio is None else audio): pass
    async def settle(self):
        for _ in range(6): await asyncio.sleep(0)
    def finals(self):
        return [f for f in self.frames if isinstance(f,TranscriptionFrame) and not isinstance(f,InterimTranscriptionFrame)]
    async def emit(self,tokens):
        await self.sockets[-1].queue.put({'tokens':tokens});await self.settle()

    async def test_background_does_not_open_or_keep_a_paid_stream(self):
        await self.stt.set_attention('background')
        for _ in range(50): await self.feed()
        self.assertEqual(self.sockets,[])
        self.assertEqual(self.wake.feeds,50)
        self.assertLessEqual(len(self.stt.preroll),96000)
        self.assertEqual(self.attention.ring.__len__(),0)
        self.assertEqual(self.frames,[])

    async def test_manual_background_closes_before_return_and_stale_results_cannot_act(self):
        await self.feed();old=self.sockets[0]
        self.assertEqual(json.loads(old.sent[0])['language_hints'],['en','tr'])
        await self.stt.set_attention('background')
        self.assertTrue(old.closed)
        seconds=self.health.cloud_recognition['seconds']
        old.queue.put_nowait({'tokens':[{'text':'stale command','is_final':True},{'text':'<end>','is_final':True}]})
        for _ in range(3): await self.feed()
        self.assertEqual(len(self.sockets),1)
        self.assertEqual(self.finals(),[])
        self.assertFalse(self.health.cloud_recognition['connected'])
        self.assertEqual(self.health.cloud_recognition['seconds'],seconds)
        await self.stt.set_attention('active');await self.feed()
        self.assertEqual(len(self.sockets),2)
        self.assertEqual(self.sockets[1].sent[1],self.audio)

    async def test_keyword_retains_same_breath_audio_once_and_only_final_endpoint_admits(self):
        await self.stt.set_attention('background')
        await self.feed();self.wake.hit=True;await self.feed()
        self.assertEqual(self.attention.mode,'active');self.assertEqual(self.attention.wakes,1)
        self.assertEqual(self.sockets[0].sent[1],self.audio*2)
        await self.emit([{'text':'Vera please','is_final':False}])
        self.assertEqual(self.finals(),[])
        await self.emit([{'text':'Vera please search','is_final':True,'language':'en'},{'text':'<end>','is_final':True}])
        self.assertEqual([f.text for f in self.finals()],['Vera please search'])
        self.assertTrue(self.finals()[0].finalized)
        self.assertEqual(len(self.proposals),2)

    async def test_wake_only_acknowledges_without_an_llm_turn(self):
        await self.stt.set_attention('background');self.wake.hit=True;await self.feed()
        await self.emit([{'text':'Vera','is_final':True,'language':'tr'},{'text':'<end>','is_final':True}])
        self.assertEqual(self.finals(),[])
        self.assertEqual([f.text for f in self.frames if isinstance(f,TTSSpeakFrame)],['Dinliyorum.'])

    async def test_idle_transition_closes_stream_without_waiting_for_more_audio(self):
        await self.feed()
        self.attention.last_interaction-=121
        await self.stt._sync_mode()
        self.assertEqual(self.attention.mode,'background');self.assertTrue(self.sockets[0].closed)

    async def test_quota_error_closes_and_does_not_reconnect_on_every_audio_frame(self):
        await self.feed()
        self.sockets[-1].queue.put_nowait({'error_code':402,'error_type':'organization_balance_exhausted','error_message':'private provider details'})
        await self.settle()
        self.assertEqual(self.attention.mode,'background');self.assertTrue(self.sockets[0].closed)
        for _ in range(5): await self.feed()
        self.assertEqual(len(self.sockets),1)
        self.assertTrue(any(isinstance(f,ErrorFrame) for f in self.frames))
        self.assertNotIn('private provider details',str(self.frames))

    async def test_echo_cannot_trigger_keyword_or_cloud_transcript(self):
        await self.stt.set_attention('background');self.gate.speaking=True;self.wake.hit=True
        await self.feed();self.assertEqual(self.wake.feeds,0);self.assertEqual(self.sockets,[])
        self.gate.speaking=False;self.wake.hit=False;await self.stt.set_attention('active');await self.feed()
        self.gate.speaking=True
        await self.emit([{'text':'echo thank you','is_final':True},{'text':'<end>','is_final':True}])
        self.assertEqual(self.finals(),[])

    async def test_mute_closes_and_hangup_clears_credentials(self):
        await self.feed()
        await self.stt.process_frame(STTMuteFrame(mute=True),FrameDirection.DOWNSTREAM)
        self.assertTrue(self.sockets[0].closed)
        await self.feed();self.assertEqual(len(self.sockets),1)
        await self.stt._close();self.assertEqual(self.stt._api_key,'');self.assertFalse(self.stt.preroll)

    async def test_mixed_language_uses_dominant_utterance_language(self):
        await self.feed()
        await self.emit([{'text':'Please check the current price of ','is_final':True,'language':'en'},
            {'text':'İstanbul','is_final':True,'language':'tr'},{'text':'<end>','is_final':True}])
        self.assertEqual(self.health.recognition_language,'en')

    async def test_connection_loss_after_partial_closes_the_proposed_turn(self):
        await self.feed();await self.emit([{'text':'unfinished','is_final':False}])
        self.assertTrue(self.stt.turn_open)
        self.sockets[-1].queue.put_nowait(None);await self.settle()
        self.assertFalse(self.stt.turn_open)
        self.assertEqual(len(self.proposals),2)
        self.assertEqual(self.finals(),[])

    async def test_long_foreground_stream_rolls_between_turns_without_replaying_audio(self):
        await self.feed();old=self.sockets[0]
        self.stt.cloud_started-=17401
        await self.feed()
        self.assertTrue(old.closed);self.assertEqual(len(self.sockets),2)
        self.assertEqual(self.sockets[1].sent[1:],[self.audio])
        self.assertEqual(self.attention.mode,'active');self.assertEqual(self.finals(),[])


class PipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_pipecat_aggregator_admits_one_complete_semantic_turn(self):
        from pipecat.tests.utils import run_test, SleepFrame
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.processors.aggregators.llm_context import LLMContext
        from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
        from voice_pipeline import voice_user_turn_params
        from voice_attention import AttentionInputGate
        state=VoiceAttention();health=SpeechHealth();health.attention=state;gate=PlaybackGate();health.playback_gate=gate
        class ReplySocket(Socket):
            async def send(self,value):
                await super().send(value)
                if isinstance(value,bytes):
                    self.queue.put_nowait({'tokens':[{'text':'Can you hear','is_final':False}]})
                    self.queue.put_nowait({'tokens':[{'text':'Can you hear me?','is_final':True,'language':'en'},{'text':'<end>','is_final':True}]})
        async def connect(*args,**kwargs):return ReplySocket()
        stt=SonioxWakeSTTService({'language':'en-tr'},api_key='fixture-private-key-123',attention=state,
            health=health,playback_gate=gate,connector=connect,wake=Wake())
        context=LLMContext();user,assistant=LLMContextAggregatorPair(context,user_params=voice_user_turn_params(True))
        down,_=await asyncio.wait_for(run_test(Pipeline([stt,AttentionInputGate(state,health),user]),
            frames_to_send=[InputAudioRawFrame(b'\x01\x00'*1600,16000,1),SleepFrame(sleep=.15)],start_timeout=10),15)
        contexts=[f for f in down if isinstance(f,LLMContextFrame)]
        self.assertEqual(len(contexts),1)
        self.assertEqual(context.get_messages(),[{'role':'user','content':'Can you hear me?'}])
        self.assertTrue(stt.closed);self.assertIsNone(stt.socket);self.assertEqual(stt._api_key,'')


if __name__=='__main__': unittest.main()

