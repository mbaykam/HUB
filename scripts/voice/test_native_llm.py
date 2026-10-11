"""No microphone, model calls or private host access; stock Pipecat test pipeline."""

import asyncio
import sys
from pathlib import Path

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from pipecat.frames.frames import (
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    LLMServiceMetadataFrame,
    TTSSpeakFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.tests.utils import SleepFrame, run_test

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/harness-overlay/voice"))
from hub_native_llm import HubBridgeClient, HubBridgeError, HubNativeLLMService


class FakeBridge:
    def __init__(self, hang=False, fail=False):
        self.turns = []
        self.interrupted = []
        self.closed = 0
        self.hang = hang
        self.fail = fail

    async def heartbeat(self):
        pass

    async def turn(self, utterance, text):
        self.turns.append((utterance, text))
        if self.fail:
            raise HubBridgeError("synthetic backend secret")
        if self.hang:
            await asyncio.Event().wait()
        yield {"type": "text", "utterance": utterance, "text": "Hello."}
        yield {"type": "end", "utterance": utterance, "status": "completed"}

    async def interrupt(self, utterance):
        self.interrupted.append(utterance)

    async def close(self):
        self.closed += 1


@pytest.mark.asyncio
async def test_native_turn_uses_latest_transcript_and_keeps_audio_context_bounded():
    bridge = FakeBridge()
    context = LLMContext([
        {"role": "user", "content": "Old private history"},
        {"role": "assistant", "content": "Old answer"},
        {"role": "user", "content": " Hello "},
    ])
    down, _ = await run_test(
        HubNativeLLMService(bridge),
        frames_to_send=[LLMContextFrame(context), SleepFrame(sleep=0.05), LLMContextFrame(context)],
        expected_down_frames=[LLMServiceMetadataFrame, LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    assert bridge.turns == [(1, "Hello")]
    assert len(context.get_messages()) == 1
    assert bridge.closed == 1
    assert [x.text for x in down if isinstance(x, LLMTextFrame)] == ["Hello."]


@pytest.mark.asyncio
async def test_adjacent_unhandled_transcriptions_reach_one_native_turn_in_order():
    bridge = FakeBridge()
    context = LLMContext([
        {"role": "user", "content": "Old private history"},
        {"role": "assistant", "content": "Old answer"},
        {"role": "user", "content": "What is two plus two?"},
        {"role": "user", "content": "Please answer with just the number."},
    ])
    await run_test(
        HubNativeLLMService(bridge),
        frames_to_send=[LLMContextFrame(context), SleepFrame(sleep=0.05), LLMContextFrame(context)],
        expected_down_frames=[LLMServiceMetadataFrame, LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame],
    )
    assert bridge.turns == [(1, "What is two plus two?\nPlease answer with just the number.")]
    assert len(context.get_messages()) == 1


@pytest.mark.asyncio
async def test_following_segment_never_replays_an_uncertain_prior_command():
    bridge = FakeBridge(fail=True)
    first = {"role": "user", "content": "First command"}
    second = {"role": "user", "content": "Second command"}
    await run_test(
        HubNativeLLMService(bridge),
        frames_to_send=[LLMContextFrame(LLMContext([first])), SleepFrame(sleep=0.05), LLMContextFrame(LLMContext([first, second]))],
    )
    assert bridge.turns == [(1, "First command"), (2, "Second command")]


@pytest.mark.asyncio
async def test_pipecat_interruption_reaches_only_native_foreground_utterance():
    bridge = FakeBridge(hang=True)
    await run_test(
        HubNativeLLMService(bridge),
        frames_to_send=[LLMContextFrame(LLMContext([{"role": "user", "content": "Hello"}])), SleepFrame(sleep=0.1), InterruptionFrame(), SleepFrame(sleep=0.1)],
        expected_down_frames=[LLMServiceMetadataFrame, LLMFullResponseStartFrame, InterruptionFrame],
    )
    assert bridge.interrupted == [1]
    assert bridge.closed == 1


@pytest.mark.asyncio
async def test_failed_turn_is_not_replayed_and_error_does_not_leak_backend_detail():
    bridge = FakeBridge(fail=True)
    down, up = await run_test(
        HubNativeLLMService(bridge),
        frames_to_send=[LLMContextFrame(LLMContext([{"role": "user", "content": "Hello"}]))],
    )
    assert bridge.turns == [(1, "Hello")]
    assert bridge.interrupted == [1]
    assert not any(isinstance(x, LLMTextFrame) for x in down)
    assert "synthetic backend secret" not in str(up)


@pytest.mark.parametrize("url", ["https://127.0.0.1:1", "http://example.com:1", "http://localhost:1", "http://user:pass@127.0.0.1:1", "http://127.0.0.1:1?token=x", "http://127.0.0.1:1/turn"])
def test_bridge_credentials_cannot_be_redirected_to_other_hosts(url):
    with pytest.raises(ValueError):
        HubBridgeClient(url, "a" * 43, "00000000-0000-4000-8000-000000000000")


@pytest.mark.asyncio
@pytest.mark.parametrize("wire", [
    '{"type":"text","utterance":99,"text":"Wrong turn"}\n',
    '{"type":"reasoning","utterance":1,"text":"Private thought"}\n',
    '{"type":"text","utterance":1,"text":"Partial"}\n',
    '{"type":"end","utterance":1,"status":"unrecognized"}\n',
    'not json\n',
])
async def test_http_client_rejects_mismatched_private_malformed_or_incomplete_streams(wire):
    async def handler(request):
        if request.path == "/turn":
            return web.Response(text=wire, content_type="application/x-ndjson")
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/{path}", handler)
    async with TestServer(app, host="127.0.0.1") as server:
        client = HubBridgeClient(str(server.make_url("/")), "a" * 43, "00000000-0000-4000-8000-000000000000")
        try:
            with pytest.raises(HubBridgeError):
                [event async for event in client.turn(1, "Hello")]
        finally:
            await client.close()
            await client.close()  # Closing must not recreate a new HTTP session.


@pytest.mark.asyncio
async def test_http_client_never_follows_redirect_with_its_capability():
    hits = []

    async def handler(request):
        hits.append(request.path)
        if request.path == "/turn":
            raise web.HTTPTemporaryRedirect("/stolen-capability")
        return web.json_response({"ok": True})

    app = web.Application()
    app.router.add_post("/{path}", handler)
    async with TestServer(app, host="127.0.0.1") as server:
        client = HubBridgeClient(str(server.make_url("/")), "a" * 43, "00000000-0000-4000-8000-000000000000")
        try:
            with pytest.raises(HubBridgeError):
                [event async for event in client.turn(1, "Hello")]
            assert hits == ["/turn"]
        finally:
            await client.close()


@pytest.mark.asyncio
async def test_task_result_is_spoken_once_after_the_user_stops_without_prompting_another_model():
    import time
    from speech_health import SpeechHealth
    state=SpeechHealth();state.user_speaking=True;state.last_loud_audio=time.perf_counter()
    class Results(FakeBridge):
        def __init__(self):super().__init__();self.polls=[]
        async def notifications(self,after):
            self.polls.append(after)
            return [{'id':1,'text':'The test task finished.'}] if after==0 else []
    bridge=Results()
    async def finish_speech():
        await asyncio.sleep(.65)
        assert not bridge.polls,'Do not poll or speak over a user utterance'
        state.user_speaking=False;state.last_loud_audio=time.perf_counter()-2
    release=asyncio.create_task(finish_speech())
    down,_=await run_test(HubNativeLLMService(bridge,health=state),frames_to_send=[SleepFrame(sleep=1.8)])
    await release
    assert [frame.text for frame in down if isinstance(frame,TTSSpeakFrame)]==['The test task finished.']
    assert not bridge.turns and not bridge.interrupted
    assert bridge.polls[0]==0 and all(cursor==1 for cursor in bridge.polls[1:])
    assert bridge.closed==1


@pytest.mark.asyncio
async def test_notification_client_reads_bounded_chunked_json_and_validates_cursor_order():
    import json
    async def handler(request):
        if request.path=='/notifications':
            body=await request.json();assert body=={'callId':'00000000-0000-4000-8000-000000000000','after':0}
            reply=web.StreamResponse(headers={'content-type':'application/json'});await reply.prepare(request)
            raw=json.dumps({'events':[{'id':1,'text':'Result ready.'}]}).encode()
            for offset in range(0,len(raw),5):await reply.write(raw[offset:offset+5]);await asyncio.sleep(.001)
            await reply.write_eof();return reply
        return web.json_response({'ok':True})
    app=web.Application();app.router.add_post('/{path}',handler)
    async with TestServer(app,host='127.0.0.1') as server:
        client=HubBridgeClient(str(server.make_url('/')),'a'*43,'00000000-0000-4000-8000-000000000000')
        try:assert await client.notifications(0)==[{'id':1,'text':'Result ready.'}]
        finally:await client.close()
