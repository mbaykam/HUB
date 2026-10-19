"""Deterministic decoder confidence and final-language transport regressions.
No model downloads, microphone, phone or model API calls.
"""
from pathlib import Path
from types import SimpleNamespace
import sys
import numpy as np
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packages/harness-overlay/voice'))
from whisper_auto import AutomaticWhisperSTTService


def decode(responses):
    calls=[]
    def transcribe(samples,**options):
        calls.append(options)
        return responses[len(calls)-1]
    service=SimpleNamespace(_settings=SimpleNamespace(language=None),_beam_size=3,
        _allowed_languages=('en','tr'),_preview_words='',_preview_language=None,
        _model=SimpleNamespace(transcribe=transcribe))
    raw=(np.sin(np.arange(16000)/16)*3000).astype('<i2').tobytes()
    result=AutomaticWhisperSTTService._transcribe_audio(service,raw)
    return result,calls


def response(language,text,probabilities=(),logprob=-.2,silence=.01):
    return iter([SimpleNamespace(text=text,avg_logprob=logprob,no_speech_prob=silence)]),SimpleNamespace(language=language,all_language_probs=probabilities)


def test_low_probability_foreign_audio_is_not_forced_into_a_command():
    result,calls=decode([response('de','foreign',[('de',.95),('en',.03),('tr',.02)])])
    assert result==('',None);assert len(calls)==1


def test_ambiguous_detection_can_select_the_allowed_language_from_actual_audio():
    result,calls=decode([response('de','discard',[('de',.4),('tr',.35),('en',.25)]),response('tr','Türkçe ve English konuşuyorum.')])
    assert result==('Türkçe ve English konuşuyorum.','tr')
    assert [call['language'] for call in calls]==[None,'tr']
    assert all(call['condition_on_previous_text'] is False for call in calls)


@pytest.mark.parametrize('logprob,silence',[(-1.4,.01),(-.2,.9)])
def test_uncertain_decoder_segments_are_dropped(logprob,silence):
    result,_=decode([response('en','Thank you.',logprob=logprob,silence=silence)])
    assert not result[0]


@pytest.mark.parametrize('language,text',[('en','Hello.'),('tr','Yedi kere sekiz ne yapar?')])
def test_clear_allowed_language_is_kept_verbatim(language,text):
    assert decode([response(language,text)])[0]==(text,language)


@pytest.mark.asyncio
async def test_only_final_not_interim_transcriptions_set_the_reply_language():
    from pipecat.frames.frames import TranscriptionFrame,InterimTranscriptionFrame
    from pipecat.transcriptions.language import Language
    from pipecat.tests.utils import run_test
    from speech_health import SpeechHealth,TranscriptionHealthProbe
    state=SpeechHealth()
    await run_test(TranscriptionHealthProbe(state),frames_to_send=[
        TranscriptionFrame('Hello.','fixture','now',Language.EN),
        InterimTranscriptionFrame('Merhaba','fixture','now',Language.TR)])
    assert state.transcriptions==1
    assert state.last_transcription_language=='en';assert state.last_transcription_text=='Hello.'
