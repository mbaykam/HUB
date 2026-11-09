"""Synthetic acoustic/transport fixtures, not a phone or microphone acceptance test."""
import asyncio
import sys
from pathlib import Path
import numpy as np
import pytest
sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'packages/harness-overlay/voice'))
from echo_audio import EchoAudioVerifier
from playback_guard import PlaybackGate,PlaybackInputGuard,PlaybackOutputProbe
from pipecat.frames.frames import InputAudioRawFrame,OutputAudioRawFrame,BotStartedSpeakingFrame,InterimTranscriptionFrame
from pipecat.processors.frame_processor import FrameDirection

def pcm(audio):return (np.clip(audio,-1,1)*32767).astype('<i2').tobytes()
def voice(seed,seconds=2,rate=16000):
    rng=np.random.default_rng(seed);t=np.arange(int(seconds*rate))/rate
    f=135+seed*27+22*np.sin(t*9+seed)
    phase=2*np.pi*np.cumsum(f)/rate
    envelope=(.25+.75*np.sin(t*11+seed)**2)*(.8+.2*np.sin(t*37))
    return envelope*(.3*np.sin(phase)+.12*np.sin(phase*2)+.06*np.sin(phase*3))+.004*rng.normal(size=len(t))

def test_delayed_gain_filtered_echo_is_detected_without_any_transcript_or_equal_words():
    now=[10.];v=EchoAudioVerifier(clock=lambda:now[0]);source=voice(1);v.render(pcm(source),16000)
    # A room/speaker response changes both amplitude and phase.
    filtered=np.convolve(source,[.38,.17,-.05,.08],mode='full')[:len(source)]
    mic=filtered[16000:16000+5120]
    assert v.echo_score(v.samples(pcm(mic),16000))>=.88
    assert not v.decide(pcm(mic),16000,speech=True)
    assert v.verdict=='echo' and v.rejected==1
    now[0]+=2;assert not v.watching

def test_independent_overlapping_voice_is_not_rejected_even_while_echo_is_present():
    v=EchoAudioVerifier();source=voice(1);v.render(pcm(source),16000)
    echo=source[16000:21120]*.4;human=voice(4,seconds=.32)*.9
    assert v.decide(pcm(echo+human),16000,speech=True)
    assert v.human and v.verdict=='human'

def test_reference_is_bounded_and_idle_silence_does_not_keep_verification_active():
    now=[10.];v=EchoAudioVerifier(clock=lambda:now[0]);v.render(pcm(np.zeros(16000)),16000);assert not v.watching
    v.render(pcm(voice(1,seconds=10)),16000);assert len(v.reference)<=4*v.rate
    now[0]+=2;v.render(pcm(np.zeros(16000)),16000);assert not v.watching
    v.clear();assert len(v.reference)==0

@pytest.mark.asyncio
async def test_provisional_audio_cannot_interrupt_on_a_different_stt_word_and_user_audio_is_replayed_once():
    gate=PlaybackGate(barge_in=True);gate.observe(BotStartedSpeakingFrame());gate.remember_spoken('Çikolata')
    source=voice(1);gate.acoustic.render(pcm(source),16000)
    guard=PlaybackInputGuard(gate);sent=[]
    async def push(frame,direction):sent.append(frame)
    guard.push_frame=push
    # The output-reference layer rejects the acoustic echo even when ASR would
    # turn the word into "çiçek"; no user-start signal is admitted during review.
    echo=source[16000:21120]*.4
    for chunk in np.array_split(echo,16):
        await guard.verify_audio(InputAudioRawFrame(audio=pcm(chunk),sample_rate=16000,num_channels=1),FrameDirection.DOWNSTREAM)
    assert not gate.accepts_transcript('çiçek',final=True)
    assert all(not any(f.audio) for f in sent)
    assert guard.pending_seconds<=.12+1e-6
    sent.clear();human=voice(4,seconds=.32)
    for chunk in np.array_split(human,16):
        frame=InputAudioRawFrame(audio=pcm(chunk),sample_rate=16000,num_channels=1)
        if not await guard.verify_audio(frame,FrameDirection.DOWNSTREAM):sent.append(frame)
    assert gate.acoustic.human
    assert gate.accepts_transcript('Çikolata',final=True),'A real user may repeat the assistant’s own word'
    nonzero=[f.audio for f in sent if any(f.audio)]
    assert b''.join(nonzero).endswith(pcm(human)),'Held first syllables must be replayed, not truncated'
    guard.clear_pending()

@pytest.mark.asyncio
async def test_output_probe_uses_sent_pcm_and_background_stays_noninterruptible():
    foreground=[True];gate=PlaybackGate(barge_in=True,foreground=lambda:foreground[0]);probe=PlaybackOutputProbe(gate)
    async def push(*args):pass
    probe.push_frame=push
    await probe.process_frame(OutputAudioRawFrame(audio=pcm(voice(1,seconds=.32)),sample_rate=16000,num_channels=1),FrameDirection.DOWNSTREAM)
    assert gate.acoustic.watching
    gate.acoustic.human=True;gate.observe(BotStartedSpeakingFrame());foreground[0]=False
    assert not gate.accepts_transcript('Stop now',final=True)
