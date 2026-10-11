"""Offline Supertonic 3: one speaker style for English and Turkish."""
from functools import lru_cache
import numpy as np
from lingua import Language, LanguageDetectorBuilder
from speech_settings import supertonic_path, SUPERTONIC_VOICES


@lru_cache(maxsize=1)
def supertonic_runtime():
    from supertonic import TTS
    return TTS(model='supertonic-3', model_dir=supertonic_path(), auto_download=False,
               intra_op_num_threads=4, inter_op_num_threads=1)


class SupertonicSynthesizer:
    def __init__(self, settings):
        if settings.get('voice') not in SUPERTONIC_VOICES:
            raise ValueError('Unsupported multilingual voice')
        self.settings = settings
        self.runtime = supertonic_runtime()
        self.style = self.runtime.get_voice_style(settings['voice'])
        self.detector = LanguageDetectorBuilder.from_languages(Language.ENGLISH, Language.TURKISH).build()

    def language(self, text, hint='en'):
        forced = self.settings.get('language', 'auto')
        if forced != 'auto':
            return forced
        found = self.detector.detect_language_of(text)
        return 'tr' if found == Language.TURKISH else 'en' if found == Language.ENGLISH else hint

    def synthesize(self, text, hint='en'):
        samples, _ = self.runtime.synthesize(text, voice_style=self.style,
            lang=self.language(text, hint), total_steps=self.settings.get('steps', 6))
        samples = np.asarray(samples, dtype=np.float32).reshape(-1)
        if not np.isfinite(samples).all():
            raise RuntimeError('Invalid speech audio')
        return (np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes(), self.runtime.sample_rate
