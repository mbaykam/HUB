"""Bounded, local render-reference verification; no speech recognition or storage.

Match microphone PCM against audio actually handed to playback. Delay/gain and
small room/speaker filtering are allowed; independent overlapping speech leaves
unexplained energy. This is echo evidence, not biometric speaker identification.
"""
import time
import numpy as np


class EchoAudioVerifier:
    rate = 4000
    window_seconds = .32

    def __init__(self, clock=time.perf_counter):
        self.clock = clock
        self.reference = np.empty(0, dtype=np.float32)
        self.last_render = float('-inf')
        self.human = False
        self.verdict = 'idle'
        self.checks = self.rejected = self.admitted = 0

    def samples(self, pcm, sample_rate, channels=1):
        audio = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
        if channels > 1:
            audio = audio[:len(audio)//channels*channels].reshape(-1,channels).mean(axis=1)
        if sample_rate % self.rate == 0:
            step = sample_rate//self.rate
            return audio[:len(audio)//step*step].reshape(-1,step).mean(axis=1)
        if not len(audio): return audio
        return np.interp(np.arange(0,len(audio),sample_rate/self.rate),np.arange(len(audio)),audio).astype(np.float32)

    def render(self, pcm, sample_rate, channels=1):
        audio = self.samples(pcm,sample_rate,channels)
        if len(audio):
            sounding=bool(np.any(np.abs(audio)>1e-5))
            if not len(self.reference):
                if not sounding:return
                # Capture can initially precede the first delayed render packet.
                self.reference=np.zeros(self.rate//2,dtype=np.float32)
            self.reference = np.concatenate((self.reference,audio))[-4*self.rate:]
            if sounding:self.last_render = self.clock()

    @property
    def watching(self):
        return len(self.reference) >= 80 and self.clock()-self.last_render <= 1.5

    def reset_admission(self):
        self.human = False
        self.verdict = 'checking' if self.watching else 'idle'

    def echo_score(self, candidate):
        """Predict an independent held-out half, not just a shared loudness level."""
        y = np.asarray(candidate,dtype=np.float64)
        if len(y)<self.rate*.12 or len(self.reference)<len(y): return 0.0
        y = y-y.mean()
        energy = float(y@y)
        if energy < len(y)*1e-8: return 0.0
        reference = self.reference.astype(np.float64)
        n = 1 << (len(reference)+len(y)-1).bit_length()
        correlation = np.fft.irfft(np.fft.rfft(reference,n)*np.fft.rfft(y[::-1],n),n)[len(y)-1:len(reference)]
        sums = np.concatenate(([0.],np.cumsum(reference)))
        squares = np.concatenate(([0.],np.cumsum(reference*reference)))
        powers = np.maximum(1e-12,squares[len(y):]-squares[:-len(y)]-(sums[len(y):]-sums[:-len(y)])**2/len(y))
        similarities = np.abs(correlation)/np.sqrt(powers*energy)
        lag = int(np.argmax(similarities)); direct = min(1.,float(similarities[lag]))
        if direct >= .95: return direct*direct
        if direct < .4: return 0.0
        # A short FIR accommodates phase/EQ/early reflections. Fit and validate
        # on different audio so unrelated speech cannot be explained by overfit.
        taps = 32
        if len(reference)<len(y)+taps: return direct*direct
        start = max(0,min(lag-taps//2,len(reference)-len(y)-taps))
        segment = reference[start:start+len(y)+taps-1]
        x = np.lib.stride_tricks.sliding_window_view(segment,taps)
        half = len(y)//2
        coefficients = np.linalg.lstsq(x[:half],y[:half],rcond=1e-4)[0]
        prediction = x@coefficients
        scores=[]
        for part in (slice(None,half),slice(half,None)):
            target=y[part];residual=target-prediction[part]
            scores.append(1-float(residual@residual)/max(1e-12,float(target@target)))
        return max(0.,min(1.,min(scores)))

    def decide(self, pcm, sample_rate, channels=1, *, speech=True):
        self.checks += 1
        candidate=self.samples(pcm,sample_rate,channels)
        score=self.echo_score(candidate)
        if score>=.88:
            self.verdict='echo';self.rejected+=1;return False
        if not speech or not len(candidate) or float(np.mean(candidate*candidate))<1e-7:
            self.verdict='silence';return False
        self.verdict='human';self.human=True;self.admitted+=1;return True

    def clear(self):
        self.reference=np.empty(0,dtype=np.float32);self.last_render=float('-inf');self.reset_admission()

    def snapshot(self):
        return {'state':self.verdict if self.watching else 'idle','windowMs':320,
                'checkedWindows':self.checks,'echoWindows':self.rejected,'acceptedWindows':self.admitted}
