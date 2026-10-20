"""Read-only, offline discovery for HUB's stock local Pipecat speech services.

No model inference, model downloads, provider credentials or user audio here.
Only fixed supported model IDs and installed English voice names leave Python.
"""
import importlib.util
import json
import os
from pathlib import Path
import re
import zipfile

WHISPER_MODELS = ("tiny.en", "base.en", "small.en", "medium.en", "tiny", "base", "small", "medium")
WHISPER_REVISIONS = {
    "tiny": "d90ca5fe260221311c53c58e660288d3deb8d356",
    "base": "ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
    "small": "536b0662742c02347bc0e980a01041f333bce120",
    "medium": "08e178d48790749d25932bbc082711ddcfdfbc4f",
    "tiny.en": "0d3d19a32d3338f10357c0889762bd8d64bbdeba",
    "base.en": "3d3d5dee26484f91867d81cb899cfcf72b96be6c",
    "small.en": "d1d751a5f8271d482d14ca55d9e2deeebbae577f",
    "medium.en": "a29b04bd15381511a9af671baec01072039215e3",
}
PIPER_MODEL = "en_US-ljspeech-high"
PIPER_REPOSITORY = "rhasspy/piper-voices"
PIPER_REVISION = "1162a9173d0ce503555aed757976b7a9912eae4c"
PIPER_DIRECTORY = "en/en_US/ljspeech/high"
PIPER_MODELS = {PIPER_MODEL: PIPER_DIRECTORY, "tr_TR-dfki-medium": "tr/tr_TR/dfki/medium"}
SUPERTONIC_REPOSITORY = 'Supertone/supertonic-3'
SUPERTONIC_REVISION = '3cadd1ee6394adea1bd021217a0e650ede09a323'
SUPERTONIC_VOICES = tuple(f'{prefix}{number}' for prefix in ('F', 'M') for number in range(1, 6))
SUPERTONIC_FILES = ('onnx/duration_predictor.onnx', 'onnx/text_encoder.onnx',
    'onnx/vector_estimator.onnx', 'onnx/vocoder.onnx', 'onnx/tts.json', 'onnx/unicode_indexer.json',
    'config.json', 'LICENSE') + tuple(f'voice_styles/{voice}.json' for voice in SUPERTONIC_VOICES)
NEMOTRON_REPOSITORY = 'csukuangfj2/sherpa-onnx-nemotron-3.5-asr-streaming-0.6b-560ms-int8-2026-06-11'
NEMOTRON_REVISION = 'ab43d895f5985b1bbab8b6eac8607fcdc05343f3'
NEMOTRON_MODEL = '3.5-560ms'
NEMOTRON_FILES = ('encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt')
SEDA_REPOSITORY = 'atasoglu/seda-v0.1'
SEDA_REVISION = 'b5cf32ae4936968b284df3f1c4c79714af71e1fe'
SEDA_FILES = ('encoder.int8.onnx','decoder.onnx','joiner.int8.onnx','tokens.txt')
DEFAULT_SPEECH = {"stt": {"engine": "whisper", "model": "base.en"},
                  "tts": {"engine": "kokoro", "model": "82m", "voice": "af_heart"}}


def kokoro_paths():
    root = Path.home() / ".cache" / "pipecat" / "kokoro-onnx"
    return root / "kokoro-v1.0.onnx", root / "voices-v1.0.bin"


def supertonic_path():
    root = Path.home() / '.dsh' / 'hub-speech-models' / 'supertonic-3'
    if importlib.util.find_spec('supertonic') is None or not all((root / name).is_file() for name in SUPERTONIC_FILES):
        raise ValueError('Install the Supertonic 3 runtime and model on the host PC')
    return root


def nemotron_path():
    root = Path.home()/'.dsh'/'hub-speech-models'/NEMOTRON_REPOSITORY.split('/')[-1]
    if importlib.util.find_spec('sherpa_onnx') is None or not all((root/name).is_file() for name in NEMOTRON_FILES):
        raise ValueError('Install the multilingual streaming recognition model and runtime on the host PC')
    whisper_path('base')  # Local short-utterance verification is part of this engine.
    seda_path()
    return root


def seda_path():
    root = Path.home()/'.dsh'/'hub-speech-models'/'seda-v0.1'
    if not all((root/name).is_file() for name in SEDA_FILES):
        raise ValueError('Install the Turkish short-utterance verifier on the host PC')
    return root


def whisper_path(model):
    if model not in WHISPER_MODELS:
        raise ValueError("Unsupported local STT model")
    from faster_whisper.utils import download_model
    # Explicit local_files_only is independent of ambient HF configuration.
    try:
        path = Path(download_model(model, revision=WHISPER_REVISIONS[model], local_files_only=True, use_auth_token=False))
    except Exception:
        # Preserve an already installed user cache from before HUB pinned its
        # downloads. Both paths are strictly offline and load no executable code.
        path = Path(download_model(model, local_files_only=True, use_auth_token=False))
    if not all((path / name).is_file() for name in ("model.bin", "config.json", "tokenizer.json")):
        raise ValueError("Local STT model is incomplete")
    return path


def piper_paths(model_id=PIPER_MODEL):
    if model_id not in PIPER_MODELS:
        raise ValueError("Unsupported Piper voice")
    directory = PIPER_MODELS[model_id]
    from huggingface_hub import snapshot_download
    root = Path(snapshot_download(PIPER_REPOSITORY, revision=PIPER_REVISION,
                local_files_only=True, token=False,
                allow_patterns=[f"{directory}/{model_id}.onnx",
                                f"{directory}/{model_id}.onnx.json"])) / directory
    model, config = root / f"{model_id}.onnx", root / f"{model_id}.onnx.json"
    if not model.is_file() or not config.is_file():
        raise ValueError("Local Piper model is incomplete")
    return model, config


def english_voices():
    _, path = kokoro_paths()
    # Stock kokoro-onnx stores its voices as an NPZ archive. Reading its index
    # does not deserialize pickle data, extract files or load the ONNX model.
    with zipfile.ZipFile(path) as archive:
        return sorted(name[:-4] for name in archive.namelist()
                      if re.fullmatch(r"[ab][fm]_[a-z0-9_]+\.npy", name))


def speech_catalog():
    stt = []
    from wake_word import wake_path
    wake_available = False
    if importlib.util.find_spec('faster_whisper') is not None:
        try:
            wake_path()
            wake_available = True
        except ValueError: pass
    stt.append({'engine':'soniox','model':'stt-rt-v5','available':wake_available,
        'downloadable':not wake_available and importlib.util.find_spec('faster_whisper') is not None,
        'reason':None if wake_available else 'Install the local wake listener before using Soniox.'})
    runtime_stt = importlib.util.find_spec("faster_whisper") is not None
    for model in WHISPER_MODELS:
        available = False
        if runtime_stt:
            try:
                whisper_path(model)
                available = True
            except Exception:
                pass
        stt.append({"engine": "whisper", "model": model, "available": available, "downloadable": runtime_stt,
                    "reason": None if available else "Model files must be installed on the host PC."})
    nemotron_available = False
    try:
        nemotron_path()
        nemotron_available = True
    except ValueError:
        pass
    stt.insert(0, {'engine':'nemotron','model':NEMOTRON_MODEL,'available':nemotron_available,
        'downloadable':importlib.util.find_spec('sherpa_onnx') is not None,
        'reason':None if nemotron_available else 'Install multilingual streaming recognition on the host PC.'})
    model_path, voices_path = kokoro_paths()
    voices = []
    if importlib.util.find_spec("kokoro_onnx") is not None and model_path.is_file() and voices_path.is_file():
        try:
            voices = english_voices()
        except (OSError, zipfile.BadZipFile):
            pass
    piper_available = False
    piper_reason = "Install the optional piper-tts runtime on the host PC (GPL-3.0-or-later)."
    if importlib.util.find_spec("piper") is not None:
        piper_reason = "Download the Piper LJ Speech model before use."
        try:
            piper_paths()
            piper_available = True
        except Exception:
            pass
    turkish_available = False
    if importlib.util.find_spec("piper") is not None:
        try:
            piper_paths("tr_TR-dfki-medium")
            turkish_available = True
        except Exception:
            pass
    supertonic_available = False
    try:
        supertonic_path()
        supertonic_available = True
    except ValueError:
        pass
    return {"stt": stt, "tts": [
        {'engine':'supertonic', 'model':'supertonic-3', 'available':supertonic_available,
         'downloadable':importlib.util.find_spec('supertonic') is not None, 'voices':list(SUPERTONIC_VOICES),
         'reason':None if supertonic_available else 'Install Supertonic 3 for one voice across English and Turkish.'},
        {"engine": "kokoro", "model": "82m", "available": bool(voices), "downloadable": False, "voices": voices,
         "reason": None if voices else "Kokoro model and English voice files must be installed on the host PC."},
        {"engine": "piper", "model": PIPER_MODEL, "available": piper_available, "downloadable": importlib.util.find_spec("piper") is not None,
         "voices": [PIPER_MODEL], "reason": None if piper_available else piper_reason},
        {"engine": "piper", "model": "tr_TR-dfki-medium", "available": turkish_available,
         "downloadable": importlib.util.find_spec("piper") is not None, "voices": ["tr_TR-dfki-medium"],
         "reason": None if turkish_available else "Download the Turkish DFKI voice."},
        {"engine": "bilingual", "model": "kokoro-piper", "available": bool(voices) and turkish_available and importlib.util.find_spec("lingua") is not None,
         "downloadable": False, "voices": voices,
         "reason": None if voices and turkish_available and importlib.util.find_spec("lingua") is not None else "Install Kokoro English, Piper Turkish and the local language detector."},
    ]}


def resolve_speech(value):
    if not isinstance(value, dict) or not {'stt', 'tts'} <= set(value) or set(value) - {'stt', 'tts', 'attention'}:
        raise ValueError("Invalid local speech settings")
    from voice_attention import attention_settings
    attention_settings(value.get('attention'))
    stt, tts = value["stt"], value["tts"]
    if (not isinstance(stt, dict) or set(stt) - {"engine", "model", "language"}
            or not (stt.get('engine')=='whisper' and stt.get('model') in WHISPER_MODELS
                    or stt.get('engine')=='nemotron' and stt.get('model')==NEMOTRON_MODEL
                    or stt.get('engine')=='soniox' and stt.get('model')=='stt-rt-v5')):
        raise ValueError("Unsupported local STT settings")
    if stt.get("language", "auto") not in ("auto", "en-tr", "en", "tr"):
        raise ValueError("Invalid speech language")
    if stt.get('engine')=='whisper' and stt["model"].endswith(".en") and stt.get("language") in ("tr","en-tr"):
        raise ValueError("Select a multilingual Whisper model for Turkish")
    if not isinstance(tts, dict):
        raise ValueError("Invalid local TTS settings")
    if stt['engine']=='soniox':
        from wake_word import wake_path
        stt_path = wake_path()
    else:
        stt_path = nemotron_path() if stt['engine']=='nemotron' else whisper_path(stt['model'])
    if tts.get('engine') == 'supertonic':
        if (set(tts) - {'engine','model','voice','language','steps'} or tts.get('model') != 'supertonic-3'
                or tts.get('voice') not in SUPERTONIC_VOICES
                or tts.get('language','auto') not in ('auto','en','tr')
                or type(tts.get('steps',6)) is not int or not 4 <= tts.get('steps',6) <= 8):
            raise ValueError('Invalid multilingual speech settings')
        return str(stt_path), tts['voice'], str(supertonic_path()), ''
    if tts.get("engine") == "bilingual":
        if (set(tts) - {"engine", "model", "voice", "turkishVoice", "language"}
                or tts.get("model") != "kokoro-piper" or tts.get("turkishVoice") != "tr_TR-dfki-medium"
                or tts.get("language", "auto") not in ("auto", "en", "tr")):
            raise ValueError("Invalid bilingual speech settings")
        piper_paths(tts["turkishVoice"])
    elif set(tts) != {"engine", "model", "voice"}:
        raise ValueError("Invalid local TTS settings")
    if tts["engine"] == "piper":
        if tts["model"] not in PIPER_MODELS or tts["voice"] != tts["model"] or importlib.util.find_spec("piper") is None:
            raise ValueError("Unsupported or missing local Piper runtime")
        model, config = piper_paths(tts["model"])
        return str(stt_path), tts["voice"], str(model), str(config)
    if (tts["engine"] not in ("kokoro", "bilingual") or tts["model"] not in ("82m", "kokoro-piper")
            or not isinstance(tts["voice"], str) or tts["voice"] not in english_voices()):
        raise ValueError("Unsupported or missing local TTS voice")
    model_path, voices_path = kokoro_paths()
    if not model_path.is_file() or not voices_path.is_file():
        raise ValueError("Local TTS model is missing")
    # Give the stock Whisper adapter the resolved local directory, not a model
    # ID that could trigger a second Hub lookup or an implicit download.
    return str(stt_path), tts["voice"], str(model_path), str(voices_path)


if __name__ == "__main__":
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    print(json.dumps(speech_catalog()), flush=True)
