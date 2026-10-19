"""Bounded first spoken clauses using Pipecat's sentence aggregation semantics."""
import re
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator
from pipecat.utils.text.base_text_aggregator import Aggregation, AggregationType


class SpeechSegmentAggregator(SimpleTextAggregator):
    def __init__(self, *, first_words=10, later_words=20):
        super().__init__()
        self.first_words = first_words
        self.later_words = later_words
        self.emitted = False
        self._sentence_tokenizer_available = True

    async def aggregate(self, text):
        for char in text:
            if self._sentence_tokenizer_available:
                try:
                    async for sentence in super().aggregate(char):
                        self.emitted = True
                        yield sentence
                except (LookupError, OSError):
                    # The parent already buffered this character. Windows data
                    # redirection, missing Punkt data or a denied cache read must
                    # never discard a streamed word or abort a spoken clause.
                    # Keep that buffer, then use our bounded word cuts for this
                    # service's lifetime; do not disable NLTK's path protection.
                    self._sentence_tokenizer_available = False
            else:
                self._text += char
            # Wait for a word boundary; never split a streamed number or URL.
            pending = self._text
            limit = self.later_words if self.emitted else self.first_words
            if not pending or not char.isspace() or len(pending.split()) < limit:
                continue
            words = pending.split()
            if any(re.search(r'(?:\d|https?://|www\.|[£$€])', word) for word in words[-2:]):
                continue
            self._text = ''
            self._needs_lookahead = False
            self.emitted = True
            yield Aggregation(text=pending.strip(), type=AggregationType.SENTENCE)

    async def reset(self):
        await super().reset()
        self.emitted = False

    async def handle_interruption(self):
        await super().handle_interruption()
        self.emitted = False
