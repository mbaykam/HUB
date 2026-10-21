"""Stock Pipecat CPU speech and SmallWebRTC, with HUB's native chat adapter."""
from pathlib import Path

from pipecat.audio.vad.silero import SileroVADAnalyzer
from pipecat.audio.vad.vad_analyzer import VADParams
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.turns.user_turn_strategies import UserTurnStrategies, ExternalUserTurnStrategies
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_start import MinWordsUserTurnStartStrategy
from pipecat.services.kokoro.tts import KokoroTTSService
from pipecat.services.whisper.stt import WhisperSTTService
from pipecat.transcriptions.language import Language
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

from hub_native_llm import HubBridgeClient, HubNativeLLMService
from speech_settings import DEFAULT_SPEECH, resolve_speech
from whisper_auto import AutomaticWhisperSTTService
from speech_health import SpeechHealth, SpeechHealthProbe, TranscriptionHealthProbe
from playback_guard import PlaybackGate, PlaybackInputGuard, PlaybackOutputProbe, SpokenReplyProbe
from pipecat.frames.frames import InterruptionFrame
from voice_attention import VoiceAttention, AttentionInputGate
from pipecat.processors.frameworks.rtvi import RTVIObserverParams


def prepare_voice_models(speech=None):
    """Warm offline weights while WebRTC gathers ICE; no capture or native turn."""
    speech = speech or DEFAULT_SPEECH
    stt_model, _, _, _ = resolve_speech(speech)
    def recognition():
        if speech['stt']['engine']=='soniox':
            from wake_word import LocalWakeDetector
            LocalWakeDetector(speech.get('attention',{}).get('wakePhrases',['Vera']))
        elif speech['stt']['engine']=='nemotron':
            from streaming_asr import StreamingRecognizer
            StreamingRecognizer(speech['stt'].get('language','auto'))
        else:
            from whisper_auto import whisper_runtime
            whisper_runtime(stt_model, 'cpu', 'int8')
            try:
                from streaming_preview import StreamingPreview
                StreamingPreview('en' if speech['stt']['model'].endswith('.en') else speech['stt'].get('language', 'auto'))
            except (ImportError, RuntimeError, OSError):
                pass  # Optional provisional words; final ASR remains authoritative.
    def synthesis():
        if speech['tts']['engine']=='supertonic':
            from supertonic_tts import SupertonicSynthesizer
            SupertonicSynthesizer(speech['tts'])
        elif speech['tts']['engine']=='bilingual':
            from bilingual_tts import LocalSpeechSynthesizer
            LocalSpeechSynthesizer(speech['tts'])
    # Independent offline weights can prepare together while ICE gathers.
    # One awaited startup owns these two bounded workers; no duplicate loads.
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures=[pool.submit(recognition),pool.submit(synthesis)]
        for future in futures:future.result()


def voice_user_turn_params(cloud=False):
    """Keep a short thinking pause inside the caller's current utterance."""
    return LLMUserAggregatorParams(
        vad_analyzer=SileroVADAnalyzer(params=VADParams(confidence=0.5, start_secs=0.08, stop_secs=0.8, min_volume=0.0)),
        user_turn_strategies=ExternalUserTurnStrategies(enable_interruptions=True) if cloud else UserTurnStrategies(
            start=[MinWordsUserTurnStartStrategy(min_words=1, use_interim=False)],
            stop=[SpeechTimeoutUserTurnStopStrategy(user_speech_timeout=.2)]),
    )


# Both Telegram PCM and WebRTC/Opus use a 48 kHz playback clock. Convert each
# complete local utterance directly to that rate in BilingualTTSService. A second
# streaming 16->48 kHz converter retains speech tails and clears them during the
# CPU synthesis gap before the next clause (even while queued speech is playing).
CALL_OUTPUT_SAMPLE_RATE = 48000


def build_voice_worker(connection, bridge: HubBridgeClient, speech=None, *, transport=None, soniox_api_key=None) -> PipelineWorker:
    """Build one call; the sidecar owns its runner and releases models on exit."""
    stt_model, tts_voice, model_path, voices_path = resolve_speech(speech or DEFAULT_SPEECH)
    speech = speech or DEFAULT_SPEECH
    transport = transport or SmallWebRTCTransport(
        webrtc_connection=connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True,
                               audio_out_sample_rate=CALL_OUTPUT_SAMPLE_RATE),
    )
    health = SpeechHealth()
    attention = VoiceAttention(speech.get('attention'))
    health.attention = attention
    gate = PlaybackGate(barge_in=True, foreground=lambda: attention.mode=='active')
    health.playback_gate = gate
    if speech['stt']['engine']=='soniox':
        from soniox_stt import SonioxWakeSTTService
        stt = SonioxWakeSTTService(speech['stt'], api_key=soniox_api_key,
            attention=attention, health=health, playback_gate=gate)
    elif speech['stt']['engine']=='nemotron':
        from native_streaming_stt import LocalStreamingSTTService
        stt = LocalStreamingSTTService(speech['stt'], health=health, playback_gate=gate)
    else:
        stt = AutomaticWhisperSTTService(health=health, playback_gate=gate,
            device="cpu", compute_type="int8",
            allowed_languages=('en','tr') if speech['stt'].get('language')=='en-tr' else None,
            settings=WhisperSTTService.Settings(model=stt_model, language=(Language.EN if speech["stt"]["model"].endswith(".en") else None) if speech["stt"].get("language", "auto") in ("auto","en-tr") else Language.TR if speech["stt"]["language"] == "tr" else Language.EN),
        )
    if speech["tts"]["engine"] in ("bilingual", "supertonic"):
        from bilingual_tts import BilingualTTSService
        tts = BilingualTTSService(speech["tts"], sample_rate=CALL_OUTPUT_SAMPLE_RATE, health=health)
    elif speech["tts"]["engine"] == "piper":
        # Optional, separately installed GPL runtime; not part of HUB's binary.
        # resolve_speech has already verified both local files, so the stock
        # service cannot enter its missing-model automatic download path.
        from pipecat.services.piper.tts import PiperTTSService
        tts = PiperTTSService(download_dir=Path(model_path).parent, sample_rate=CALL_OUTPUT_SAMPLE_RATE,
            settings=PiperTTSService.Settings(voice=tts_voice))
    else:
        tts = KokoroTTSService(
            sample_rate=CALL_OUTPUT_SAMPLE_RATE,
            model_path=model_path, voices_path=voices_path,
            settings=KokoroTTSService.Settings(voice=tts_voice, language=Language.EN_GB if tts_voice.startswith("b") else Language.EN_US),
        )
    llm = HubNativeLLMService(bridge, health=health)
    context = LLMContext()
    user, assistant = LLMContextAggregatorPair(
        context, user_params=voice_user_turn_params(speech['stt']['engine']=='soniox'),
    )
    post_stt_guard = PlaybackInputGuard(gate, mask_audio=False, health=health)
    worker = PipelineWorker(
        Pipeline([transport.input(), SpeechHealthProbe(health), PlaybackInputGuard(gate), stt,
                  post_stt_guard, AttentionInputGate(attention, health), TranscriptionHealthProbe(health), user, llm,
                  SpokenReplyProbe(gate), tts,
                  transport.output(), PlaybackOutputProbe(gate), assistant]),
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=CALL_OUTPUT_SAMPLE_RATE,
                              enable_metrics=True, enable_usage_metrics=True),
        idle_timeout_secs=None,
        cancel_on_idle_timeout=False,
        processor_unusable_policy=ProcessorUnusablePolicy.END,
        # RTVI observes every processor, not only final pipeline output. Publish
        # transcripts only AFTER the echo/attention gates accept them.
        rtvi_observer_params=RTVIObserverParams(ignored_sources=[stt, post_stt_guard]),
    )
    worker.speech_health = health
    async def interrupt_voice():
        # Explicit user control may interrupt playback; it does not manufacture
        # a transcript, replay a task, or release the echo tail early.
        # Clear the transport queue first. A foreground native turn or bounded
        # CPU synthesis can take longer to settle than stopping audible output.
        await transport.output().queue_frame(InterruptionFrame())
        await worker.queue_frame(InterruptionFrame())
    worker.interrupt_voice = interrupt_voice
    async def set_attention(mode):
        # A deliberate pause stops current foreground speech but keeps the
        # native conversation, delegated work, call and warm model weights.
        if speech['stt']['engine']=='soniox':
            await stt.set_attention(mode)
        else:
            attention.set_mode(mode)
        await interrupt_voice()
        health.partial_text = ''
        health.user_speaking = False
        return attention.snapshot()
    worker.set_attention = set_attention
    greeted = False

    @transport.event_handler("on_client_connected")
    async def connected(_transport, _connection):
        nonlocal greeted
        if not greeted:
            greeted = True
            # Start by listening. Unsolicited greeting audio can feed back through
            # a speakerphone and be mistaken for the caller's first request.
            health.stage='listening'

    @transport.event_handler("on_client_disconnected")
    async def disconnected(_transport, _connection):
        await worker.cancel(reason="Voice client disconnected")

    @llm.event_handler("on_hub_activity")
    async def activity(_llm, event):
        await worker.rtvi.send_server_message({"type": "hub-voice-activity", "event": event})

    return worker
