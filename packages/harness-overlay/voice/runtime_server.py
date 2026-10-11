"""Prepared local speech weights; fresh authenticated ASGI applications per call."""
import asyncio
from contextlib import asynccontextmanager
import json
import os
import re
import secrets
import socket
import time

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from hub_native_llm import HubBridgeClient
from server import create_app
from voice_pipeline import build_voice_worker, prepare_voice_models


def create_runtime(bridge_url, bridge_token, control_token, initial_speech=None,
                   *, prepare=prepare_voice_models, call_factory=None):
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", control_token):
        raise ValueError("An owned runtime capability is required")
    lock = asyncio.Lock()
    active = None
    prepared_key = None
    prepare_task = None
    prepare_ms = None
    closing = False

    def speech_key(speech):
        if not isinstance(speech, dict) or set(speech) != {'stt', 'tts'}:
            raise HTTPException(400, "Invalid speech configuration")
        encoded = json.dumps(speech, sort_keys=True, separators=(',', ':'))
        if len(encoded) > 4000:
            raise HTTPException(400, "Invalid speech configuration")
        return encoded

    async def warm(speech):
        nonlocal prepared_key, prepare_ms
        key = speech_key(speech)
        if key == prepared_key:
            return
        began = time.perf_counter()
        await asyncio.to_thread(prepare, speech)
        prepared_key = key
        prepare_ms = round((time.perf_counter() - began) * 1000)

    async def ready(speech):
        nonlocal prepare_task
        if prepare_task:
            try:
                await asyncio.shield(prepare_task)
            except Exception:
                pass  # An explicit preparation retries and reports failure.
            prepare_task = None
        await warm(speech)

    async def release():
        nonlocal active
        owned = active
        if owned is None:
            return
        # New admission remains serialized until the old call is quiescent.
        owned['stop'].set()
        await owned['task']
        active = None

    async def own_call(child, ready, stop):
        # A persistent owner enters/exits the child's TaskGroup in the same
        # task. An HTTP request ends long before this call's watchdog/runner.
        try:
            async with child.router.lifespan_context(child):
                ready.set_result(None)
                await stop.wait()
                await child.state.end_voice_call()
        except BaseException:
            if not ready.done():ready.set_exception(RuntimeError('Voice call could not start'))
            raise

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal prepare_task, closing
        if initial_speech is not None:
            prepare_task = asyncio.create_task(warm(initial_speech))
            # Readiness means HTTP is available. Model readiness is separate.
            prepare_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        try:
            yield
        finally:
            closing = True
            async with lock:
                await release()
            if prepare_task:
                await asyncio.gather(prepare_task, return_exceptions=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware('http')
    async def authorize(request, next_handler):
        if (request.client is None or request.client.host != '127.0.0.1'
                or request.url.hostname != '127.0.0.1' or 'origin' in request.headers
                or 'sec-fetch-site' in request.headers
                or not secrets.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + control_token)):
            return JSONResponse({'error': 'unauthorized'}, status_code=401)
        response = await next_handler(request)
        response.headers['Cache-Control'] = 'no-store'
        return response

    async def body(request):
        if request.headers.get('content-type', '').split(';')[0].strip() != 'application/json':
            raise HTTPException(415)
        data = bytearray()
        async for part in request.stream():
            data.extend(part)
            if len(data) > 16000:
                raise HTTPException(413)
        try:
            value = json.loads(data)
            if not isinstance(value, dict):
                raise ValueError()
            return value
        except (ValueError, UnicodeError):
            raise HTTPException(400) from None

    @app.get('/status')
    async def status():
        return {'status': 'waiting', 'prepared': prepared_key is not None,
                'prepareMs': prepare_ms, 'active': active is not None}

    @app.post('/prepare')
    async def prepare_request(request: Request):
        value = await body(request)
        if set(value) != {'speech'}:
            raise HTTPException(400)
        async with lock:
            if closing or active is not None:
                raise HTTPException(409)
            try:
                await ready(value['speech'])
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(503, 'Speech models could not prepare') from None
        return {'ok': True, 'prepareMs': prepare_ms}

    @app.post('/admit')
    async def admit(request: Request):
        nonlocal active
        value = await body(request)
        if set(value) != {'callId', 'token', 'speech'}:
            raise HTTPException(400)
        call_id, token = value['callId'], value['token']
        if (not isinstance(call_id, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,200}', call_id)
                or not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token)):
            raise HTTPException(400)
        async with lock:
            if closing or active is not None:
                raise HTTPException(409)
            try:
                await ready(value['speech'])
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(503, 'Speech models could not prepare') from None
            child = (call_factory(call_id, token, value['speech']) if call_factory else create_app(
                HubBridgeClient(bridge_url, bridge_token, call_id), token,
                worker_factory=lambda connection, bridge: build_voice_worker(connection, bridge, value['speech'])))
            child_ready = asyncio.get_running_loop().create_future()
            child_stop = asyncio.Event()
            child_task = asyncio.create_task(own_call(child, child_ready, child_stop))
            child_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
            active = {'id': call_id, 'app': child, 'stop': child_stop, 'task': child_task}
            try:
                await asyncio.shield(child_ready)
            except BaseException as error:
                child_stop.set()
                await asyncio.gather(child_task, return_exceptions=True)
                active = None
                if isinstance(error, asyncio.CancelledError):raise
                raise HTTPException(503, 'Voice call could not start') from None
        return {'ok': True, 'prepareMs': prepare_ms}

    @app.post('/release')
    async def release_request(request: Request):
        value = await body(request)
        if set(value) != {'callId'}:
            raise HTTPException(400)
        async with lock:
            if active is not None and value['callId'] != active['id']:
                raise HTTPException(409)
            await release()
        return {'ok': True}

    @app.post('/close')
    async def close_runtime():
        nonlocal closing
        closing = True
        async with lock:
            await release()
        return {'ok': True}

    class CallRouter:
        def __init__(self, app):
            self.app = app

        async def __call__(self, scope, receive, send):
            if scope['type'] == 'http' and scope['path'].startswith('/call/'):
                headers = dict(scope['headers'])
                owned = active
                if owned is None:
                    await JSONResponse({'error': 'call-ended'}, status_code=410)(scope, receive, send)
                    return
                if not secrets.compare_digest(headers.get(b'x-hub-runtime-call', b''), owned['id'].encode('ascii')):
                    await JSONResponse({'error': 'foreign-call'}, status_code=409)(scope, receive, send)
                    return
                # The child validates its fresh bearer capability and loopback
                # caller. Service-level credentials cannot control this call.
                await owned['app']({**scope, 'path': scope['path'][5:], 'raw_path': scope['path'][5:].encode()}, receive, send)
                return
            await self.app(scope, receive, send)

    app.add_middleware(CallRouter)
    return app


if __name__ == '__main__':
    import uvicorn
    from loguru import logger
    logger.remove()

    async def main():
        app = create_runtime(os.environ.pop('HUB_VOICE_BRIDGE_URL'), os.environ.pop('HUB_VOICE_BRIDGE_TOKEN'),
                             os.environ.pop('HUB_VOICE_CONTROL_TOKEN'), json.loads(os.environ.pop('HUB_VOICE_SPEECH', 'null')))
        os.environ.pop('HUB_VOICE_CALL_ID', None)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(('127.0.0.1', 0))
            sock.listen(128)

            class ReadyServer(uvicorn.Server):
                async def startup(self, sockets=None):
                    await super().startup(sockets=sockets)
                    if self.started:
                        print(json.dumps({'type': 'hub-voice-ready', 'port': sock.getsockname()[1]}), flush=True)

            await ReadyServer(uvicorn.Config(app, log_level='critical', access_log=False)).serve(sockets=[sock])

    asyncio.run(main())
