"""Soniox foreground STT; bounded offline keyword spotting in Background.

Closing a paid stream is a mode barrier: stale results cannot wake or act, and
no keepalive, capture or handshake runs while waiting for the local keyword.
"""
import asyncio
import json
import time
from pipecat.frames.frames import (TranscriptionFrame, InterimTranscriptionFrame, ErrorFrame, STTMuteFrame,
    ProposedUserStartedSpeakingFrame, ProposedUserStoppedSpeakingFrame, TTSSpeakFrame,
    VADUserStartedSpeakingFrame, VADUserStoppedSpeakingFrame)
from pipecat.services.stt_service import STTService
from pipecat.services.settings import STTSettings
from pipecat.transcriptions.language import Language
from pipecat.utils.time import time_now_iso8601
from wake_word import LocalWakeDetector
from voice_attention import normalized_words

SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket'


def soniox_config(language):
    config = {'model':'stt-rt-v5', 'audio_format':'pcm_s16le', 'sample_rate':16000,
              'num_channels':1, 'enable_language_identification':True,
              'enable_endpoint_detection':True, 'endpoint_latency_adjustment_level':0,
              'endpoint_sensitivity':-0.3,
              'max_endpoint_delay_ms':2000}
    if language != 'auto':
        config['language_hints'] = ['en','tr'] if language == 'en-tr' else [language]
        config['language_hints_strict'] = True
    return config


class SonioxWakeSTTService(STTService):
    def __init__(self, speech, *, api_key, attention, health, playback_gate,
                 connector=None, wake=None, endpoint_settle_seconds=.35, **kwargs):
        if not isinstance(api_key,str) or not 16 <= len(api_key) <= 512 or any(c.isspace() for c in api_key):
            raise ValueError('Connect Soniox in Settings → Speech before starting a call')
        super().__init__(settings=STTSettings(model='stt-rt-v5',language=None),
                         sample_rate=16000, ttfs_p99_latency=1.5, **kwargs)
        self._api_key, self.speech = api_key, speech
        self.attention, self.health, self.gate = attention, health, playback_gate
        self.connector, self.wake = connector, wake or LocalWakeDetector(attention.settings['wakePhrases'])
        self.socket = None
        self.receiver = self.monitor = None
        self.lock = asyncio.Lock()
        self.generation = 0
        self.tokens = []
        self.language_code = None
        self.language_counts = {}
        self.turn_open = False
        self.wake_pending = False
        self.preroll = bytearray()
        self.closed = False
        self.cloud_started = None
        self.cloud_seconds = 0.0
        self.mode = attention.mode
        self.echo_generation = playback_gate.generation
        # A provider endpoint can precede the caller's last word. Local VAD is
        # only a veto: it never finalizes unconfirmed words or forces an endpoint.
        self.vad_speaking = False
        self.vad_stopped_at = 0.0
        self.endpoint_settle_seconds = endpoint_settle_seconds
        self.endpoint_task = None
        self.endpoint_pending = False
        health.recognition_source = 'soniox'
        health.preview_ready = True

    @property
    def supports_ttfs(self): return False

    async def _turn_started(self):
        if not self.turn_open:
            self.turn_open=True
            await self.broadcast_frame(ProposedUserStartedSpeakingFrame)

    async def _turn_stopped(self):
        if self.turn_open:
            self.turn_open=False
            await self.broadcast_frame(ProposedUserStoppedSpeakingFrame)

    async def start(self, frame):
        await super().start(frame)
        self.monitor = asyncio.create_task(self._watch_mode())

    async def _watch_mode(self):
        while not self.closed:
            await asyncio.sleep(.2)
            async with self.lock:
                await self._sync_mode()

    async def _sync_mode(self):
        h = self.health
        self.attention.tick(h.model_active or h.bot_speaking or h.synthesizing
                            or h.user_speaking or self.gate.blocked)
        if self.mode != self.attention.mode:
            self.mode = self.attention.mode
            await self._disconnect()
            self.wake.reset()
            self.preroll.clear()
            self.health.partial_text = ''
            self.health.user_speaking = False
        self._meter()

    async def set_attention(self, mode):
        async with self.lock:
            self.attention.set_mode(mode)
            await self._sync_mode()

    def _meter(self):
        elapsed = time.monotonic()-self.cloud_started if self.cloud_started is not None else 0
        self.health.cloud_recognition = {'connected':self.socket is not None,
            'seconds':round(self.cloud_seconds+elapsed,1), 'backgroundEngine':'local-keyword'}

    async def _disconnect(self):
        self.generation += 1
        await self._cancel_endpoint()
        self.vad_speaking = False
        if self.health.stage == 'transcribing': self.health.stage = 'listening'
        socket, self.socket = self.socket, None
        receiver, self.receiver = self.receiver, None
        self.tokens.clear()
        self.language_code = None
        self.language_counts.clear()
        await self._turn_stopped()
        self.wake_pending = False
        if self.cloud_started is not None:
            self.cloud_seconds += time.monotonic()-self.cloud_started
            self.cloud_started = None
        if receiver and receiver is not asyncio.current_task():
            receiver.cancel()
            await asyncio.gather(receiver, return_exceptions=True)
        if socket:
            # Closing, rather than pausing a paid stream, stops its duration meter.
            await socket.close()
        self._meter()

    async def _connect(self):
        if self.socket is not None: return
        if self.closed or self.attention.mode != 'active' or self._muted: return
        if self.connector is None:
            from websockets.asyncio.client import connect
            connector = connect
        else: connector = self.connector
        socket = await connector(SONIOX_URL,
            additional_headers={'Authorization':'Bearer '+self._api_key},
            open_timeout=5, close_timeout=2, max_size=128000, max_queue=8,
            proxy=None, ping_interval=10, ping_timeout=10)
        try: await socket.send(json.dumps(soniox_config(self.speech.get('language','auto'))))
        except BaseException:
            await socket.close()
            raise
        self.socket = socket
        self.cloud_started = time.monotonic()
        self.generation += 1
        self.receiver = asyncio.create_task(self._receive(socket,self.generation))
        self._meter()

    async def _failed(self, code='connection'):
        await self._disconnect()
        self.attention.set_mode('background')
        self.mode = 'background'
        self.preroll.clear()
        self.wake.reset()
        self.health.partial_text = ''
        self.health.user_speaking = False
        # Never put provider bodies, keys, or user audio in an error/log.
        message = ('Soniox balance or access is unavailable. Check Settings → Speech, then press Resume.'
                   if code in ('balance','access') else
                   'Speech connection was lost. Local wake listening is active; press Resume to retry.')
        await self.push_frame(ErrorFrame(message))

    async def _receive(self, socket, generation):
        try:
            async for raw in socket:
                value = json.loads(raw)
                # Serialize result admission with pause/mute/close. Once their
                # barrier returns, an older reader cannot publish another word.
                async with self.lock:
                    if generation != self.generation or self.attention.mode != 'active': return
                    if value.get('error_code') or value.get('error_type'):
                        raise PermissionError('Speech service unavailable')
                    if self.gate.input_blocked:
                        await self._cancel_endpoint()
                        self.tokens.clear();self.language_counts.clear()
                        self.health.partial_text = ''
                        await self._turn_stopped()
                        continue
                    await self._receive_tokens(value)
                    if value.get('finished'): raise ConnectionError('Recognition stream ended')
            await self._remote_failed(socket,generation)
        except asyncio.CancelledError: raise
        except PermissionError:
            await self._remote_failed(socket,generation,'access')
        except Exception:
            await self._remote_failed(socket,generation)

    async def _receive_tokens(self, value):
        partial = []
        for token in value.get('tokens',[]):
            if token.get('translation_status') == 'translation': continue
            text = token.get('text','')
            if text == '<end>' and token.get('is_final'):
                self.health.endpoint_events += 1
                self.endpoint_pending = bool(self.tokens)
                self.health.endpoint_pending = self.endpoint_pending
                if self.endpoint_pending and self.vad_speaking:
                    self.health.endpoint_vad_deferrals += 1
                continue
            if not isinstance(text,str): continue
            if text.startswith('<') and text.endswith('>'): continue
            if text.strip() and self.endpoint_pending:
                # A continued segment belongs to the still-open caller turn.
                # Keep its confirmed prefix and wait for the NEW final endpoint.
                self.health.endpoint_continuations += 1
                await self._cancel_endpoint()
                # The first token of a new segment need not carry the preceding
                # segment's space. Keep words separate across the semantic split.
                if self.tokens and not self.tokens[-1][-1:].isspace() and text[0].isalnum():
                    self.tokens.append(' ')
            if token.get('is_final'):
                self.tokens.append(text)
                if token.get('language'):
                    code=token['language']
                    self.language_counts[code]=self.language_counts.get(code,0)+len(text.strip())
            else: partial.append(text)
        if sum(map(len,self.tokens)) > 12000: raise ValueError('Recognition turn exceeded its bound')
        if self.endpoint_pending and self.endpoint_task is None:
            self.health.stage = 'transcribing'
            self.endpoint_task = asyncio.create_task(self._settle_endpoint(self.generation))
        draft = ' '.join(''.join(self.tokens+partial).split())
        if draft:
            if not self.gate.accepts_transcript(draft):
                self.health.partial_text = ''
                return
            await self._turn_started()
            self.health.partial_text = draft[-2000:]
            self.health.partial_at = time.perf_counter()
            await self.push_frame(InterimTranscriptionFrame(draft,self._user_id,time_now_iso8601()))

    async def _cancel_endpoint(self):
        task, self.endpoint_task = self.endpoint_task, None
        self.endpoint_pending = False
        self.health.endpoint_pending = False
        if task and task is not asyncio.current_task():
            task.cancel()
            await asyncio.gather(task,return_exceptions=True)

    async def _settle_endpoint(self, generation):
        try:
            # Let a just-arriving VAD start or next Soniox segment veto an early
            # semantic split. This adds only a bounded 350 ms in normal silence.
            await asyncio.sleep(self.endpoint_settle_seconds)
            while True:
                async with self.lock:
                    if (generation != self.generation or not self.endpoint_pending or
                        self.closed or self._muted or self.attention.mode != 'active'):
                        return
                    if not self.vad_speaking and time.perf_counter()-self.vad_stopped_at >= .1:
                        await self._publish_endpoint()
                        return
                await asyncio.sleep(.025)
        finally:
            if self.endpoint_task is asyncio.current_task():
                self.endpoint_task = None

    async def _publish_endpoint(self):
        text = ' '.join(''.join(self.tokens).split())
        self.tokens.clear()
        self.endpoint_pending = False
        self.health.endpoint_pending = False
        self.health.partial_text = ''
        if self.health.stage == 'transcribing': self.health.stage = 'listening'
        if not text or not self.gate.accepts_transcript(text, final=True):
            self.language_counts.clear()
            await self._turn_stopped()
            return
        self.language_code=max(self.language_counts,key=self.language_counts.get) if self.language_counts else None
        language = Language.TR if self.language_code=='tr' else Language.EN if self.language_code=='en' else None
        self.language_counts.clear()
        self.health.recognition_language = self.language_code
        words=normalized_words(text)
        wake_only=self.wake_pending and any(words==normalized_words(p) or any(words==[hello,*normalized_words(p)] for hello in ('hey','hi','hello','merhaba','selam')) for p in self.attention.settings['wakePhrases'])
        self.wake_pending=False
        if wake_only:
            await self._turn_stopped()
            await self.push_frame(TTSSpeakFrame('Dinliyorum.' if self.language_code=='tr' else "I'm listening."))
        else:
            await self._turn_started()
            await self.push_frame(TranscriptionFrame(text,self._user_id,time_now_iso8601(),language,finalized=True))
            await self._turn_stopped()

    async def _remote_failed(self,socket,generation,code='connection'):
        async with self.lock:
            if self.socket is socket and generation==self.generation and not self.closed:
                await self._failed(code)

    async def run_stt(self, audio):
        async with self.lock:
            await self._sync_mode()
            if self.closed or self._muted: return
            if self.gate.input_blocked:
                await self._cancel_endpoint()
                self.preroll.clear()
                self.tokens.clear()
                self.wake.reset()
                if self.socket:
                    try: await self.socket.send(bytes(len(audio)))
                    except Exception: await self._failed()
                return
            if self.gate.generation != self.echo_generation:
                self.echo_generation = self.gate.generation
                self.preroll.clear()
                if self.gate.input_blocked:
                    self.tokens.clear()
                self.wake.reset()
            try:
                if self.attention.mode == 'background':
                    self.preroll.extend(audio)
                    del self.preroll[:-96000]  # At most 3 seconds, RAM only.
                    phrase = await asyncio.to_thread(self.wake.feed,audio)
                    if not phrase: return
                    self.attention.set_mode('active')
                    self.attention.wakes += 1
                    self.mode = 'active'
                    # Wake plus the start of a same-breath command goes once.
                    await self._connect()
                    self.wake_pending = True
                    await self.socket.send(bytes(self.preroll))
                    self.preroll.clear()
                else:
                    # Roll a long foreground stream between utterances, before
                    # the provider's five-hour cap. The native call/context stays.
                    if self.cloud_started is not None and time.monotonic()-self.cloud_started>=17400 and not self.turn_open:
                        await self._disconnect()
                    await self._connect()
                    await self.socket.send(audio)
            except Exception: await self._failed()
        if False: yield None  # STTService consumes an async generator.

    async def process_frame(self, frame, direction):
        if isinstance(frame,VADUserStartedSpeakingFrame):
            self.vad_speaking = True
        elif isinstance(frame,VADUserStoppedSpeakingFrame):
            self.vad_speaking = False
            self.vad_stopped_at = time.perf_counter()
        if isinstance(frame,STTMuteFrame) and frame.mute:
            async with self.lock:
                await self._disconnect()
                self.preroll.clear()
                self.wake.reset()
        await super().process_frame(frame,direction)

    async def _close(self):
        self.closed = True
        if self.monitor:
            self.monitor.cancel()
            await asyncio.gather(self.monitor,return_exceptions=True)
            self.monitor = None
        async with self.lock:
            await self._disconnect()
            self.preroll.clear()
            self.wake.reset()
            self._api_key = ''

    async def stop(self, frame):
        await self._close()
        await super().stop(frame)

    async def cancel(self, frame):
        await self._close()
        await super().cancel(frame)

    async def cleanup(self):
        await self._close()
        await super().cleanup()

