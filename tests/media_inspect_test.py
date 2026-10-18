"""Local decoder integration, synthetic frames/audio, no network or model API."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
import wave

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('hub_media',ROOT/'packages/harness-overlay/voice/media_inspect.py')
media=importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)


class MediaTest(unittest.TestCase):
    def test_urls(self):
        self.assertEqual(media.canonical_url('https://www.instagram.com/reel/abc/?tracking=yes'),'https://www.instagram.com/reel/abc/')
        for value in ['https://localhost/file','file:///private','https://user:pass@instagram.com/reel/a/']:
            with self.assertRaises(ValueError):media.canonical_url(value)

    def test_real_local_frames_and_partial_coverage(self):
        import av
        import numpy as np
        with tempfile.TemporaryDirectory(prefix='hub-media-local-') as folder:
            root=Path(folder)
            path=root/'synthetic.mp4'
            with av.open(str(path),'w') as out:
                stream=out.add_stream('mpeg4',rate=8)
                stream.width=160;stream.height=96;stream.pix_fmt='yuv420p'
                for i in range(48):
                    pixels=np.zeros((96,160,3),dtype=np.uint8)
                    pixels[:,:,0 if i<24 else 2]=220
                    for packet in stream.encode(av.VideoFrame.from_ndarray(pixels,format='rgb24')):out.mux(packet)
                for packet in stream.encode():out.mux(packet)
            report=media.inspect(dict(inputPath=str(path),outDir=str(root/'frames'),startSeconds=3,durationSeconds=2,transcribe=False))
            self.assertEqual(len(report['frames']),6)
            self.assertTrue(all(3<=f['seconds']<=5 for f in report['frames']))
            self.assertIn('sampled',report['coverage'])
            self.assertEqual(report['audioCoverage'],'no audio stream')
            from PIL import Image
            blue=np.asarray(Image.open(root/'frames'/report['frames'][0]['file'])).mean(axis=(0,1))
            self.assertGreater(blue[2],blue[0]+100)

    def test_silence_never_becomes_invented_transcript(self):
        with tempfile.TemporaryDirectory(prefix='hub-media-silence-') as folder:
            root=Path(folder);path=root/'silence.wav'
            with wave.open(str(path),'wb') as audio:
                audio.setnchannels(1);audio.setsampwidth(2);audio.setframerate(16000);audio.writeframes(b'\0\0'*32000)
            report=media.inspect(dict(inputPath=str(path),outDir=str(root/'out'),transcribe=True))
            self.assertEqual(report['transcript'],[])
            self.assertIn('silence',report['audioCoverage'])


if __name__=='__main__':unittest.main()
