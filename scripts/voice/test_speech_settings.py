"""Offline configuration checks and real cached English speech round-trip."""
import asyncio
import copy
import os
from pathlib import Path
import sys
import zipfile

import pytest

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/harness-overlay/voice"))
import speech_settings as settings


def test_voice_index_filters_foreign_names_and_paths(tmp_path, monkeypatch):
    voices = tmp_path / "voices.bin"
    with zipfile.ZipFile(voices, "w") as archive:
        for name in ["af_heart.npy", "bf_emma.npy", "jf_alpha.npy", "../../af_secret.npy", "readme.txt"]:
            archive.writestr(name, b"not loaded")
    monkeypatch.setattr(settings, "kokoro_paths", lambda: (tmp_path / "model.onnx", voices))
    assert settings.english_voices() == ["af_heart", "bf_emma"]


def test_configuration_rejects_unknown_fields_paths_and_missing_models(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "english_voices", lambda: ["af_heart"])
    for transform in [
        lambda v: v.update(executable="anything.exe"),
        lambda v: v["stt"].update(model="../../private"),
        lambda v: v["tts"].update(voice="../../private"),
        lambda v: v["tts"].update(engine="cloud"),
        lambda v: v["tts"].update(model="missing"),
    ]:
        value = copy.deepcopy(settings.DEFAULT_SPEECH); transform(value)
        with pytest.raises(ValueError): settings.resolve_speech(value)
    monkeypatch.setattr(settings, "whisper_path", lambda _: tmp_path)
    monkeypatch.setattr(settings, "kokoro_paths", lambda: (tmp_path / "missing.onnx", tmp_path / "missing.bin"))
    with pytest.raises(ValueError, match="missing"): settings.resolve_speech(settings.DEFAULT_SPEECH)


@pytest.mark.skipif(os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1", reason="Explicit cached-model acceptance check")
def test_catalog_and_actual_selected_voice_round_trip(monkeypatch):
    # Native cached models only; no microphone, API, conversation or download.
    import pipecat.services.kokoro.tts as kokoro
    from pipecat.services.whisper.stt import WhisperSTTService
    from pipecat.frames.frames import TTSSpeakFrame, TTSAudioRawFrame, TranscriptionFrame, ErrorFrame
    from pipecat.tests.utils import run_test
    from pipecat.transcriptions.language import Language
    def no_download(*_args, **_kwargs): raise AssertionError("Implicit model download")
    monkeypatch.setattr(kokoro, "_download_file", no_download)
    catalog = settings.speech_catalog()
    assert next(m for m in catalog["stt"] if m["model"] == "base.en")["available"]
    assert "bf_emma" in next(model for model in catalog["tts"] if model["engine"] == "kokoro")["voices"]
    value = copy.deepcopy(settings.DEFAULT_SPEECH); value["tts"]["voice"] = "bf_emma"
    stt_path, voice, model, voices = settings.resolve_speech(value)
    assert Path(stt_path).is_dir() and voice == "bf_emma"
    async def check():
        tts = kokoro.KokoroTTSService(model_path=model, voices_path=voices, sample_rate=16000,
            settings=kokoro.KokoroTTSService.Settings(voice=voice, language=Language.EN_GB))
        down, up = await asyncio.wait_for(run_test(tts, frames_to_send=[TTSSpeakFrame("The blue notebook is on the kitchen table.")], start_timeout=10), 90)
        assert not any(isinstance(frame, ErrorFrame) for frame in [*down, *up])
        audio = b"".join(frame.audio for frame in down if isinstance(frame, TTSAudioRawFrame))
        assert len(audio) > 16000
        stt = WhisperSTTService(device="cpu", compute_type="int8", settings=WhisperSTTService.Settings(model=stt_path, language=Language.EN))
        frames = [frame async for frame in stt.run_stt(audio)]
        assert not any(isinstance(frame, ErrorFrame) for frame in frames)
        text = " ".join(frame.text for frame in frames if isinstance(frame, TranscriptionFrame)).lower()
        assert all(word in text for word in ["blue", "notebook", "kitchen", "table"])
    asyncio.run(check())


@pytest.mark.skipif(os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1", reason="Explicit cached-model acceptance check")
def test_piper_and_tiny_whisper_actual_offline_round_trip(monkeypatch):
    import pipecat.services.piper.tts as piper
    from pipecat.services.whisper.stt import WhisperSTTService
    from pipecat.frames.frames import TTSSpeakFrame, TTSAudioRawFrame, TranscriptionFrame, ErrorFrame
    from pipecat.tests.utils import run_test
    from pipecat.transcriptions.language import Language
    def no_download(*_args, **_kwargs): raise AssertionError("Implicit Piper download")
    monkeypatch.setattr(piper, "download_voice", no_download)
    value = {"stt": {"engine": "whisper", "model": "tiny.en"},
             "tts": {"engine": "piper", "model": settings.PIPER_MODEL, "voice": settings.PIPER_MODEL}}
    stt_path, voice, model, config = settings.resolve_speech(value)
    assert Path(config).is_file()
    async def check():
        tts = piper.PiperTTSService(download_dir=Path(model).parent, sample_rate=16000,
            settings=piper.PiperTTSService.Settings(voice=voice))
        down, up = await asyncio.wait_for(run_test(tts, frames_to_send=[TTSSpeakFrame("The blue notebook is on the kitchen table.")], start_timeout=10), 90)
        assert not any(isinstance(frame, ErrorFrame) for frame in [*down, *up])
        audio = b"".join(frame.audio for frame in down if isinstance(frame, TTSAudioRawFrame))
        assert len(audio) > 16000
        stt = WhisperSTTService(device="cpu", compute_type="int8", settings=WhisperSTTService.Settings(model=stt_path, language=Language.EN))
        frames = [frame async for frame in stt.run_stt(audio)]
        assert not any(isinstance(frame, ErrorFrame) for frame in frames)
        text = " ".join(frame.text for frame in frames if isinstance(frame, TranscriptionFrame)).lower()
        assert all(word in text for word in ["blue", "notebook", "kitchen", "table"]), text
    asyncio.run(check())


def test_explicit_downloader_rejects_urls_and_uses_only_pinned_anonymous_files(monkeypatch, capsys, tmp_path):
    import speech_download as download
    import huggingface_hub
    import faster_whisper.utils
    calls = []
    for engine, model in [("shell", "command"), ("whisper", "../../file"), ("piper", "https://example.com")]:
        with pytest.raises(ValueError): download.install(engine, model)
    monkeypatch.setattr(download.shutil, "disk_usage", lambda _: type("Space", (), {"free": 10_000_000_000})())
    monkeypatch.setattr(download.importlib.util, "find_spec", lambda _: True)
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda *a, **kw: calls.append((a, kw)))
    monkeypatch.setattr(download, "piper_paths", lambda _model=settings.PIPER_MODEL: (tmp_path, tmp_path))
    download.install("piper", settings.PIPER_MODEL)
    assert calls[0][1]["revision"] == settings.PIPER_REVISION
    assert calls[0][1]["token"] is False
    assert len(calls[0][1]["allow_patterns"]) == 3
    assert all(path.startswith(settings.PIPER_DIRECTORY + "/") for path in calls[0][1]["allow_patterns"])
    monkeypatch.setattr(faster_whisper.utils, "download_model", lambda *a, **kw: calls.append((a, kw)))
    monkeypatch.setattr(download, "whisper_path", lambda _: tmp_path)
    download.install("whisper", "tiny.en")
    assert calls[1][1] == {"revision": settings.WHISPER_REVISIONS["tiny.en"], "use_auth_token": False}


def test_piper_offline_discovery_limits_snapshot_and_does_not_download(monkeypatch, tmp_path):
    import huggingface_hub
    calls = []
    monkeypatch.setattr(huggingface_hub, "snapshot_download", lambda *a, **kw: (calls.append((a, kw)), str(tmp_path))[1])
    with pytest.raises(ValueError, match="incomplete"): settings.piper_paths()
    params = calls[0][1]
    assert params["local_files_only"] is True and params["token"] is False
    assert params["revision"] == settings.PIPER_REVISION and len(params["allow_patterns"]) == 2
