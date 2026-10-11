"""Private Telegram PCM transport. No desktop audio devices or virtual cables."""
import asyncio
import os
import time
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.base_input import BaseInputTransport
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.audio.resamplers.soxr_stream_resampler import SOXRStreamAudioResampler
from pipecat.audio.mixers.base_audio_mixer import BaseAudioMixer
from pytgcalls.types import Device

class ContinuousAudioMixer(BaseAudioMixer):
    """Use Pipecat's existing mixer clock to also produce silence when idle."""
    async def start(self, sample_rate):
        pass
    async def stop(self):
        pass
    async def process_frame(self, frame):
        pass
    async def mix(self, audio):
        return audio

class TelegramInput(BaseInputTransport):
    def __init__(self, params, owner):
        super().__init__(params)
        self.owner = owner

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)
        await self.owner.activate_input()
        await self.owner._call_event_handler("on_client_connected", self.owner)

class TelegramOutput(BaseOutputTransport):
    def __init__(self, params, owner):
        super().__init__(params)
        self.owner = owner
        self.deadline = None
        self.pending = bytearray()

    async def start(self, frame):
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame):
        if not self.owner.ready:
            return False
        if frame.sample_rate != 48000 or frame.num_channels != 1:
            raise ValueError("Telegram output must be 48 kHz mono PCM")
        self.pending.extend(frame.audio)
        while len(self.pending) >= 960:
            # NTgCalls 2.x AudioStreamer consumes exactly 10 ms regardless of
            # the buffer's length. A 20 ms buffer silently loses its latter
            # half. Always supply 480 samples / 960 bytes, including silence.
            now = time.perf_counter()
            if self.deadline is None or now - self.deadline > .1:
                self.deadline = now
            delay = self.deadline - now
            if delay > 0:
                if os.name == "nt":
                    # Python 3.12's Windows asyncio clock has 15.625 ms
                    # granularity. time.sleep uses a high-resolution waitable
                    # timer; keep it off the event loop and retain phase.
                    await asyncio.to_thread(time.sleep, delay)
                else:
                    await asyncio.sleep(delay)
            chunk = bytes(self.pending[:960]); del self.pending[:960]
            await self.owner.calls.send_frame(self.owner.peer, Device.MICROPHONE, chunk)
            self.deadline += .01
        return True

class TelegramTransport(BaseTransport):
    def __init__(self, calls, peer):
        super().__init__()
        self.calls, self.peer, self.ready = calls, peer, False
        self.receive_lock=asyncio.Lock();self.pre_ready=[];self.pre_ready_bytes=0;self.closed=False
        self.resampler = SOXRStreamAudioResampler(quality="HQ", clear_after_secs=None)
        params = TransportParams(audio_in_enabled=True, audio_out_enabled=True,
                                 audio_in_sample_rate=16000, audio_out_sample_rate=48000,
                                 audio_in_channels=1, audio_out_channels=1, audio_out_10ms_chunks=1,
                                 audio_out_mixer=ContinuousAudioMixer())
        self._input, self._output = TelegramInput(params, self), TelegramOutput(params, self)
        self._register_event_handler("on_client_connected")
        self._register_event_handler("on_client_disconnected")

    def input(self):
        return self._input

    def output(self):
        return self._output

    async def receive(self, audio):
        if self.closed or not (0<len(audio)<=192000 and len(audio)%2==0):return
        async with self.receive_lock:
            if not self.ready:
                self.pre_ready.append(bytes(audio));self.pre_ready_bytes+=len(audio)
                while self.pre_ready_bytes>192000:self.pre_ready_bytes-=len(self.pre_ready.pop(0))
                return
            await self._receive(audio)

    async def activate_input(self):
        async with self.receive_lock:
            if self.closed:return
            self.ready=True;pending=self.pre_ready;self.pre_ready=[];self.pre_ready_bytes=0
            for audio in pending:
                await self._receive(audio)
                await asyncio.sleep(0)

    async def _receive(self,audio):
        if self.ready:
            if self._input._audio_in_queue.qsize() >= 100:
                return  # Bound latency and memory if an audio consumer stalls.
            converted = await self.resampler.resample(audio, 48000, 16000)
            if converted:
                await self._input.push_audio_frame(InputAudioRawFrame(audio=converted, sample_rate=16000, num_channels=1))

    async def disconnect(self):
        self.closed=True
        self.ready = False
        self.pre_ready.clear();self.pre_ready_bytes=0
        await self._call_event_handler("on_client_disconnected", self)
