"""Prepared weights survive calls; peer, native capability and turn state do not."""
import asyncio
import sys
from pathlib import Path
from contextlib import asynccontextmanager

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'packages/harness-overlay/voice'))
from runtime_server import create_runtime
from server import create_app
from test_sidecar import Bridge, Handler, worker

TOKEN = 'r' * 43
SPEECH = {'stt': {'engine': 'whisper', 'model': 'tiny.en'},
          'tts': {'engine': 'kokoro', 'model': '82m', 'voice': 'af_heart'}}


@pytest.mark.asyncio
async def test_child_task_group_lifetime_outlives_http_requests_and_starts_failure_is_sanitized():
    tasks = []
    def factory(call_id, token, speech):
        child = create_app(Bridge(), token, worker_factory=worker, request_handler=Handler())
        original = child.router.lifespan_context
        @asynccontextmanager
        async def lifetime(app):
            tasks.append(asyncio.current_task())
            if call_id == 'failed':raise RuntimeError('private start details')
            async with original(app):yield
            tasks.append(asyncio.current_task())
        child.router.lifespan_context = lifetime
        return child
    app = create_runtime('unused','b'*43,TOKEN,prepare=lambda _:None,call_factory=factory)
    owner = {'authorization':'Bearer '+TOKEN}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://127.0.0.1') as client:
            failed = await client.post('/admit',json={'callId':'failed','token':'a'*43,'speech':SPEECH},headers=owner)
            assert failed.status_code==503 and 'private' not in failed.text
            assert (await client.get('/status',headers=owner)).json()['active'] is False
            await asyncio.create_task(client.post('/admit',json={'callId':'owned','token':'c'*43,'speech':SPEECH},headers=owner))
            await asyncio.create_task(client.post('/release',json={'callId':'owned'},headers=owner))
            assert tasks[-1] is tasks[-2]
            assert tasks[-1] is not asyncio.current_task()


@pytest.mark.asyncio
async def test_weights_are_prepared_once_and_calls_have_fresh_capabilities():
    prepared, bridges, handlers = [], [], []

    def factory(call_id, token, speech):
        bridge, handler = Bridge(), Handler()
        bridges.append(bridge)
        handlers.append(handler)
        return create_app(bridge, token, worker_factory=worker, request_handler=handler)

    app = create_runtime('unused', 'b' * 43, TOKEN, prepare=lambda speech: prepared.append(speech), call_factory=factory)
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1') as client:
            owner = {'authorization': 'Bearer ' + TOKEN}
            assert (await client.post('/prepare', json={'speech': SPEECH})).status_code == 401
            assert (await client.post('/prepare', json={'speech': SPEECH}, headers=owner)).status_code == 200
            first = {'callId': 'call-one', 'token': 'a' * 43, 'speech': SPEECH}
            assert (await client.post('/admit', json=first, headers=owner)).status_code == 200
            assert len(prepared) == 1
            assert (await client.post('/admit', json=first, headers=owner)).status_code == 409
            assert (await client.post('/prepare', json={'speech': SPEECH}, headers=owner)).status_code == 409
            control = {'authorization': 'Bearer ' + first['token'], 'x-hub-runtime-call': first['callId']}
            response = await client.post('/call/offer', json={'type': 'offer', 'sdp': 'v=0\r\n'}, headers=control)
            assert response.status_code == 200
            # This fixture accepts SDP but has not emitted the ICE-connected
            # event; media readiness must not be fabricated by an HTTP answer.
            assert (await client.get('/call/status', headers=control)).json()['status'] == 'connecting'
            assert (await client.post('/release', json={'callId': 'foreign'}, headers=owner)).status_code == 409
            assert (await client.post('/release', json={'callId': first['callId']}, headers=owner)).status_code == 200
            assert bridges[0].closed == 1
            assert (await client.get('/call/status', headers=control)).status_code == 410
            second = {**first, 'callId': 'call-two', 'token': 'c' * 43}
            assert (await client.post('/admit', json=second, headers=owner)).status_code == 200
            assert len(prepared) == 1
            assert len(bridges) == 2
            assert (await client.get('/call/status', headers=control)).status_code == 409
            stale_token = {**control, 'x-hub-runtime-call': second['callId']}
            assert (await client.get('/call/status', headers=stale_token)).status_code == 401
            live = {'authorization': 'Bearer ' + second['token'], 'x-hub-runtime-call': second['callId']}
            assert (await client.get('/call/status', headers=live)).json()['audio'] is None
            assert (await client.get('/call/status', headers={**owner, 'x-hub-runtime-call': second['callId']})).status_code == 401
            assert (await client.post('/release', json={'callId': second['callId']}, headers=owner)).status_code == 200
            assert bridges[1].closed == 1
            assert (await client.get('/status', headers=owner)).json()['prepared'] is True


@pytest.mark.asyncio
async def test_failed_warmup_never_creates_a_call_and_profile_change_prepares_again():
    attempts, made = [], []

    def prepare(speech):
        attempts.append(speech)
        if speech['tts']['voice'] == 'bad':
            raise RuntimeError('private path or capability must not be returned')

    def factory(call_id, token, speech):
        made.append(call_id)
        return create_app(Bridge(), token, worker_factory=worker, request_handler=Handler())

    app = create_runtime('unused', 'b' * 43, TOKEN, prepare=prepare, call_factory=factory)
    owner = {'authorization': 'Bearer ' + TOKEN}
    async with app.router.lifespan_context(app):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://127.0.0.1') as client:
            bad = {**SPEECH, 'tts': {**SPEECH['tts'], 'voice': 'bad'}}
            response = await client.post('/admit', headers=owner, json={'callId': 'bad-call', 'token': 'a' * 43, 'speech': bad})
            assert response.status_code == 503
            assert 'private' not in response.text
            assert not made
            assert (await client.post('/prepare', headers=owner, json={'speech': SPEECH})).status_code == 200
            changed = {**SPEECH, 'tts': {**SPEECH['tts'], 'voice': 'bf_emma'}}
            assert (await client.post('/prepare', headers=owner, json={'speech': changed})).status_code == 200
            assert len(attempts) == 3
            for body in ({'speech': SPEECH, 'exec': 'no'}, {'speech': {}}):
                assert (await client.post('/prepare', headers=owner, json=body)).status_code == 400
            assert (await client.get('/status', headers={**owner, 'origin': 'https://foreign.example'})).status_code == 401
