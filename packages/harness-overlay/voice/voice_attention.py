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
# After the assistant speaks up on its own (a finished background task), it
# listens this long without needing the wake phrase, so the user can just answer.
REPLY_WINDOW_SECONDS = 30
# Whole requests that send the call back to waiting for the wake phrase.
SLEEP_PHRASES = ("that's all", "that is all", "that's it", "that's it for now", "that's all for now", "stop listening",
                 "you can stop listening", "go to sleep", "bu kadar", "şimdilik bu kadar", "simdilik bu kadar",
                 "dinlemeyi bırak", "dinlemeyi birak", "uyu", "uyku moduna geç")
_FILLER = {"ok", "okay", "thanks", "thank", "you", "alright", "great", "tamam", "tesekkurler", "tesekkur", "ederim", "sag", "ol", "olun"}


def sleep_request(text, wake_phrases=()):
    """True when the whole utterance asks the assistant to stop listening."""
    words = normalized_words(text)
    wakes = [normalized_words(p) for p in wake_phrases]
    changed = True
    while words and changed:
        changed = False
        for wake in wakes:
            if wake and words[:len(wake)] == wake: words = words[len(wake):]; changed = True
            if wake and len(words) >= len(wake) and words[-len(wake):] == wake: words = words[:-len(wake)]; changed = True
        while words and words[0] in _FILLER | {'hey'}: words = words[1:]; changed = True
        while words and words[-1] in _FILLER: words = words[:-1]; changed = True
    return bool(words) and any(words == normalized_words(p) for p in SLEEP_PHRASES)


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
        self.reply_window = False
        self.replies = 0

    def set_mode(self, mode):
        if mode not in ('active', 'background'):
            raise ValueError('Invalid listening mode')
        self.mode = mode
        self.reply_window = False
        self.last_interaction = self.clock()
        self.ring.clear()
        self.pending_context = ''
        self.context_at = 0

    def open_reply_window(self):
        """The assistant is about to speak up on its own: listen for an answer
        without the wake phrase, briefly, then go back to waiting."""
        if self.mode != 'background':
            return False
        self.set_mode('active')
        self.reply_window = True
        self.replies += 1
        return True

    def tick(self, busy=False):
        idle = REPLY_WINDOW_SECONDS if self.reply_window else self.settings['idleSeconds']
        if busy:
            self.last_interaction = self.clock()
        elif self.mode == 'active' and idle and self.clock() - self.last_interaction >= idle:
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
            # Answering within a reply window returns to the normal idle time.
            self.reply_window = False
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
                'wakeCount': self.wakes, 'ignoredUtterances': self.ignored,
                'replyWindow': self.reply_window, 'replyWindows': self.replies}

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
            if state.mode == 'active' and sleep_request(frame.text, state.settings['wakePhrases']):
                from pipecat.frames.frames import TTSSpeakFrame
                language = str(getattr(frame.language, 'value', frame.language))
                phrase = state.settings['wakePhrases'][0]
                state.set_mode('background')
                health.partial_text = ''
                health.user_speaking = False
                await self.push_frame(TTSSpeakFrame(f'Tamam. Bana ihtiyacın olunca {phrase} de.' if language.startswith('tr')
                                                    else f'Okay. Say {phrase} when you need me.'))
                return
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
