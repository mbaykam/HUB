"""Fixed local voice audition. WAV bytes only on stdout; no mic or AI turn."""
import base64
import io
import json
import os
import sys
import wave
from pathlib import Path
from speech_settings import speech_catalog, english_voices, PIPER_MODELS, SUPERTONIC_VOICES
from bilingual_tts import LocalSpeechSynthesizer, SAMPLES

def preview(settings, language):
    if language not in SAMPLES:
        raise ValueError("Unsupported audition language")
    engine = settings.get("engine")
    if engine in ("kokoro", "bilingual"):
        if settings.get("voice") not in english_voices():
            raise ValueError("Unavailable voice")
        if engine == "kokoro" and language != "en":
            raise ValueError("Kokoro does not support Turkish")
    elif engine == "piper":
        if settings.get("voice") not in PIPER_MODELS or settings.get("voice") != settings.get("model"):
            raise ValueError("Unavailable voice")
        if language != ("tr" if settings["voice"].startswith("tr_") else "en"):
            raise ValueError("The voice does not support this language")
    elif engine == 'supertonic':
        if settings.get('voice') not in SUPERTONIC_VOICES or settings.get('model') != 'supertonic-3':
            raise ValueError('Unavailable multilingual voice')
    else:
        raise ValueError("Unsupported speech engine")
    value = {**settings, "language": language} if engine in ('bilingual', 'supertonic') else settings
    if engine == 'supertonic':
        from supertonic_tts import SupertonicSynthesizer
        synthesizer = SupertonicSynthesizer(value)
    else:
        synthesizer = LocalSpeechSynthesizer(value)
    audio, rate = synthesizer.synthesize(SAMPLES[language])
    stream = io.BytesIO()
    with wave.open(stream, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(audio)
    return stream.getvalue()

def prepare_all(directory):
    """Prepare installed voices once, sharing loaded local model runtimes."""
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    for engine in speech_catalog()["tts"]:
        if not engine["available"] or engine["engine"] == "bilingual":
            continue
        for voice in engine["voices"]:
            languages = ('en', 'tr') if engine['engine'] == 'supertonic' else ('tr' if voice.startswith('tr_') else 'en',)
            for language in languages:
                target = root / f"v1-{language}-{voice}.wav"
                if target.exists():
                    try:
                        with wave.open(str(target), "rb") as wav:
                            if wav.getnframes() > 0 and target.stat().st_size < 2_000_000:
                                continue
                    except (OSError, EOFError, wave.Error):
                        pass
                data = preview({"engine": engine["engine"], "model": engine["model"], "voice": voice}, language)
                temporary = target.with_suffix(".tmp")
                temporary.write_bytes(data)
                temporary.replace(target)
                print(target.name, flush=True)

if __name__ == "__main__":
    os.environ["HF_HUB_OFFLINE"] = "1"
    if sys.argv[1] == "--prepare-all":
        prepare_all(sys.argv[2])
        sys.exit(0)
    encoded = sys.argv[1]
    value = json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))
    sys.stdout.buffer.write(preview(value["tts"], value["language"]))
