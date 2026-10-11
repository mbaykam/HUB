"""Explicit model-only installation through the established Hugging Face cache.

No arbitrary URLs, paths, package installations, microphone or model inference.
Cache locking, resumable downloads and atomic blob publication belong to the
upstream downloader. The voice process always remains offline.
"""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys

from speech_settings import (WHISPER_REVISIONS, PIPER_MODEL, PIPER_REPOSITORY,
                             PIPER_REVISION, PIPER_DIRECTORY, PIPER_MODELS, whisper_path, piper_paths,
                             SUPERTONIC_REPOSITORY, SUPERTONIC_REVISION, SUPERTONIC_FILES, supertonic_path,
                             NEMOTRON_REPOSITORY, NEMOTRON_REVISION, NEMOTRON_FILES, NEMOTRON_MODEL, nemotron_path,
                             SEDA_REPOSITORY, SEDA_REVISION, SEDA_FILES)


def install(engine, model):
    if not ((engine == "whisper" and model in WHISPER_REVISIONS)
            or (engine == "piper" and model in PIPER_MODELS)
            or (engine == 'supertonic' and model == 'supertonic-3')
            or (engine == 'nemotron' and model == NEMOTRON_MODEL)):
        raise ValueError("Unsupported speech model")
    if engine == "piper" and importlib.util.find_spec("piper") is None:
        raise ValueError("Install the optional Piper runtime on the host PC first")
    # Leave space for downloads plus cache publication; never delete models or
    # user files to make room. The largest supported model is below 2 GB.
    required = 4_000_000_000 if model in ("medium.en", "medium") else 1_200_000_000
    if shutil.disk_usage(Path.home()).free < required:
        raise ValueError("Not enough free disk space for this speech model")
    print(json.dumps({"phase": "downloading"}), flush=True)
    if engine == "whisper":
        from faster_whisper.utils import download_model
        download_model(model, revision=WHISPER_REVISIONS[model], use_auth_token=False)
    elif engine == 'nemotron':
        if importlib.util.find_spec('sherpa_onnx') is None:
            raise ValueError('Install the streaming speech runtime first')
        from huggingface_hub import snapshot_download
        try:
            whisper_path('base')
        except Exception:
            from faster_whisper.utils import download_model
            download_model('base', revision=WHISPER_REVISIONS['base'], use_auth_token=False)
        snapshot_download(NEMOTRON_REPOSITORY, revision=NEMOTRON_REVISION, token=False,
            allow_patterns=list(NEMOTRON_FILES), local_dir=Path.home()/'.dsh'/'hub-speech-models'/NEMOTRON_REPOSITORY.split('/')[-1])
        snapshot_download(SEDA_REPOSITORY, revision=SEDA_REVISION, token=False,
            allow_patterns=list(SEDA_FILES), local_dir=Path.home()/'.dsh'/'hub-speech-models'/'seda-v0.1')
    elif engine == 'supertonic':
        if importlib.util.find_spec('supertonic') is None:
            raise ValueError('Install the Supertonic runtime first')
        from huggingface_hub import snapshot_download
        snapshot_download(SUPERTONIC_REPOSITORY, revision=SUPERTONIC_REVISION, token=False,
            allow_patterns=list(SUPERTONIC_FILES), local_dir=Path.home()/'.dsh/hub-speech-models/supertonic-3')
    else:
        directory = PIPER_MODELS[model]
        from huggingface_hub import snapshot_download
        snapshot_download(PIPER_REPOSITORY, revision=PIPER_REVISION, token=False,
            allow_patterns=[f"{directory}/{model}.onnx", f"{directory}/{model}.onnx.json", f"{directory}/MODEL_CARD"])
    print(json.dumps({"phase": "verifying"}), flush=True)
    if engine == "whisper": whisper_path(model)
    elif engine == 'supertonic': supertonic_path()
    elif engine == 'nemotron': nemotron_path()
    else: piper_paths(model)
    print(json.dumps({"phase": "complete"}), flush=True)


if __name__ == "__main__":
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ["HF_HUB_DISABLE_IMPLICIT_TOKEN"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    try:
        if len(sys.argv) != 3: raise ValueError("Choose a supported speech model")
        install(sys.argv[1], sys.argv[2])
    except Exception:
        # No remote response bodies, account details or local paths in UI/logs.
        print(json.dumps({"phase": "failed"}), flush=True)
        sys.exit(1)
