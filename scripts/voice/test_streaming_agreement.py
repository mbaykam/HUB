"""Whole-audio agreement shortens English finalization without trusting drafts."""
from pathlib import Path
import sys
from types import SimpleNamespace
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
import streaming_asr


@pytest.mark.parametrize('native,confirmed,confidence,preview_language,fast', [
    ('Can you hear me?', 'can you hear me', .95, 'en', True),
    ('Can you hear me?', 'can you help me', .95, 'en', False),
    ('Can you hear me?', 'can you hear me', .6, 'en', False),
    ('Can you hear me?', 'can you hear me', .95, 'tr', False),
    ('Hello.', 'hello', .99, 'en', False),
    ('The price is 29 dollars', 'the price is 29 dollars', .99, 'en', False),
    ('Merhaba beni duyuyor musun', 'merhaba beni duyuyor musun', .99, 'en', False),
])
def test_uncertain_short_speech_and_changed_values_retain_verification(monkeypatch,native,confirmed,confidence,preview_language,fast):
    monkeypatch.setattr(streaming_asr,'verify_turkish',lambda _: '')
    finalizations=[];verified=[]
    stream=SimpleNamespace(accept_waveform=lambda *_:None,input_finished=lambda:finalizations.append(True))
    preview=SimpleNamespace(finish=lambda _: (confirmed,confidence))
    def verify(audio):
        verified.append(audio)
        return 'Verified fallback','en'
    recognizer=streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.runtime=SimpleNamespace(is_ready=lambda _:False,get_result=lambda _:native)
    recognizer.stream=stream;recognizer.language='auto';recognizer.result_language=None
    recognizer.audio=bytearray(b'\x01\x04'*1000);recognizer.audio_bytes=len(recognizer.audio);recognizer._final_text=None
    recognizer.verifier=SimpleNamespace(_preview=preview,_preview_language=preview_language,
        _preview_words='This unconfirmed draft must never be submitted',_transcribe_audio=verify)
    result=recognizer.finish()
    assert result == (native if fast else 'Verified fallback')
    assert bool(verified) == (not fast)
    assert len(finalizations)==1
    assert recognizer.result_language=='en'
