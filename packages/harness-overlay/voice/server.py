"""One-call loopback SmallWebRTC sidecar, launched and authenticated by HUB.

No browser session cookie or provider key is needed here. The parent owns public
HTTPS authentication and passes a single native voice capability in environment.
"""

import asyncio
import json
import os
import re
import secrets
import socket
import sys
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pipecat.transports.smallwebrtc.request_handler import (
    ConnectionMode,
    IceCandidate,
    SmallWebRTCPatchRequest,
    SmallWebRTCRequest,
    SmallWebRTCRequestHandler,
)
from pipecat.workers.runner import WorkerRunner
from pipecat.transports.smallwebrtc.connection import IceServer

from hub_native_llm import HubBridgeClient
from voice_pipeline import build_voice_worker, prepare_voice_models


def create_app(bridge: HubBridgeClient, control_token: str, *, worker_factory=build_voice_worker,
               request_handler=None, prepare_models=None) -> FastAPI:
    """One process owns one native voice call; reconnect only reuses its peer."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{43}", control_token):
        raise ValueError("An ephemeral sidecar capability is required")
    handler = request_handler or SmallWebRTCRequestHandler(connection_mode=ConnectionMode.SINGLE)
    runner = WorkerRunner(handle_sigint=False)
    lock = asyncio.Lock()
    state = {"status": "waiting", "pc_id": None, "worker": None, "since": time.monotonic()}
    group = None
    resources_closed = False
    watchdog_stop = asyncio.Event()
    runner_ready = asyncio.Event()
    warm_task = None

    async def warm_models():
        try:
            await asyncio.to_thread(prepare_models)
        except Exception:
            pass  # Admission/signaling validates and reports missing weights.

    @runner.event_handler("on_ready")
    async def ready_runner(_runner):
        runner_ready.set()

    async def close_call():
        nonlocal resources_closed
        if resources_closed:
            return
        resources_closed = True
        state["status"] = "closed"
        watchdog_stop.set()
        if state["worker"]:
            await state["worker"].cancel(reason="Voice call ended")
        await handler.close()
        try:
            await bridge.close()
        except Exception:
            pass  # Native lease expiry covers a host that disappeared.

    async def connect_watchdog():
        while state["status"] != "closed":
            try:
                await asyncio.wait_for(watchdog_stop.wait(), timeout=1)
                return
            except TimeoutError:
                pass
            if state["status"] in ("waiting", "connecting") and time.monotonic() - state["since"] > 60:
                await close_call()

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal group, warm_task
        async with asyncio.TaskGroup() as tasks:
            group = tasks
            tasks.create_task(connect_watchdog())
            if prepare_models:
                warm_task = tasks.create_task(warm_models())
            try:
                yield
            finally:
                await close_call()
                await runner.cancel()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.middleware("http")
    async def auth(request: Request, next_handler):
        if (
            request.client is None or request.client.host != "127.0.0.1"
            or request.url.hostname != "127.0.0.1"
            or "origin" in request.headers or "sec-fetch-site" in request.headers
            or not secrets.compare_digest(request.headers.get("authorization", ""), "Bearer " + control_token)
        ):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        response = await next_handler(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response

    async def read_json(request: Request):
        if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
            raise HTTPException(415, "JSON required")
        parts = bytearray()
        async for chunk in request.stream():
            parts.extend(chunk)
            if len(parts) > 128_000:
                raise HTTPException(413, "Offer too large")
        try:
            value = json.loads(parts)
        except (ValueError, UnicodeError):
            raise HTTPException(400, "Invalid request") from None
        if not isinstance(value, dict):
            raise HTTPException(400, "Invalid request")
        return value

    @app.get("/status")
    async def status():
        health = getattr(state["worker"], "speech_health", None)
        return {"status": state["status"], "audio": health.snapshot() if health else None}

    @app.post("/ice")
    async def configure_ice(request: Request):
        # Host-only capability route, before SDP creates a peer. Browser
        # signaling cannot forward this endpoint or supply relay settings.
        value = await read_json(request)
        try:
            entries = value["iceServers"]
            if set(value) != {"iceServers"} or not isinstance(entries, list) or len(entries) > 6:
                raise ValueError()
            servers = []
            for item in entries:
                if not isinstance(item, dict) or set(item) - {"urls", "username", "credential"}:
                    raise ValueError()
                urls = item.get("urls")
                if not isinstance(urls, list) or not 1 <= len(urls) <= 8:
                    raise ValueError()
                turn = False
                for url in urls:
                    if not isinstance(url, str) or len(url) > 500:
                        raise ValueError()
                    match = re.fullmatch(r"(stun|turn|turns):([A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9a-fA-F:]+\])(?::([0-9]{1,5}))?(?:\?transport=(udp|tcp))?", url)
                    if (not match or match[3] and not 1 <= int(match[3]) <= 65535
                            or match[1] == "stun" and match[4] or match[1] == "turns" and match[4] == "udp"):
                        raise ValueError()
                    turn = turn or match[1] != "stun"
                def valid_secret(text):
                    return isinstance(text, str) and 1 <= len(text) <= 2048 and not re.search(r"[\x00-\x1f\x7f]", text)
                if turn:
                    if not valid_secret(item.get("username")) or not valid_secret(item.get("credential")):
                        raise ValueError()
                elif "username" in item or "credential" in item:
                    raise ValueError()
                servers.append(IceServer(**item))
        except (ValueError, TypeError, KeyError):
            raise HTTPException(400, "Invalid ICE configuration") from None
        async with lock:
            if state["status"] != "waiting" or state["pc_id"] is not None:
                raise HTTPException(409, "ICE configuration is already in use")
            handler.update_ice_servers(servers)
        return {"ok": True}

    @app.post("/close")
    async def close():
        async with lock:
            await close_call()
        return {"ok": True}

    @app.post("/interrupt")
    async def interrupt(request: Request):
        if await read_json(request) != {}:
            raise HTTPException(400, "Invalid interrupt")
        worker = state['worker']
        if state['status'] != 'connected' or not worker:
            raise HTTPException(409, "Voice is not connected")
        await worker.interrupt_voice()
        return {"ok": True}

    @app.post("/attention")
    async def attention(request: Request):
        value = await read_json(request)
        if set(value) != {'mode'} or value['mode'] not in ('active', 'background'):
            raise HTTPException(400, 'Invalid listening mode')
        worker = state['worker']
        if state['status'] != 'connected' or not worker:
            raise HTTPException(409, 'Voice is not connected')
        return {'attention': await worker.set_attention(value['mode'])}

    @app.post("/offer")
    async def offer(request: Request):
        value = await read_json(request)
        if value.get("type") != "offer" or not isinstance(value.get("sdp"), str) or not value["sdp"].startswith("v=0"):
            raise HTTPException(400, "Invalid SDP offer")
        pc_id = value.get("pc_id")
        if pc_id is not None and (not isinstance(pc_id, str) or len(pc_id) > 128):
            raise HTTPException(400, "Invalid peer")
        if "restart_pc" in value and not isinstance(value["restart_pc"], bool):
            raise HTTPException(400, "Invalid restart")
        async with lock:
            if state["status"] == "closed":
                raise HTTPException(410, "Voice call ended")
            if (state["pc_id"] is None and pc_id is not None) or (state["pc_id"] is not None and pc_id != state["pc_id"]):
                raise HTTPException(409, "Peer does not belong to this call")
            state["status"] = "connecting"
            state["since"] = time.monotonic()
            failed = False

            async def connected(connection):
                nonlocal failed
                try:
                    if warm_task:
                        await asyncio.shield(warm_task)
                    worker = await asyncio.to_thread(worker_factory, connection, bridge)
                    state["worker"] = worker

                    @connection.event_handler("connected")
                    async def ready(_connection):
                        if state["status"] != "closed":
                            state["status"] = "connected"

                    @connection.event_handler("disconnected")
                    async def disconnected(_connection):
                        if state["status"] != "closed":
                            state["status"] = "connecting"
                            state["since"] = time.monotonic()

                    @worker.event_handler("on_pipeline_finished")
                    async def finished(_worker, _frame):
                        state["status"] = "closed"
                        watchdog_stop.set()

                    await runner.add_workers(worker)
                    if group is None:
                        raise RuntimeError("Sidecar was not started")
                    group.create_task(runner.run())
                    # run() clears its shutdown flag on entry. Do not accept
                    # close/reconnect until startup has crossed that boundary.
                    await asyncio.wait_for(runner_ready.wait(), timeout=15)
                except Exception:
                    failed = True
                    raise

            try:
                answer = await handler.handle_web_request(
                    SmallWebRTCRequest(sdp=value["sdp"], type="offer", pc_id=pc_id,
                                       restart_pc=value.get("restart_pc", False)), connected,
                )
                # Stock handler logs/swallow callback errors; never give the
                # browser an apparent success if its audio pipeline failed.
                if failed or not isinstance(answer, dict) or not state["worker"]:
                    raise RuntimeError("Voice pipeline unavailable")
                state["pc_id"] = answer["pc_id"]
                return answer
            except Exception:
                await close_call()
                raise HTTPException(503, "Voice pipeline could not start") from None

    @app.patch("/offer")
    async def candidates(request: Request):
        value = await read_json(request)
        async with lock:
            if state["status"] == "closed":
                raise HTTPException(410, "Voice call ended")
            if state["pc_id"] is None or value.get("pc_id") != state["pc_id"]:
                raise HTTPException(409, "Peer does not belong to this call")
            items = value.get("candidates")
            if not isinstance(items, list) or len(items) > 32:
                raise HTTPException(400, "Invalid ICE candidates")
            parsed = []
            for item in items:
                if (not isinstance(item, dict) or not isinstance(item.get("candidate"), str)
                    or len(item["candidate"]) > 4096 or not isinstance(item.get("sdp_mid"), str)
                    or len(item["sdp_mid"]) > 128 or type(item.get("sdp_mline_index")) is not int
                    or not 0 <= item["sdp_mline_index"] <= 16):
                    raise HTTPException(400, "Invalid ICE candidate")
                parsed.append(IceCandidate(**{key: item[key] for key in ("candidate", "sdp_mid", "sdp_mline_index")}))
            try:
                await handler.handle_patch_request(SmallWebRTCPatchRequest(pc_id=state["pc_id"], candidates=parsed))
            except Exception:
                raise HTTPException(400, "ICE candidate rejected") from None
        return {"ok": True}

    async def end_owned_call():
        async with lock:
            await close_call()

    # A prepared runtime can own this application's lifespan without reusing
    # any peer, transcript, runner, or capability from another call.
    app.state.end_voice_call = end_owned_call
    return app


if __name__ == "__main__":
    import uvicorn
    from loguru import logger

    # Upstream debug logs can include SDP/local addresses. Expose only the
    # bounded ready record; UI errors travel through authenticated protocols.
    logger.remove()
    async def main():
        # Pipecat's WorkerRunner captures the running loop at construction.
        # ASGI tests already have one; the actual executable must create it too.
        bridge = HubBridgeClient(os.environ.pop("HUB_VOICE_BRIDGE_URL"), os.environ.pop("HUB_VOICE_BRIDGE_TOKEN"), os.environ.pop("HUB_VOICE_CALL_ID"))
        speech = json.loads(os.environ.pop("HUB_VOICE_SPEECH", "null"))
        app = create_app(bridge, os.environ.pop("HUB_VOICE_CONTROL_TOKEN"),
                         worker_factory=lambda connection, native: build_voice_worker(connection, native, speech),
                         prepare_models=lambda: prepare_voice_models(speech))
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(128)

            class ReadyServer(uvicorn.Server):
                async def startup(self, sockets=None):
                    await super().startup(sockets=sockets)
                    if self.started:
                        print(json.dumps({"type": "hub-voice-ready", "port": sock.getsockname()[1]}), flush=True)

            await ReadyServer(uvicorn.Config(app, log_level="critical", access_log=False)).serve(sockets=[sock])

    asyncio.run(main())
