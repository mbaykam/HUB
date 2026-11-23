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
# Whole-video overview: a few moments where the picture changes, on one or
# two contact sheets, plus the words (captions first, local speech otherwise).
OVERVIEW_BYTES = 300_000_000
OVERVIEW_SECONDS = 3 * 3600
TRANSCRIBE_SECONDS = 3600
TRANSCRIPT_CHARS = 14_000


def canonical_url(value):
    url = urlparse(value)
    if url.scheme != 'https' or url.username or url.password or url.port not in (None, 443):
        raise ValueError('Use a public HTTPS reel or video link')
    host = (url.hostname or '').lower()
    import re
    if host in ('instagram.com', 'www.instagram.com'):
        match = re.fullmatch(r'/(reel|reels|p|tv)/([A-Za-z0-9_-]{1,100})/?', url.path)
        if match:
            return 'https://www.instagram.com/' + ('reel' if match[1] == 'reels' else match[1]) + '/' + match[2] + '/'
    if host in ('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'):
        from urllib.parse import parse_qs
        if host == 'youtu.be':
            key = url.path[1:]
        else:
            match = re.fullmatch(r'/(?:shorts|live|embed)/([A-Za-z0-9_-]{11})/?', url.path)
            key = match[1] if match else parse_qs(url.query).get('v', [''])[0]
        if re.fullmatch(r'[A-Za-z0-9_-]{11}', key):
            return 'https://www.youtube.com/watch?v=' + key
    if host in ('tiktok.com', 'www.tiktok.com', 'm.tiktok.com'):
        match = re.fullmatch(r'/@([A-Za-z0-9_.]{1,60})/video/(\d{5,30})/?', url.path)
        if match:
            return 'https://www.tiktok.com/@' + match[1] + '/video/' + match[2]
    if host in ('vm.tiktok.com', 'vt.tiktok.com'):
        match = re.fullmatch(r'/([A-Za-z0-9]{5,20})/?', url.path)
        if match:
            return 'https://' + host + '/' + match[1] + '/'
    if host in ('x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com'):
        match = re.fullmatch(r'/([A-Za-z0-9_]{1,30})/status/(\d{5,30})(?:/video/\d)?/?', url.path)
        if match:
            return 'https://x.com/' + match[1] + '/status/' + match[2]
    if host in ('vimeo.com', 'www.vimeo.com'):
        match = re.fullmatch(r'/(\d{4,15})/?', url.path)
        if match:
            return 'https://vimeo.com/' + match[1]
    raise ValueError('Supported links: public YouTube, Instagram, TikTok, X and Vimeo videos. Attach other videos in HUB.')


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

    def fetch(fmt, name):
        with YoutubeDL(dict(quiet=True, logger=Quiet(), noplaylist=True, playlistend=1,
                            plugin_dirs=[], cachedir=False, socket_timeout=8, retries=1,
                            extractor_retries=0, fragment_retries=0, max_filesize=MAX_BYTES,
                            format=fmt, outtmpl=str(directory/(name + '.%(ext)s')), restrictfilenames=True,
                            progress_hooks=[bounded], match_filter=duration,
                            enable_file_urls=False, external_downloader={}, postprocessors=[])) as downloader:
            try:
                info = downloader.extract_info(source, download=True)
            except Exception as error:
                if 'format is not available' in str(error):
                    return None, None
                raise
            if not info or info.get('_type') in ('playlist', 'multi_video'):
                raise ValueError('Choose one video or attach its file')
            path = Path(downloader.prepare_filename(info)).resolve()
            if path.parent != directory.resolve():
                raise ValueError('The platform did not provide a downloadable video')
            # yt-dlp skips files over max_filesize without raising.
            return (path if path.is_file() else None), str(info.get('title') or 'Public video')[:200]

    source = canonical_url(url)
    # One small file with picture and sound when the platform offers it.
    path, title = fetch('best[height<=720][ext=mp4]/best[height<=720]', 'source')
    if path:
        return path, None, title
    # Instagram often offers only full-size combined files (over the limit)
    # plus separate small picture and sound tracks: take those separately.
    video, title = fetch('bv[height<=960][ext=mp4]/bv[height<=960]/wv', 'source-video')
    if video:
        audio, _ = fetch('ba[ext=m4a]/ba', 'source-audio')
        return video, audio, title
    path, title = fetch('worst[ext=mp4]/worst', 'source')
    if path:
        return path, None, title
    raise ValueError('The platform did not provide a video under 25 MB; attach a shorter clip')


def inspect(job):
    import av
    import numpy as np
    output = Path(job['outDir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    start, seconds = float(job.get('startSeconds', 0)), float(job.get('durationSeconds', 60))
    if not math.isfinite(start) or not math.isfinite(seconds) or not 0 <= start <= 3600 or not 1 <= seconds <= MAX_SECONDS:
        raise ValueError('Choose a start time and a clip of 1–120 seconds')
    path, sound, title = (acquire(job['url'], output) if job.get('url') else (Path(job['inputPath']).resolve(), None, 'Attached media'))
    def load(item):
        if item.is_symlink() or not item.is_file() or not 0 < item.stat().st_size <= MAX_BYTES:
            raise ValueError('Use a regular video/audio attachment under 25 MB')
        return item.read_bytes()
    # Decode bytes, with external protocols disabled. A media file cannot load
    # an HLS playlist, local companion file or remote URL through the decoder.
    data = load(path)
    sound_data = load(sound) if sound else data
    def container(source=None):
        media = av.open(io.BytesIO(source or data), mode='r', options={'protocol_whitelist': 'pipe', 'enable_drefs': '0', 'use_absolute_path': '0'})
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
    with container(sound_data) as media:
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


def _downloader(directory, limit, **extra):
    sys.path.insert(0, str(Path.home()/'.dsh'/'hub-media'/'python'))
    from yt_dlp import YoutubeDL

    class Quiet:
        def debug(self, *_): pass
        def warning(self, *_): pass
        def error(self, *_): pass

    def too_long(info, *, incomplete=False):
        if (info.get('duration') or 0) > OVERVIEW_SECONDS:
            return 'Video is longer than three hours'
    return YoutubeDL(dict(quiet=True, logger=Quiet(), noplaylist=True, playlistend=1, plugin_dirs=[], cachedir=False,
                          socket_timeout=10, retries=2, extractor_retries=1, fragment_retries=2, max_filesize=limit,
                          restrictfilenames=True, match_filter=too_long, enable_file_urls=False,
                          external_downloader={}, postprocessors=[], **extra))


def _pick_caption(info):
    """The original-language captions: written ones first, then automatic ones (never machine translations)."""
    spoken = (info.get('language') or '').split('-')[0]
    for key, automatic in (('subtitles', False), ('automatic_captions', True)):
        languages = [name for name in (info.get(key) or {}) if name != 'live_chat']
        if not languages:
            continue
        if automatic:
            original = [name for name in languages if name.endswith('-orig')]
            if original:
                return original[0], True
        for wanted in ([spoken] if spoken else []) + ['tr', 'en']:
            for name in languages:
                if name == wanted or (not automatic and name.startswith(wanted + '-')):
                    return name, automatic
        if not automatic:
            return languages[0], False
    return None, None


def _parse_vtt(text):
    import html
    import re
    stamp = re.compile(r'(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})\s+-->')
    cues, last, at = [], '', None
    for line in text.splitlines():
        found = stamp.match(line.strip())
        if found:
            at = int(found[1] or 0)*3600 + int(found[2])*60 + int(found[3]) + int(found[4])/1000
            continue
        if at is None:
            continue
        clean = html.unescape(re.sub(r'<[^>]+>', '', line)).strip()
        # Automatic captions roll: each cue repeats the line before it.
        if not clean or clean == last:
            continue
        last = clean
        cues.append((at, clean))
    return cues


def _clock(seconds):
    seconds = int(seconds)
    return f'{seconds//3600}:{seconds//60%60:02d}:{seconds%60:02d}' if seconds >= 3600 else f'{seconds//60}:{seconds%60:02d}'


def _transcript_text(cues):
    """Paragraphs of about 30 seconds, each with its start time; long videos are shortened evenly, not cut off."""
    paragraphs, start, words = [], None, []
    for at, text in cues:
        if start is not None and at - start >= 30:
            paragraphs.append((start, ' '.join(words)))
            start, words = None, []
        if start is None:
            start = at
        words.append(text)
    if words:
        paragraphs.append((start, ' '.join(words)))
    total = sum(len(text) + 10 for _, text in paragraphs)
    shortened = total > TRANSCRIPT_CHARS
    ratio = TRANSCRIPT_CHARS / total if shortened else 1
    lines = []
    for at, text in paragraphs:
        keep = max(100, int(len(text) * ratio))
        lines.append(f'[{_clock(at)}] ' + (text if len(text) <= keep else text[:keep].rsplit(' ', 1)[0] + ' …'))
    return '\n'.join(lines), shortened


def _acquire_overview(url, directory):
    """Captions when the platform has them, and a small copy of the picture (and the sound when there are no captions)."""
    source = canonical_url(url)
    with _downloader(directory, OVERVIEW_BYTES) as probe:
        info = probe.extract_info(source, download=False)
    if not info or info.get('_type') in ('playlist', 'multi_video'):
        raise ValueError('Choose one video or attach its file')
    title, duration = str(info.get('title') or 'Public video')[:200], info.get('duration')
    if duration and duration > OVERVIEW_SECONDS:
        raise ValueError('Video is longer than three hours')
    cues, caption_language = [], None
    language, automatic = _pick_caption(info)
    if language:
        try:
            with _downloader(directory, OVERVIEW_BYTES, skip_download=True, writesubtitles=not automatic,
                             writeautomaticsub=automatic, subtitleslangs=[language], subtitlesformat='vtt',
                             outtmpl=str(directory/'captions.%(ext)s')) as fetcher:
                fetcher.extract_info(source, download=True)
            for file in directory.glob('captions*.vtt'):
                if file.is_file() and not file.is_symlink() and file.stat().st_size < 20_000_000:
                    cues = _parse_vtt(file.read_text('utf-8', errors='replace'))
                    caption_language = language
                    break
        except Exception:
            cues = []

    def fetch(fmt, name):
        with _downloader(directory, OVERVIEW_BYTES, format=fmt, outtmpl=str(directory/(name + '.%(ext)s'))) as downloader:
            try:
                got = downloader.extract_info(source, download=True)
            except Exception as error:
                if 'format is not available' in str(error):
                    return None
                raise
            path = Path(downloader.prepare_filename(got)).resolve()
            if path.parent != directory.resolve():
                raise ValueError('The platform did not provide a downloadable video')
            return path if path.is_file() else None
    sound = None
    if (duration or 0) <= 600:
        picture = fetch('best[height<=480][ext=mp4]/best[height<=480]/worst[ext=mp4]/worst', 'source')
        if picture:
            return picture, None, title, cues, caption_language
    picture = fetch('bv[height<=360][ext=mp4]/bv[height<=360]/wv', 'source-video')
    if not cues:
        sound = fetch('wa[ext=m4a]/wa/ba[ext=m4a]/ba', 'source-audio')
    if not picture and not sound:
        raise ValueError('The platform did not provide this video')
    return picture, sound, title, cues, caption_language


def _open(data):
    import av
    media = av.open(io.BytesIO(data), mode='r', options={'protocol_whitelist': 'pipe', 'enable_drefs': '0', 'use_absolute_path': '0'})
    if not set(media.format.name.split(',')) & {'mov','mp4','m4a','3gp','3g2','mj2','matroska','webm','wav','mp3','ogg','flac'}:
        media.close()
        raise ValueError('Unsupported media container; attach MP4, MOV, WebM, WAV or MP3')
    return media


def _keyframes(data):
    """Moments spread over the whole video, preferring the ones where the picture changes most:
    twelve for a short video, twenty-four for one over ten minutes."""
    import numpy as np
    with _open(data) as media:
        total = float(media.duration / 1_000_000) if media.duration else None
        if not media.streams.video:
            return [], total, False
        video = media.streams.video[0]
        width, height = video.codec_context.width, video.codec_context.height
        if width * height > 4096*4096:
            raise ValueError('Video resolution exceeds the local inspection limit')
        if not total and video.duration:
            total = float(video.duration * video.time_base)
        span = total or 60
        video.codec_context.thread_count = 2
        origin = float((video.start_time or 0) * video.time_base)
        count = 48 if span > 60 else 24
        wanted = 24 if span > 600 else 12
        candidates = []
        for index in range(count):
            target = span * (index + .5) / count
            media.seek(int((target+origin)/video.time_base), stream=video, backward=True)
            for step, frame in enumerate(media.decode(video)):
                at = float(frame.time or 0) - origin
                if at + .05 < target and step < 600:
                    continue
                image = frame.to_image()
                # Phones store portrait video sideways with a turn to apply (counter-clockwise degrees, as PIL takes them).
                turn = round(getattr(frame, 'rotation', 0) or 0) % 360
                if turn in (90, 180, 270):
                    image = image.rotate(turn, expand=True)
                image.thumbnail((480, 480))
                small = np.asarray(image.convert('L').resize((32, 18)), dtype=np.float32)
                candidates.append((max(0, at), image, small))
                break
    chosen = [0] if candidates else []
    while len(chosen) < min(wanted, len(candidates)):
        best, score = None, -1.0
        for index in range(len(candidates)):
            if index in chosen:
                continue
            change = min(float(np.mean(np.abs(candidates[index][2] - candidates[other][2]))) for other in chosen)
            spread = min(abs(index - other) for other in chosen) / len(candidates)
            value = change * (.5 + spread)
            if value > score:
                best, score = index, value
        chosen.append(best)
    upright = bool(candidates) and candidates[0][1].height > candidates[0][1].width
    return [(candidates[i][0], candidates[i][1]) for i in sorted(chosen)], total, upright


def _contact_sheets(frames, upright, output):
    from PIL import Image, ImageDraw
    tile_w, tile_h, columns = (180, 320, 6) if upright else (320, 180, 4)
    per_sheet = columns * (2 if upright else 3)
    sheets = []
    for number, first in enumerate(range(0, len(frames), per_sheet)):
        group = frames[first:first + per_sheet]
        rows = -(-len(group) // columns)
        sheet = Image.new('RGB', (columns*tile_w, rows*tile_h), (0, 0, 0))
        draw = ImageDraw.Draw(sheet)
        for index, (at, image) in enumerate(group):
            tile = image.convert('RGB')
            tile.thumbnail((tile_w, tile_h))
            x, y = index % columns * tile_w, index // columns * tile_h
            sheet.paste(tile, (x + (tile_w - tile.width)//2, y + (tile_h - tile.height)//2))
            label = _clock(at)
            draw.rectangle([x + 3, y + 3, x + 9 + 7*len(label), y + 18], fill=(0, 0, 0))
            draw.text((x + 6, y + 5), label, fill=(255, 230, 0))
        name = f'sheet-{number}.jpg'
        sheet.save(output/name, quality=78)
        sheets.append({'file': name, 'seconds': [round(at, 1) for at, _ in group]})
    return sheets


def _speech(data, limit):
    import av
    import numpy as np
    audio, present = [], False
    with _open(data) as media:
        if media.streams.audio:
            present = True
            stream = media.streams.audio[0]
            stream.codec_context.thread_count = 2
            origin = float((stream.start_time or 0) * stream.time_base)
            resampler = av.AudioResampler(format='s16', layout='mono', rate=16000)
            collected = 0
            for frame in media.decode(stream):
                if float(frame.time or 0) - origin > limit:
                    break
                for item in resampler.resample(frame):
                    part = item.to_ndarray().reshape(-1)
                    audio.append(part)
                    collected += len(part)
                if collected >= limit*16000:
                    break
    if not present:
        return [], 'no audio stream', None
    if not audio:
        return [], 'audio present but empty', None
    samples = np.concatenate(audio).astype(np.float32)/32768
    if np.max(np.abs(samples), initial=0) < .008:
        return [], 'audio present; silence or too quiet to transcribe', None
    from faster_whisper import WhisperModel
    from speech_settings import whisper_path
    model = WhisperModel(str(whisper_path('base')), device='cpu', compute_type='int8', cpu_threads=4, local_files_only=True)
    segments, info = model.transcribe(samples, beam_size=1, language=None, vad_filter=True, condition_on_previous_text=False)
    cues = [(segment.start, segment.text.strip()) for segment in segments if segment.text.strip()]
    covered = len(samples)/16000
    note = 'local Whisper base; recognition can be imperfect' + (f'; only the first {_clock(limit)} was transcribed' if covered >= limit - 1 else '')
    return cues, note, info.language


def overview(job):
    output = Path(job['outDir']).resolve()
    output.mkdir(parents=True, exist_ok=True)
    warnings = []
    if job.get('url'):
        picture, sound, title, cues, language = _acquire_overview(job['url'], output)
        source_kind = 'captions' if cues else None
    else:
        picture, sound, title, cues, language, source_kind = Path(job['inputPath']).resolve(), None, 'Attached video', [], None, None

    def load(item):
        if item.is_symlink() or not item.is_file() or not 0 < item.stat().st_size <= OVERVIEW_BYTES:
            raise ValueError('Use a regular video/audio file under 300 MB')
        return item.read_bytes()
    picture_data = load(picture) if picture else None
    frames, total, upright = _keyframes(picture_data) if picture_data else ([], None, False)
    sheets = _contact_sheets(frames, upright, output) if frames else []
    audio_coverage = 'captions from the platform (' + str(language) + ')' if cues else 'not transcribed'
    if not cues and job.get('transcribe', True):
        sound_data = load(sound) if sound else picture_data
        if sound_data:
            try:
                cues, audio_coverage, language = _speech(sound_data, TRANSCRIBE_SECONDS)
                source_kind = 'local speech recognition' if cues else None
            except ModuleNotFoundError:
                warnings.append('Local transcription unavailable. The pictures do not establish spoken content; do not invent a transcript.')
    transcript, shortened = _transcript_text(cues)
    if shortened:
        warnings.append('The transcript was shortened evenly to stay small. Ask for a time range (startSeconds, durationSeconds) to read any part in full.')
    return dict(mode='overview', title=title, totalSeconds=total, sheets=sheets, transcript=transcript, transcriptSource=source_kind,
                language=language, audioCoverage=audio_coverage, warnings=warnings,
                coverage=f'{len(frames)} moments chosen across the whole video where the picture changes most, shown on contact sheets with their times. Motion between them was not seen; ask for a time range to look closer.')


if __name__ == '__main__':
    try:
        job = json.loads(sys.argv[1])
        print(json.dumps({'ok':True,**(overview(job) if job.get('mode') == 'overview' else inspect(job))},ensure_ascii=False))
    except Exception as error:
        # Remote extractor errors may contain signed URLs. Never forward them.
        category = 'runtime-dependency' if isinstance(error, ModuleNotFoundError) else 'platform-access' if type(error).__name__ == 'DownloadError' else 'unsupported-media' if isinstance(error, ValueError) else 'decode-failed'
        print(json.dumps({'ok':False,'category':category,'detail':'Could not inspect this media. The platform may require login or block downloads, the runtime may be unavailable, or the file exceeds supported limits. Attach an MP4/WebM clip (under 25 MB) in HUB and ask again. No video/audio was observed.'}))
        sys.exit(1)
