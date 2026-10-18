"""Bounded local video/audio evidence. No browser cookies, login or cloud API."""
import io
import json
import math
import os
from pathlib import Path
import sys
from urllib.parse import urlparse

MAX_BYTES = 25_000_000
MAX_SECONDS = 120


def canonical_url(value):
    url = urlparse(value)
    if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443):
        raise ValueError('Use a public HTTPS reel or video link')
    host = (url.hostname or '').lower()
    import re
    if host in ('instagram.com', 'www.instagram.com'):
        match = re.fullmatch(r'/(reel|p)/([A-Za-z0-9_-]{1,100})/?', url.path)
        if match:
            return 'https://www.instagram.com/' + match[1] + '/' + match[2] + '/'
    if host in ('youtube.com', 'www.youtube.com', 'youtu.be'):
        from urllib.parse import parse_qs
        key = url.path[1:] if host == 'youtu.be' else parse_qs(url.query).get('v', [''])[0]
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', key):
            return 'https://www.youtube.com/watch?v=' + key
    raise ValueError('Supported links: public Instagram reels/posts and YouTube videos. Attach other videos in HUB.')


def acquire(url, directory):
    # The pinned downloader is isolated from the speech environment.
    sys.path.insert(0, str(Path.home()/'.dsh'/'hub-media'/'python'))
    from yt_dlp import YoutubeDL

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    def bounded(progress):
        if progress.get('downloaded_bytes', 0) > MAX_BYTES:
            raise ValueError('Video exceeds 25 MB; attach a shorter clip')

    def duration(info, *, incomplete=False):
        if (info.get('duration') or 0) > 180:
            return 'Video exceeds three minutes; attach the relevant clip'

    with YoutubeDL(dict(quiet=True, logger=Quiet(), noplaylist=True, playlistend=1,
                        plugin_dirs=[], cachedir=False, socket_timeout=8, retries=1,
                        extractor_retries=0, fragment_retries=0, max_filesize=MAX_BYTES,
                        format='best[height<=720][ext=mp4]/best[height<=720]',
                        outtmpl=str(directory/'source.%(ext)s'), restrictfilenames=True,
                        progress_hooks=[bounded], match_filter=duration,
                        enable_file_urls=False, external_downloader={}, postprocessors=[])) as downloader:
        info = downloader.extract_info(canonical_url(url), download=True)
        if not info or info.get('_type') in ('playlist', 'multi_video'):
            raise ValueError('Choose one video or attach its file')
        path = Path(downloader.prepare_filename(info)).resolve()
        if path.parent != directory.resolve() or not path.is_file():
            raise ValueError('The platform did not provide a downloadable video')
        return path, str(info.get('title') or 'Public video')[:200]


def inspect(job):
    import av
    import numpy as np
    output = Path(job['outDir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    start, seconds = float(job.get('startSeconds', 0)), float(job.get('durationSeconds', 60))
    if not math.isfinite(start) or not math.isfinite(seconds) or not 0 <= start <= 3600 or not 1 <= seconds <= MAX_SECONDS:
        raise ValueError('Choose a start time and a clip of 1–120 seconds')
    path, title = (acquire(job['url'], output) if job.get('url') else (Path(job['inputPath']).resolve(), 'Attached media'))
    if path.is_symlink() or not path.is_file() or not 0 < path.stat().st_size <= MAX_BYTES:
        raise ValueError('Use a regular video/audio attachment under 25 MB')
    # Decode bytes, with external protocols disabled. A media file cannot load
    # an HLS playlist, local companion file or remote URL through the decoder.
    data = path.read_bytes()
    def container():
        media = av.open(io.BytesIO(data), mode='r', options={'protocol_whitelist': 'pipe', 'enable_drefs': '0', 'use_absolute_path': '0'})
        if not set(media.format.name.split(',')) & {'mov','mp4','m4a','3gp','3g2','mj2','matroska','webm','wav','mp3','ogg','flac'}:
            media.close()
            raise ValueError('Unsupported media container; attach MP4, WebM, WAV or MP3')
        return media
    frames, warnings = [], []
    with container() as media:
        total = float(media.duration / av.time_base) if media.duration else None
        if total is not None and start >= total:
            raise ValueError('Start time is beyond the end of this media')
        end = min(start + seconds, total) if total else start + seconds
        if media.streams.video:
            video = media.streams.video[0]
            if video.codec_context.width * video.codec_context.height > 4096*4096:
                raise ValueError('Video resolution exceeds the local inspection limit')
            video.codec_context.thread_count = 2
            origin = float((video.start_time or 0) * video.time_base)
            for index in range(6):
                target = start + (end-start)*index/6
                media.seek(int((target+origin)/video.time_base), stream=video, backward=True)
                for count, frame in enumerate(media.decode(video)):
                    at = float(frame.time or 0) - origin
                    if at + .02 < target and count < 1200:
                        continue
                    if at > end or count >= 1200:
                        break
                    image = frame.to_image()
                    image.thumbnail((768,768))
                    name = f'frame-{index}.jpg'
                    image.convert('RGB').save(output/name, quality=80)
                    frames.append({'file':name,'seconds':round(at,3)})
                    break
    audio, audio_present = [], False
    with container() as media:
        if media.streams.audio:
            audio_present = True
            stream = media.streams.audio[0]
            stream.codec_context.thread_count = 2
            origin = float((stream.start_time or 0) * stream.time_base)
            media.seek(int((start+origin)/stream.time_base), stream=stream, backward=True)
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            collected = 0
            for frame in media.decode(stream):
                at = float(frame.time or 0) - origin
                if at > end:
                    break
                for item in resampler.resample(frame):
                    samples = item.to_ndarray().reshape(-1)
                    skip = max(0, round((start-at)*16000))
                    take = min(len(samples), round((end-at)*16000))
                    part = samples[skip:take]
                    audio.append(part)
                    collected += len(part)
                if collected >= MAX_SECONDS*16000:
                    break
    transcript = []
    audio_coverage = 'no audio stream' if not audio_present else 'not transcribed'
    if audio and job.get('transcribe', True):
        samples = np.concatenate(audio).astype(np.float32)/32768
        if np.max(np.abs(samples), initial=0) < .008:
            audio_coverage = 'audio present; silence or too quiet to transcribe'
        else:
            try:
                from faster_whisper import WhisperModel
                from speech_settings import whisper_path
                model = WhisperModel(str(whisper_path('base')),device='cpu',compute_type='int8',cpu_threads=2,local_files_only=True)
                for offset in range(0,len(samples),20*16000):
                    segments, info = model.transcribe(samples[offset:offset+20*16000],beam_size=1,language=None,vad_filter=True,condition_on_previous_text=False)
                    for segment in segments:
                        if segment.text.strip():
                            transcript.append({'start':round(start+offset/16000+segment.start,2),'end':round(start+offset/16000+segment.end,2),'language':info.language,'text':segment.text.strip()[:1500]})
                audio_coverage = 'local Whisper base, automatically detected language per 20-second section; recognition can be imperfect'
            except Exception:
                warnings.append('Local transcription unavailable. The frames do not establish spoken content; do not invent a transcript.')
    return dict(title=title,totalSeconds=total,clip={'start':start,'end':end},frames=frames,transcript=transcript[:200],audioCoverage=audio_coverage,warnings=warnings,coverage='Six sampled frames at most; motion between frames and any unsampled interval were not observed.')


if __name__ == '__main__':
    try:
        print(json.dumps({'ok':True,**inspect(json.loads(sys.argv[1]))},ensure_ascii=False))
    except Exception as error:
        # Remote extractor errors may contain signed URLs. Never forward them.
        category = 'runtime-dependency' if isinstance(error, ModuleNotFoundError) else 'platform-access' if type(error).__name__ == 'DownloadError' else 'unsupported-media' if isinstance(error, ValueError) else 'decode-failed'
        print(json.dumps({'ok':False,'category':category,'detail':'Could not inspect this media. The platform may require login or block downloads, the runtime may be unavailable, or the file exceeds supported limits. Attach an MP4/WebM clip (under 25 MB) in HUB and ask again. No video/audio was observed.'}))
        sys.exit(1)
