"""Local provisional EN/TR words. Never submits a user turn or replaces final ASR."""
from pathlib import Path
from functools import lru_cache
import json,re
import numpy as np

@lru_cache(maxsize=2)
def model(code):
    from vosk import Model,SetLogLevel
    SetLogLevel(-1)
    name='vosk-model-small-tr-0.3' if code=='tr' else 'vosk-model-small-en-us-0.15'
    return Model(str(Path.home()/'.dsh'/'hub-speech-streaming'/name))

class StreamingPreview:
    def __init__(self,language='auto'):
        from vosk import KaldiRecognizer
        codes=('en','tr') if language=='auto' else (language,)
        self.recognizers={code:KaldiRecognizer(model(code),16000) for code in codes}
        # Word-timestamp partials delay short TR utterances until alignment is
        # stable. Plain provisional words appear while the caller is speaking.
        for recognizer in self.recognizers.values():recognizer.SetWords(True);recognizer.SetPartialWords(False)
        self.committed={code:[] for code in codes}
        self.last=''

    def reset(self):
        for recognizer in self.recognizers.values():recognizer.Reset()
        self.committed={code:[] for code in self.recognizers};self.last=''

    def feed(self,audio,hint=None):
        samples=np.frombuffer(audio,dtype='<i2').astype(np.float32)
        peak=float(np.max(np.abs(samples))) if len(samples) else 0
        if peak and peak<8192:samples*=min(8,8192/peak)
        audio=np.clip(samples,-32767,32767).astype('<i2').tobytes()
        options=[]
        for code,recognizer in self.recognizers.items():
            ended=recognizer.AcceptWaveform(audio)
            result=json.loads(recognizer.Result() if ended else recognizer.PartialResult())
            value=result.get('text' if ended else 'partial','').strip()
            if ended and value:self.committed[code].append(value)
            text=' '.join(self.committed[code]+([] if ended else [value])).strip()
            if not text:continue
            words=result.get('result' if ended else 'partial_result',[])
            confidence=sum(w.get('conf',0) for w in words)/max(1,len(words))
            common={'tr':{'merhaba','selam','beni','bir','ben','sen','için','bu','evet','hayır','teşekkür','nasıl','tamam','şunu','bunu','istiyorum','dosya','yap'},'en':{'hello','hi','can','you','hear','me','please','the','i','what','yes','no','thanks','want','this','that','do'}}[code]
            tokens=set(re.findall(r'\w+',text.lower()))
            score=confidence+min(1,sum(word in common for word in tokens)*.22)+(.2 if hint==code else 0)
            if code=='tr' and re.search('[ğışçöü]',text):score+=.2
            if score<.21:continue  # Hide unsupported early guesses such as "my hobbies" for merhaba.
            options.append((score,code,text))
        if not options:return None
        _,code,text=max(options)
        if text==self.last:return None
        self.last=text
        return text,code
