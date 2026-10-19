"""Early useful phrases preserve words/numbers and clear interrupted buffers."""
import sys
from pathlib import Path
import pytest
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from speech_segments import SpeechSegmentAggregator
from speech_health import SpeechHealth


@pytest.mark.asyncio
async def test_first_clause_can_be_spoken_before_the_whole_reply_arrives():
    aggregator = SpeechSegmentAggregator(first_words=6, later_words=10)
    parts = [part.text async for part in aggregator.aggregate('Yes I can hear you clearly ')]
    assert parts == ['Yes I can hear you clearly']
    assert aggregator.text.text == ''
    parts += [part.text async for part in aggregator.aggregate('and we can continue in Turkish or English whenever you like.')]
    tail = await aggregator.flush()
    if tail:
        parts.append(tail.text)
    assert ' '.join(parts) == 'Yes I can hear you clearly and we can continue in Turkish or English whenever you like.'


@pytest.mark.asyncio
async def test_streamed_decimal_and_url_are_not_cut_and_interrupt_discards_old_words():
    aggregator = SpeechSegmentAggregator(first_words=5)
    assert not [part async for part in aggregator.aggregate('The current price is 29.')]
    assert not [part async for part in aggregator.aggregate('95 dollars ')]
    parts = [part.text async for part in aggregator.aggregate('right now and the source is https://example.com/quote.')]
    tail = await aggregator.flush()
    if tail:
        parts.append(tail.text)
    joined = ' '.join(parts)
    assert '29.95' in joined and 'https://example.com/quote.' in joined
    await _buffer(aggregator, 'Old unfinished words')
    await aggregator.handle_interruption()
    assert await aggregator.flush() is None
    parts = [part.text async for part in aggregator.aggregate('Merhaba seni gayet iyi duyuyorum ')]
    assert parts and parts[0].startswith('Merhaba')


async def _buffer(aggregator, text):
    return [part async for part in aggregator.aggregate(text)]


@pytest.mark.asyncio
@pytest.mark.parametrize('failure', [PermissionError, LookupError])
async def test_unavailable_sentence_tokenizer_preserves_every_streamed_word(monkeypatch, failure):
    import pipecat.utils.text.simple_text_aggregator as parent
    calls=[]
    def unavailable(text):
        calls.append(text)
        raise failure('Unavailable tokenizer fixture')
    monkeypatch.setattr(parent, 'match_endofsentence', unavailable)
    text='Yes. The price is 29.95 dollars today. Türkçe konuşmaya devam edebiliriz. Read https://example.com/quote for the source.'
    aggregator=SpeechSegmentAggregator(first_words=6,later_words=10)
    parts=[]
    for offset in range(0,len(text),3):
        parts.extend([p.text async for p in aggregator.aggregate(text[offset:offset+3])])
    tail=await aggregator.flush()
    if tail:parts.append(tail.text)
    assert ''.join(''.join(parts).split()) == ''.join(text.split())
    assert len(calls)==1, 'Do not keep retrying a failed filesystem read during speech'
    assert '29.95' in ' '.join(parts) and 'https://example.com/quote' in ' '.join(parts)


def test_turn_timing_contains_only_relative_durations_and_resets():
    health = SpeechHealth()
    health.last_input_sound = 1.0
    health.begin_turn()
    health.model_start_at = 2.0
    health.first_text_at = 3.0
    health.first_pcm_at = 3.5
    health.first_playback_at = 3.6
    assert health.snapshot()['timing']['modelFirstTextMs'] == 1000
    assert health.snapshot()['timing']['firstPcmAfterSoundMs'] == 2500
    health.begin_turn()
    assert health.snapshot()['timing']['firstPcmAfterSoundMs'] is None
