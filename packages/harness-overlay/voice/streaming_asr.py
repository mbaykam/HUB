"""A local, per-utterance multilingual streaming recognizer. No audio capture."""
from functools import lru_cache
import re
import numpy as np
from speech_settings import nemotron_path, whisper_path, seda_path


@lru_cache(maxsize=1)
def nemotron_runtime():
    import sherpa_onnx
    root = nemotron_path()
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(root/'tokens.txt'), encoder=str(root/'encoder.int8.onnx'),
        decoder=str(root/'decoder.int8.onnx'), joiner=str(root/'joiner.int8.onnx'),
        num_threads=4, sample_rate=16000, decoding_method='greedy_search')


def speech_gain(samples):
    """Bounded gain for low-volume speech; never convert digital silence to noise."""
    samples = np.asarray(samples, dtype=np.float32)
    peak = float(np.max(np.abs(samples))) if samples.size else 0
    if .0001 < peak < .12:
        samples = samples * min(32.0, .12/peak)
    return samples


@lru_cache(maxsize=1)
def seda_runtime():
    import sherpa_onnx
    root=seda_path()
    return sherpa_onnx.OnlineRecognizer.from_transducer(tokens=str(root/'tokens.txt'),
        encoder=str(root/'encoder.int8.onnx'),decoder=str(root/'decoder.onnx'),
        joiner=str(root/'joiner.int8.onnx'),num_threads=1,decoding_method='greedy_search')


def verify_turkish(audio):
    runtime=seda_runtime();stream=runtime.create_stream()
    samples=np.frombuffer(audio,dtype='<i2').astype(np.float32)/32768
    for offset in range(0,len(samples),3200):
        stream.accept_waveform(16000,speech_gain(samples[offset:offset+3200]))
        while runtime.is_ready(stream):runtime.decode_stream(stream)
    stream.accept_waveform(16000,np.zeros(16000,dtype=np.float32));stream.input_finished()
    while runtime.is_ready(stream):runtime.decode_stream(stream)
    return runtime.get_result(stream).strip()


class StreamingRecognizer:
    def __init__(self, language='auto'):
        if language not in ('auto', 'en', 'tr'):
            raise ValueError('Unsupported recognition language')
        self.runtime = nemotron_runtime()
        self.language = language
        # Streaming auto language identification can drop lone greetings. Keep
        # the existing offline verifier for short/empty utterances. Only its
        # decoded audio, never a provisional guess, can start assistant work.
        from whisper_auto import AutomaticWhisperSTTService
        from pipecat.services.whisper.stt import WhisperSTTService
        self.verifier = AutomaticWhisperSTTService(device='cpu', compute_type='int8', beam_size=1,
            settings=WhisperSTTService.Settings(model=str(whisper_path('base')),
                language=None if language=='auto' else language))
        seda_runtime()
        self.reset()

    def reset(self):
        self.stream = self.runtime.create_stream()
        self.stream.set_option('language', self.language)
        self.audio = bytearray()
        self.audio_bytes = 0
        self.result_language = None
        self._final_text = None
        if self.verifier._preview:
            self.verifier._preview.reset()
        self.verifier._preview_language = None
        self.verifier._preview_words = ''

    def feed(self, audio):
        self.audio_bytes += len(audio)
        if self.audio_bytes <= 16000*2*6:
            self.audio.extend(audio)
        samples = np.frombuffer(audio, dtype='<i2').astype(np.float32)/32768
        self.stream.accept_waveform(16000, speech_gain(samples))
        while self.runtime.is_ready(self.stream):
            self.runtime.decode_stream(self.stream)
        draft = self.runtime.get_result(self.stream).strip()
        if self.audio_bytes <= 16000*2*4 and self.verifier._preview:
            provisional = self.verifier._preview.feed(audio)
            if provisional:
                text, code = provisional
                self.verifier._preview_words = text
                self.verifier._preview_language = code
                return text
        return draft

    def finish(self, audio=None):
        segment = audio if audio is not None else bytes(self.audio) if self.audio_bytes <= 16000*2*6 else b''
        short=bool(segment) and self.audio_bytes <= 16000*2*4
        if short:
            turkish=verify_turkish(segment) if self.language!='en' else ''
            words=set(turkish.lower().split())
            greetings={'merhaba','selam'}
            greeting=bool(words) and words.issubset(greetings)
            # Two independent recognizers agreeing on distinctive Turkish
            # words can release the validated short turn immediately. A
            # provisional language guess alone cannot override English hello.
            distinctive={'merhaba','selam','beni','duyuyor','duyuyorum','musun','hayır','lütfen','istiyorum','şunu','bunu','teşekkürler','ederim'}
            draft=set(self.verifier._preview_words.lower().split())
            agreed=self.verifier._preview_language=='tr' and len(words & draft & distinctive)>=2
            if turkish and (self.language=='tr' or self.language=='auto' and (greeting or agreed)):
                self.stream.input_finished()
                self.result_language='tr'
                return turkish
            if self.language != 'tr' and self.verifier._preview_language == 'en' and self.verifier._preview:
                # Confirm the whole audio with both streaming decoders. Only
                # exact, high-confidence English agreement takes the fast path;
                # lone greetings, mixed/uncertain speech and changed words still
                # use Whisper. A provisional preview never becomes user input.
                native = self._finish_native()
                confirmed, confidence = self.verifier._preview.finish('en')
                words = re.findall(r'\w+', native.lower())
                english = {'i','you','can','hear','me','please','the','what','in','is','we','this','that','my','english','yes','no','want','stop','wait'}
                if (len(words) >= 3 and confidence >= .8 and
                        len(set(words) & english) >= 2 and
                        words == re.findall(r'\w+', confirmed.lower()) and
                        not re.search(r'[\dğışçöü]', native.lower())):
                    self.result_language = 'en'
                    return native
            verified, code=self.verifier._transcribe_audio(segment)
            if verified:
                if self._final_text is None:self.stream.input_finished()
                if turkish and self.language=='auto' and code=='tr':
                    self.result_language='tr'
                    return turkish
                self.result_language = code
                return verified
        # The streaming decoder has already processed long speech while the
        # caller spoke. Drain it only when no short-turn verifier succeeded.
        text = self._finish_native()
        if not text and segment and not short:
            verified, code=self.verifier._transcribe_audio(segment)
            self.result_language=code
            return verified
        return text

    def _finish_native(self):
        if self._final_text is None:
            self.stream.accept_waveform(16000, np.zeros(16000, dtype=np.float32))
            self.stream.input_finished()
            while self.runtime.is_ready(self.stream):self.runtime.decode_stream(self.stream)
            self._final_text = self.runtime.get_result(self.stream).strip()
        return self._final_text
