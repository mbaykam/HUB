"""Local wake listener; short speech prefixes stay in RAM and are discarded.

Silero ignores silence; Whisper base checks only the start of an utterance for
configured wake phrases. No transcript, cloud connection, recording or LLM is
produced while waiting. The foreground recognizer is not running here.
"""
from functools import lru_cache
import numpy as np

WAKE_MODEL = 'whisper-base'


def wake_path():
    from speech_settings import whisper_path
    try:
        return whisper_path('base')
    except Exception:
        raise ValueError('Install the local wake listener in Settings → Speech') from None


def install_wake_model():
    from faster_whisper.utils import download_model
    from speech_settings import WHISPER_REVISIONS
    download_model('base', revision=WHISPER_REVISIONS['base'], use_auth_token=False)
    wake_path()


def wake_prefix(text, phrases):
    from voice_attention import normalized_words
    words = normalized_words(text)
    for phrase in phrases:
        wake = normalized_words(phrase)
        offset = 1 if words[:1] in (['hey'], ['hi'], ['hello'], ['merhaba'], ['selam']) and words[:1] != wake[:1] else 0
        if words[offset:offset+len(wake)] == wake:
            return phrase
    return None


@lru_cache(maxsize=1)
def wake_model():
    from faster_whisper import WhisperModel
    return WhisperModel(str(wake_path()),device='cpu',compute_type='int8',
                        cpu_threads=2,num_workers=1,local_files_only=True)


class LocalWakeDetector:
    def __init__(self, phrases, *, model=None, vad=None):
        self.phrases = list(phrases)
        self.model = model or wake_model()
        if vad is None:
            from pipecat.audio.vad.silero import SileroVADAnalyzer
            vad = SileroVADAnalyzer(sample_rate=16000)
            vad.set_sample_rate(16000)
        self.vad = vad
        self.reset()

    def reset(self):
        self.pending = bytearray()
        self.lookback = bytearray()
        self.speech = bytearray()
        self.quiet = 0
        self.next_check = 28800
        self.exhausted = False

    def _check(self):
        segments, _ = self.model.transcribe(
            np.frombuffer(self.speech,dtype='<i2').astype(np.float32)/32768,
            beam_size=1,temperature=0.0,max_new_tokens=24,without_timestamps=True,
            condition_on_previous_text=False,language=None,
            initial_prompt='Wake phrases: '+', '.join(self.phrases)+'.',vad_filter=False)
        text = ''
        for segment in segments:
            if segment.no_speech_prob > .6 or segment.avg_logprob < -1.0:
                return None
            text += segment.text
        return wake_prefix(text,self.phrases)

    def feed(self, audio):
        self.pending.extend(audio)
        while len(self.pending) >= 1024:
            frame = bytes(self.pending[:1024]);del self.pending[:1024]
            samples = np.frombuffer(frame,dtype='<i2').astype(np.float32)/32768
            voiced = self.vad.voice_confidence(frame) >= .5 and np.mean(samples*samples) >= .000001
            if voiced:
                self.quiet = 0
                if not self.speech and not self.exhausted:
                    self.speech.extend(self.lookback)
            else:
                self.quiet += 1024
            if self.speech or voiced or self.exhausted:
                if not self.exhausted:self.speech.extend(frame)
                ended = self.quiet >= 10240
                if not self.exhausted and (len(self.speech) >= self.next_check or ended and len(self.speech) >= 12800):
                    hit = self._check()
                    self.next_check = len(self.speech)+22400
                    if hit:
                        self.reset()
                        return hit
                # Never slide to a name later in somebody else's sentence.
                if len(self.speech) >= 96000:
                    self.speech.clear();self.exhausted=True
                if ended:
                    self.speech.clear();self.exhausted=False;self.next_check=28800
            self.lookback.extend(frame)
            del self.lookback[:-5120]
        return None
