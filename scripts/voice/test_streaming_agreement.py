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
    ('What is seven times eight?', 'what is seven times eight', .99, 'en', False),
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


@pytest.mark.parametrize('language', ['auto', 'tr'])
def test_verified_math_question_cannot_be_replaced_by_a_turkish_candidate(monkeypatch, language):
    monkeypatch.setattr(streaming_asr, 'verify_turkish', lambda _: 'yedi kere sekiz lira para')
    stream = SimpleNamespace(accept_waveform=lambda *_: None, input_finished=lambda: None)
    recognizer = streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.runtime = SimpleNamespace(is_ready=lambda _: False, get_result=lambda _: 'Yedi kere sekiz ne yapar?')
    recognizer.stream = stream; recognizer.language = language; recognizer.result_language = None
    recognizer.audio = bytearray(b'\x01\x04' * 1000); recognizer.audio_bytes = len(recognizer.audio); recognizer._final_text = None
    recognizer.verifier = SimpleNamespace(_preview=None, _preview_language='tr', _preview_words='yedi kere sekiz ne yapar',
        _transcribe_audio=lambda _: ('Yedi kere sekiz ne yapar?', 'tr'))
    assert recognizer.finish() == 'Yedi kere sekiz ne yapar?'


def test_shared_turkish_words_do_not_confirm_a_changed_action(monkeypatch):
    monkeypatch.setattr(streaming_asr, 'verify_turkish', lambda _: 'beni duyuyor musun dosyayı sil')
    stream = SimpleNamespace(accept_waveform=lambda *_: None, input_finished=lambda: None)
    recognizer = streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.runtime = SimpleNamespace(is_ready=lambda _: False, get_result=lambda _: 'Beni duyuyor musun dosyayı aç')
    recognizer.stream = stream; recognizer.language = 'auto'; recognizer.result_language = None
    recognizer.audio = bytearray(b'\x01\x04' * 1000); recognizer.audio_bytes = len(recognizer.audio); recognizer._final_text = None
    recognizer.verifier = SimpleNamespace(_preview=None, _preview_language='tr', _preview_words='beni duyuyor musun dosyayı aç',
        _transcribe_audio=lambda _: ('Beni duyuyor musun dosyayı aç', 'tr'))
    assert recognizer.finish() == 'Beni duyuyor musun dosyayı aç'


def test_legacy_preview_cannot_overwrite_the_selected_multilingual_draft():
    recognizer = streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.stream = SimpleNamespace(accept_waveform=lambda *_: None)
    recognizer.runtime = SimpleNamespace(is_ready=lambda _: False, get_result=lambda _: "What's the meaning of life")
    recognizer.audio = bytearray(); recognizer.audio_bytes = 0
    recognizer.verifier = SimpleNamespace(_preview=SimpleNamespace(feed=lambda _: ('hmm pretty', 'en')))
    assert recognizer.feed(b'\x01\x04' * 3200) == "What's the meaning of life"
    assert recognizer.verifier._preview_words == 'hmm pretty', 'The candidate remains available for agreement checks only'


def test_endpoint_padding_does_not_skip_verification_of_a_short_question(monkeypatch):
    monkeypatch.setattr(streaming_asr, 'verify_turkish', lambda _: '')
    recognizer = streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.stream = SimpleNamespace(accept_waveform=lambda *_: None, input_finished=lambda: None)
    recognizer.runtime = SimpleNamespace(is_ready=lambda _: False, get_result=lambda _: 'Hmm. Pretty.')
    recognizer.language = 'auto'; recognizer.result_language = None; recognizer._final_text = None
    recognizer.audio = bytearray(b'\x01\x04' * (16000*5)); recognizer.audio_bytes = len(recognizer.audio)
    recognizer.verifier = SimpleNamespace(_preview=None, _preview_language=None, _preview_words='',
        _transcribe_audio=lambda _: ("What's the meaning of life?", 'en'))
    assert recognizer.finish() == "What's the meaning of life?"


def test_numeric_turkish_candidates_still_receive_final_verification(monkeypatch):
    monkeypatch.setattr(streaming_asr, 'verify_turkish', lambda _: 'yedi kere sekiz lira para')
    recognizer = streaming_asr.StreamingRecognizer.__new__(streaming_asr.StreamingRecognizer)
    recognizer.stream = SimpleNamespace(accept_waveform=lambda *_: None, input_finished=lambda: None)
    recognizer.runtime = SimpleNamespace(is_ready=lambda _: False, get_result=lambda _: 'Yedi kere sekiz lira para')
    recognizer.language = 'auto'; recognizer.result_language = None; recognizer._final_text = None
    recognizer.audio = bytearray(b'\x01\x04' * 1000); recognizer.audio_bytes = len(recognizer.audio)
    recognizer.verifier = SimpleNamespace(_preview=None, _preview_language=None, _preview_words='',
        _transcribe_audio=lambda _: ('Yedi kere sekiz ne yapar?', 'tr'))
    assert recognizer.finish() == 'Yedi kere sekiz ne yapar?'
