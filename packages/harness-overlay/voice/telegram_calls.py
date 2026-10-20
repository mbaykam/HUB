"""HUB-owned incoming-only Telegram user call listener, scoped to an allowlist."""
import asyncio
import json
import logging
import os
from pathlib import Path
import secrets
import socket
import time
from contextlib import asynccontextmanager

import aiohttp
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from telethon import TelegramClient
from pytgcalls import PyTgCalls, filters
from pytgcalls.types import ChatUpdate, Device, Direction, ExternalMedia, MediaStream, RecordStream, StreamFrames
from pytgcalls.types.raw import AudioParameters
from pipecat.workers.runner import WorkerRunner
from hub_native_llm import HubBridgeClient
from voice_pipeline import build_voice_worker, prepare_voice_models
from telegram_transport import TelegramTransport

async def main():
    account_path = Path(os.environ["HUB_TELEGRAM_CALL_ACCOUNT"])
    settings = json.loads(account_path.read_text(encoding="utf-8"))
    if (settings.get("session") != "account.session" or not isinstance(settings.get("allowedCallers"), list)
            or not 1 <= len(settings["allowedCallers"]) <= 20
            or any(type(peer) is not int or peer <= 0 for peer in settings["allowedCallers"])):
        raise ValueError("A configured incoming caller allowlist is required")
    client = TelegramClient(str(account_path.parent / "account.session"), settings["apiId"], settings["apiHash"],
                            device_model="HUB voice calls", system_version="Windows", app_version="0.4.12")
    # Logging third-party RPC failures can contain account identifiers.
    logging.getLogger("telethon").setLevel(logging.CRITICAL)
    logging.getLogger("pytgcalls").setLevel(logging.CRITICAL)
    await client.connect()
    if not await client.is_user_authorized() or (await client.get_me()).id != settings["accountId"]:
        raise ValueError("The provisioned call account is unavailable")
    calls = PyTgCalls(client)
    control = os.environ["HUB_VOICE_CONTROL_TOKEN"]
    url, token = os.environ["HUB_VOICE_BRIDGE_URL"], os.environ["HUB_VOICE_BRIDGE_TOKEN"]
    # Reuse bridge validation, without a call lease until an incoming call.
    validator = HubBridgeClient(url, token, os.environ["HUB_VOICE_CALL_ID"])
    state = {"status": "waiting", "callId": None, "peer": None, "worker": None, "transport": None, "bridge": None, "task": None, "error": None, "cancelled": False}
    lock = asyncio.Lock()
    prepared_speech = None
    initial_speech = json.loads(os.environ.pop('HUB_VOICE_SPEECH', 'null'))
    prepare_task = None

    async def prepare_speech(speech):
        nonlocal prepared_speech
        key = json.dumps(speech, sort_keys=True, separators=(',', ':'))
        if key != prepared_speech:
            await asyncio.to_thread(prepare_voice_models, speech)
            prepared_speech = key

    async def ensure_speech(speech):
        nonlocal prepare_task
        if prepare_task:
            try:
                await asyncio.shield(prepare_task)
            except Exception:
                pass  # Retry the selected profile after a failed initial warmup.
            prepare_task = None
        await prepare_speech(speech)

    async def finish(*, hangup=False):
        peer, worker, bridge, task = state["peer"], state["worker"], state["bridge"], state["task"]
        state["status"] = "closed"
        if state["transport"]:
            state["transport"].ready = False
        # Detach before cancellation: the runner's finally cannot deadlock on
        # this lock while an HTTP hangup waits for that runner to finish.
        state.update(peer=None, worker=None, transport=None, bridge=None, task=None)
        if worker:
            await worker.cancel(reason="Telegram call ended")
        if hangup and peer:
            try:
                await calls.leave_call(peer)
            except Exception:
                pass
        if bridge:
            try:
                await bridge.close()
            except Exception:
                pass  # Worker cleanup may already have closed this native lease.
        if task and task is not asyncio.current_task():
            await asyncio.wait_for(asyncio.shield(task), timeout=10)

    @calls.on_update(filters.chat_update(ChatUpdate.Status.INCOMING_CALL))
    async def incoming(_calls, update):
        # Do not answer other contacts or turn an existing call into a second AI.
        if update.chat_id not in settings["allowedCallers"] or lock.locked() or state["peer"] is not None:
            return
        async with lock:
            state.update(status="connecting", peer=update.chat_id, error=None, cancelled=False)
            try:
                async with aiohttp.ClientSession(trust_env=False) as http:
                    async with http.post(url.rstrip("/") + "/incoming", json={}, headers={"Authorization": "Bearer " + token},
                                         timeout=aiohttp.ClientTimeout(total=45), allow_redirects=False) as response:
                        if response.status != 200:
                            raise RuntimeError("HUB is busy or voice is unavailable")
                        admission = await response.json()
                state["callId"] = admission["callId"]
                bridge = HubBridgeClient(url, token, admission["callId"])
                state["bridge"] = bridge
                transport = TelegramTransport(calls, update.chat_id)
                state["transport"] = transport
                # Model loading can take several seconds on CPU. Keep MTProto
                # cancellation updates and the host's health probe responsive.
                await ensure_speech(admission["speech"])
                worker = await asyncio.to_thread(build_voice_worker, None, bridge, admission["speech"], transport=transport,
                                                soniox_api_key=admission.get('sonioxKey'))
                state["worker"] = worker
                if state["cancelled"]:
                    raise RuntimeError("The caller hung up during voice preparation")
                parameters = AudioParameters(bitrate=48000, channels=1)
                await asyncio.wait_for(calls.play(update.chat_id, MediaStream(ExternalMedia.AUDIO, parameters,
                                                            video_flags=MediaStream.Flags.IGNORE)), timeout=45)
                await calls.record(update.chat_id, RecordStream(True, parameters))
                state["status"] = "connected"
                async def run():
                    runner = WorkerRunner(handle_sigint=False)
                    try:
                        await runner.add_workers(worker)
                        await runner.run()
                    finally:
                        if state["worker"] is worker:
                            async with lock:
                                if state["worker"] is not worker:
                                    return
                                await finish(hangup=True)
                state["task"] = asyncio.create_task(run())
            except Exception:
                state["error"] = "call-connection-failed"
                await finish(hangup=True)

    @calls.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))
    async def audio(_calls, update: StreamFrames):
        transport = state["transport"]
        if transport and update.chat_id == state["peer"]:
            for frame in update.frames:
                await transport.receive(frame.frame)

    @calls.on_update(filters.chat_update(ChatUpdate.Status.DISCARDED_CALL))
    async def discarded(_calls, update):
        if update.chat_id == state["peer"]:
            state["cancelled"] = True
            async with lock:
                if update.chat_id == state["peer"]:
                    await finish()

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal prepare_task
        if initial_speech is not None:
            prepare_task = asyncio.create_task(prepare_speech(initial_speech))
            prepare_task.add_done_callback(lambda task: task.exception() if not task.cancelled() else None)
        await calls.start()
        try:
            yield
        finally:
            async with lock:
                await finish(hangup=True)
            if state["task"]:
                await state["task"]
            await client.disconnect()
            if prepare_task:
                await asyncio.gather(prepare_task, return_exceptions=True)
            # The dummy validator has never opened a network session.

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    @app.middleware("http")
    async def authorize(request: Request, next_handler):
        if (request.client is None or request.client.host != "127.0.0.1" or request.url.hostname != "127.0.0.1"
                or "origin" in request.headers or "sec-fetch-site" in request.headers
                or not secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + control)):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        result = await next_handler(request)
        result.headers["Cache-Control"] = "no-store"
        return result

    @app.get("/status")
    async def status():
        health = getattr(state["worker"], "speech_health", None)
        return {"status": state["status"], "error": state["error"], "audio": health.snapshot() if health else None}

    @app.post('/prepare')
    async def prepare_request(request: Request):
        raw = await request.body()
        if len(raw) > 8000:
            raise HTTPException(413)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {'speech'}:
                raise ValueError()
        except (ValueError, UnicodeError):
            raise HTTPException(400) from None
        async with lock:
            if state['peer'] is not None:
                raise HTTPException(409)
            try:
                await ensure_speech(value['speech'])
            except Exception:
                raise HTTPException(503, 'Speech models could not prepare') from None
        return {'ok': True}

    @app.post("/offer")
    async def close_call(request: Request):
        raw = await request.body()
        if len(raw) > 1024:
            raise HTTPException(413)
        try:
            body = json.loads(raw)
        except Exception:
            raise HTTPException(400) from None
        if body != {"action": "hangup", "callId": state["callId"]}:
            raise HTTPException(409)
        state["cancelled"] = True
        if lock.locked() and state["status"] == "connecting":
            # Reject the pending incoming phone call now, while the model-load
            # thread finishes. The admission callback will never answer it.
            try:
                await asyncio.wait_for(calls.leave_call(state["peer"]), timeout=3)
            except Exception:
                raise HTTPException(503) from None
            return {"ok": True}
        async with lock:
            await finish(hangup=True)
        return {"ok": True}

    @app.post("/close")
    async def close():
        async with lock:
            await finish(hangup=True)
        return {"ok": True}

    @app.post("/interrupt")
    async def interrupt(request: Request):
        if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            raise HTTPException(415)
        raw = await request.body()
        if len(raw) > 1024: raise HTTPException(413)
        try:
            body = json.loads(raw)
        except Exception:
            raise HTTPException(400) from None
        if body != {}: raise HTTPException(400)
        if state['status'] != 'connected' or not state['worker']:
            raise HTTPException(409)
        await state['worker'].interrupt_voice()
        return {"ok": True}

    @app.post('/attention')
    async def attention(request: Request):
        if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
            raise HTTPException(415)
        raw = await request.body()
        if len(raw) > 1024: raise HTTPException(413)
        try:
            value = json.loads(raw)
            if not isinstance(value, dict) or set(value) != {'mode'} or value['mode'] not in ('active', 'background'):
                raise ValueError()
        except (ValueError, UnicodeError):
            raise HTTPException(400) from None
        if state['status'] != 'connected' or not state['worker']:
            raise HTTPException(409)
        return {'attention': await state['worker'].set_attention(value['mode'])}

    import uvicorn
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    # The parent probes immediately on readiness. Bind alone leaves a window
    # where that first connection is refused before Uvicorn starts accepting.
    sock.listen(128)
    print(json.dumps({"type": "hub-voice-ready", "port": sock.getsockname()[1]}), flush=True)
    await uvicorn.Server(uvicorn.Config(app, log_level="critical", access_log=False)).serve(sockets=[sock])

if __name__ == "__main__":
    asyncio.run(main())
