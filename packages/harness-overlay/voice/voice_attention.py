"""Local call attention. Ambient words never become model turns or saved chat.

Uses the already running local final STT, not another language model. The optional
short context ring is memory-only, bounded by time AND characters, and drained
once on wake. It is not a recording, transcript archive, or user instruction.
"""
import re
import time
import unicodedata
from collections import deque

from pipecat.frames.frames import (InputAudioRawFrame, TranscriptionFrame,
    InterimTranscriptionFrame, VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.processors.frame_processor import FrameProcessor, FrameDirection

DEFAULT_ATTENTION = {"idleSeconds": 180, "wakePhrases": ["Vera"], "contextSeconds": 60}


def attention_settings(value=None):
    value = dict(DEFAULT_ATTENTION if value is None else value)
    if (set(value) != set(DEFAULT_ATTENTION)
        or type(value['idleSeconds']) is not int or value['idleSeconds'] not in (0, 60, 120, 180, 300, 600)
        or type(value['contextSeconds']) is not int or value['contextSeconds'] not in (0, 30, 60, 120)
        or not isinstance(value['wakePhrases'], list) or not 1 <= len(value['wakePhrases']) <= 3
        or any(not isinstance(p, str) or not 1 <= len(p.strip()) <= 40 or len(p.split()) > 4 or not any(c.isalpha() for c in p)
               or not all(c.isalpha() or c in " -'" for c in p) for p in value['wakePhrases'])):
        raise ValueError('Invalid background listening settings')
    return {**value, 'wakePhrases': [p.strip() for p in value['wakePhrases']]}


def normalized_words(text):
    text = ''.join(c for c in unicodedata.normalize('NFKD', text.casefold().replace('ı', 'i'))
                   if not unicodedata.combining(c))
    return re.findall(r'\w+', text)


class VoiceAttention:
    def __init__(self, settings=None, *, clock=time.monotonic):
        self.settings = attention_settings(settings)
        self.clock = clock
        self.mode = 'active'
        self.last_interaction = clock()
        self.pending_context = ''
        self.context_at = 0
        self.ring = deque(maxlen=24)
        self.wakes = 0
        self.ignored = 0

    def set_mode(self, mode):
        if mode not in ('active', 'background'):
            raise ValueError('Invalid listening mode')
        self.mode = mode
        self.last_interaction = self.clock()
        self.ring.clear()
        self.pending_context = ''
        self.context_at = 0

    def tick(self, busy=False):
        if busy:
            self.last_interaction = self.clock()
        elif (self.mode == 'active' and self.settings['idleSeconds']
              and self.clock() - self.last_interaction >= self.settings['idleSeconds']):
            self.set_mode('background')
        self._prune()

    def _prune(self):
        cutoff = self.clock() - self.settings['contextSeconds']
        while self.ring and (not self.settings['contextSeconds'] or self.ring[0][0] < cutoff
                             or sum(len(text) for _, text in self.ring) > 1024):
            self.ring.popleft()

    def accept(self, text):
        """Return (accepted, wake_only). Preserve actual STT words on admission."""
        if self.mode == 'active':
            self.last_interaction = self.clock()
            return True, False
        words = normalized_words(text)
        for phrase in self.settings['wakePhrases']:
            wake = normalized_words(phrase)
            # Exact whole-word prefix, optionally a direct greeting. A name in
            # someone else's sentence or 'miracle' must not wake the assistant.
            offset = 1 if words[:1] in (['hey'], ['hi'], ['hello'], ['merhaba'], ['selam']) and words[:1]!=wake[:1] else 0
            candidate = words[offset:]
            # Some local Turkish finalizers join a vocative name to the next
            # pronoun (observed: 'Mirabana yardım edermisin'). Restore ONLY that
            # name/request boundary, never fuzzy-match arbitrary name substrings.
            if len(wake)==1 and candidate and any(candidate[0]==wake[0]+p for p in ('bana','beni','benim','bizim','bize','sana','sen','can','could','please')):
                candidate=[wake[0],candidate[0][len(wake[0]):],*candidate[1:]]
            # A short duplicated boundary also occurs in actual final ASR:
            # 'Mirab bana ...'. Require the following request word to supply
            # that exact overlap, rather than accepting arbitrary name suffixes.
            if len(wake)==1 and len(candidate)>1 and candidate[1] in ('bana','beni','benim','bizim','bize','sana','sen','can','could','please'):
                overlap=candidate[0][len(wake[0]):] if candidate[0].startswith(wake[0]) else ''
                if overlap and candidate[1].startswith(overlap):candidate=[wake[0],*candidate[1:]]
            if candidate[:len(wake)] == wake:
                self._prune()
                self.pending_context = '\n'.join(text for _, text in self.ring)[-1024:]
                self.context_at = self.clock()
                self.ring.clear()
                self.mode = 'active'
                self.last_interaction = self.clock()
                self.wakes += 1
                return len(candidate) > len(wake), len(candidate) == len(wake)
        self.ignored += 1
        if self.settings['contextSeconds'] and text.strip():
            self.ring.append((self.clock(), text.strip()[:512]))
            self._prune()
        return False, False

    def take_context(self):
        value, self.pending_context = self.pending_context, ''
        return value if self.settings['contextSeconds'] and self.clock()-self.context_at<=self.settings['contextSeconds'] else ''

    def snapshot(self):
        self.tick()
        return {'mode': self.mode, 'wakePhrases': self.settings['wakePhrases'],
                'idleSeconds': self.settings['idleSeconds'], 'contextSeconds': self.settings['contextSeconds'],
                'wakeCount': self.wakes, 'ignoredUtterances': self.ignored}

    def close(self):
        self.ring.clear()
        self.pending_context = ''


class AttentionInputGate(FrameProcessor):
    def __init__(self, attention, health):
        super().__init__()
        self.attention, self.health = attention, health

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction != FrameDirection.DOWNSTREAM:
            await self.push_frame(frame, direction)
            return
        state, health = self.attention, self.health
        gate = health.playback_gate
        state.tick(health.model_active or health.bot_speaking or health.synthesizing
                   or health.user_speaking or health.stage=='transcribing'
                   or bool(gate and gate.blocked))
        if isinstance(frame, TranscriptionFrame) and not isinstance(frame, InterimTranscriptionFrame):
            accepted, wake_only = state.accept(frame.text)
            if wake_only:
                from pipecat.frames.frames import TTSSpeakFrame
                language = getattr(frame.language, 'value', frame.language)
                await self.push_frame(TTSSpeakFrame('Dinliyorum.' if str(language).startswith('tr') else "I'm listening."))
            if not accepted:
                health.partial_text = ''
                health.user_speaking = False
                return
        elif state.mode == 'background' and isinstance(frame, (InputAudioRawFrame, InterimTranscriptionFrame,
                     VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)):
            health.partial_text = ''
            return
        await self.push_frame(frame, direction)

    async def cleanup(self):
        self.attention.close()
        await super().cleanup()
