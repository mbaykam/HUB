"""Authenticated ASGI and real stock SmallWebRTC checks with no microphone/model."""

import asyncio
import os
import sys
import threading
from pathlib import Path

import httpx
import pytest
from aiortc import RTCPeerConnection, RTCConfiguration, RTCSessionDescription
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/harness-overlay/voice"))
from server import create_app

TOKEN = "a" * 43
HEADERS = {"authorization": "Bearer " + TOKEN}


class Bridge:
    def __init__(self):
        self.closed = 0

    async def close(self):
        self.closed += 1


class Connection:
    def event_handler(self, _name):
        return lambda fn: fn


class Handler:
    def __init__(self):
        self.closed = 0
        self.patched = []
        self.ice_servers = []

    def update_ice_servers(self, servers):
        self.ice_servers = servers

    async def handle_web_request(self, request, callback):
        if request.pc_id is None:
            try:
                await callback(Connection())
            except Exception:
                pass  # Match the stock handler's callback-error behavior.
        return {"sdp": "v=0\r\n", "type": "answer", "pc_id": "test-peer"}

    async def handle_patch_request(self, request):
        self.patched.append(request)

    async def close(self):
        self.closed += 1


def worker(_connection, _bridge):
    class PassThrough(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            await self.push_frame(frame, direction)

    return PipelineWorker(Pipeline([PassThrough()]), enable_rtvi=False,
                          idle_timeout_secs=None, cancel_on_idle_timeout=False)


def client(app, **kwargs):
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=("127.0.0.1", 10)),
                             base_url="http://127.0.0.1", **kwargs)


@pytest.mark.asyncio
async def test_private_interrupt_is_authenticated_validated_and_keeps_the_call_alive():
    interrupted=[]
    def build(connection, bridge):
        result=worker(connection,bridge)
        async def interrupt():interrupted.append(True)
        result.interrupt_voice=interrupt
        return result
    class ConnectedHandler(Handler):
        async def handle_web_request(self, request, callback):
            handlers={}
            class Connected(Connection):
                def event_handler(self,name):
                    def register(fn):handlers[name]=fn;return fn
                    return register
            connection=Connected();await callback(connection)
            await handlers['connected'](connection)
            return {'sdp':'v=0\r\n','type':'answer','pc_id':'test-peer'}
    app=create_app(Bridge(),TOKEN,worker_factory=build,request_handler=ConnectedHandler())
    async with app.router.lifespan_context(app),client(app) as http:
        assert (await http.post('/interrupt',json={})).status_code==401
        assert (await http.post('/interrupt',json={},headers=HEADERS)).status_code==409
        assert (await http.post('/offer',json={'type':'offer','sdp':'v=0\r\n'},headers=HEADERS)).status_code==200
        assert (await http.post('/interrupt',json={},headers={**HEADERS,'origin':'https://untrusted.invalid'})).status_code==401
        assert (await http.post('/interrupt',json={'text':'do not replay'},headers=HEADERS)).status_code==400
        assert (await http.post('/interrupt',json={},headers=HEADERS)).json()=={'ok':True}
        assert len(interrupted)==1
        assert (await http.get('/status',headers=HEADERS)).json()['status']=='connected'
        await http.post('/close',headers=HEADERS)
        assert (await http.post('/interrupt',json={},headers=HEADERS)).status_code==409


@pytest.mark.asyncio
async def test_model_warmup_overlaps_signaling_without_blocking_status_or_duplicate_loading():
    warming, release = threading.Event(), threading.Event()
    built = []
    def prepare():
        warming.set()
        assert release.wait(3)
    def build(connection, bridge):
        assert release.is_set()
        built.append(True)
        return worker(connection, bridge)
    app = create_app(Bridge(), TOKEN, worker_factory=build, request_handler=Handler(), prepare_models=prepare)
    async with app.router.lifespan_context(app), client(app, headers=HEADERS) as http:
        for _ in range(100):
            if warming.is_set(): break
            await asyncio.sleep(.01)
        assert warming.is_set()
        assert (await http.get('/status')).json() == {'status':'waiting', 'audio':None}
        offer = asyncio.create_task(http.post('/offer', json={'type':'offer', 'sdp':'v=0\r\n'}))
        await asyncio.sleep(.05)
        assert not built
        release.set()
        assert (await offer).status_code == 200
        assert len(built) == 1
        await http.post('/close')


@pytest.mark.asyncio
async def test_host_sets_standard_ice_before_peer_without_exposing_credentials():
    handler = Handler()
    app = create_app(Bridge(), TOKEN, worker_factory=worker, request_handler=handler)
    config = {"iceServers": [{"urls": ["turn:relay.example:3478?transport=udp"], "username": "fixture-user", "credential": "fixture-short-lived"}]}
    async with app.router.lifespan_context(app), client(app) as http:
        assert (await http.post("/ice", json=config)).status_code == 401
        response = await http.post("/ice", json=config, headers=HEADERS)
        assert response.json() == {"ok": True}
        assert handler.ice_servers[0].credential == "fixture-short-lived"
        assert "fixture" not in (await http.get("/status", headers=HEADERS)).text
        for bad in ({}, {"iceServers": [{"urls": ["https://not-ice.example"]}]}, {"iceServers": [{"urls": ["turn:relay.example"]}]}, {"iceServers": [], "apiToken": "not-allowed"}):
            assert (await http.post("/ice", json=bad, headers=HEADERS)).status_code == 400
        assert (await http.post("/offer", json={"sdp": "v=0\r\n", "type": "offer"}, headers=HEADERS)).status_code == 200
        assert (await http.post("/ice", json=config, headers=HEADERS)).status_code == 409


@pytest.mark.asyncio
async def test_sidecar_rejects_browser_foreign_host_and_unauthenticated_requests():
    bridge = Bridge()
    app = create_app(bridge, TOKEN, worker_factory=worker, request_handler=Handler())
    async with app.router.lifespan_context(app), client(app) as http:
        assert (await http.get("/status")).status_code == 401
        for headers in ({**HEADERS, "origin": "https://example.com"}, {**HEADERS, "sec-fetch-site": "same-origin"}, {**HEADERS, "host": "attacker.invalid"}):
            assert (await http.get("/status", headers=headers)).status_code == 401
        response = await http.get("/status", headers=HEADERS)
        assert response.json() == {"status": "waiting", "audio": None}
        assert response.headers["cache-control"] == "no-store"
    assert bridge.closed == 1


@pytest.mark.asyncio
async def test_sidecar_owns_one_peer_reconnects_it_and_closes_idempotently():
    bridge, handler = Bridge(), Handler()
    app = create_app(bridge, TOKEN, worker_factory=worker, request_handler=handler)
    async with app.router.lifespan_context(app), client(app, headers=HEADERS) as http:
        offer = {"sdp": "v=0\r\n", "type": "offer"}
        assert (await http.post("/offer", json=offer)).status_code == 200
        assert (await http.post("/offer", json=offer)).status_code == 409
        assert (await http.post("/offer", json={**offer, "pc_id": "other"})).status_code == 409
        assert (await http.post("/offer", json={**offer, "pc_id": "test-peer"})).status_code == 200
        assert (await http.patch("/offer", json={"pc_id": "test-peer", "candidates": []})).status_code == 200
        assert len(handler.patched) == 1
        assert (await http.patch("/offer", json={"pc_id": "other", "candidates": []})).status_code == 409
        await http.post("/close")
        await http.post("/close")
        assert (await http.post("/offer", json=offer)).status_code == 410
    assert bridge.closed == 1
    assert handler.closed == 1


@pytest.mark.asyncio
async def test_callback_failure_cannot_masquerade_as_successful_audio_start():
    def broken(_connection, _bridge):
        raise RuntimeError("private backend detail")

    bridge, handler = Bridge(), Handler()
    app = create_app(bridge, TOKEN, worker_factory=broken, request_handler=handler)
    async with app.router.lifespan_context(app), client(app, headers=HEADERS) as http:
        response = await http.post("/offer", json={"sdp": "v=0\r\n", "type": "offer"})
        assert response.status_code == 503
        assert "private" not in response.text
        assert (await http.get("/status")).json() == {"status": "closed", "audio": None}
    assert bridge.closed == 1


@pytest.mark.asyncio
async def test_offer_validation_rejects_oversized_malformed_and_wrong_media():
    app = create_app(Bridge(), TOKEN, worker_factory=worker, request_handler=Handler())
    async with app.router.lifespan_context(app), client(app, headers=HEADERS) as http:
        assert (await http.post("/offer", content="{}", headers={"content-type": "text/plain"})).status_code == 415
        for value in (None, [], {}, {"type": "answer", "sdp": "v=0"}, {"type": "offer", "sdp": "bad"}):
            assert (await http.post("/offer", content=__import__("json").dumps(value), headers={"content-type": "application/json"})).status_code == 400
        assert (await http.post("/offer", json={"type": "offer", "sdp": "v=0" + "x" * 128_000})).status_code == 413


@pytest.mark.asyncio
async def test_real_smallwebrtc_handler_produces_a_valid_answer_without_a_model_or_microphone():
    bridge = Bridge()
    app = create_app(bridge, TOKEN, worker_factory=worker)
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    peer.addTransceiver("audio", direction="sendrecv")
    peer.createDataChannel("rtvi")
    try:
        await peer.setLocalDescription(await peer.createOffer())
        async with app.router.lifespan_context(app), client(app, headers=HEADERS) as http:
            response = await http.post("/offer", json={"type": "offer", "sdp": peer.localDescription.sdp})
            assert response.status_code == 200
            answer = response.json()
            assert answer["type"] == "answer"
            assert "m=audio" in answer["sdp"]
            assert "m=application" in answer["sdp"]
            assert answer["pc_id"]
            await http.post("/close")
    finally:
        await peer.close()
    assert bridge.closed == 1


@pytest.mark.asyncio
@pytest.mark.skipif(os.environ.get("HUB_VOICE_TEST_LOCAL_MODELS") != "1", reason="Explicit CPU model integration check; requires the already-cached speech models")
async def test_stock_cpu_pipeline_starts_listening_without_unsolicited_audio(monkeypatch):
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")

    class SpeechBridge:
        closed = False

        async def heartbeat(self):
            pass

        async def close(self):
            self.closed = True

        async def interrupt(self, _utterance):
            pass

        async def turn(self, _utterance, _text):
            raise AssertionError("An idle connection must not fabricate a user turn or call a model")
            yield

    bridge = SpeechBridge()
    app = create_app(bridge, TOKEN)
    peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
    peer.addTransceiver("audio", direction="recvonly")
    peer.createDataChannel("rtvi")
    audio = asyncio.Future()

    @peer.on("track")
    def track_received(track):
        if track.kind == "audio" and not audio.done():
            audio.set_result(track)

    try:
        await peer.setLocalDescription(await peer.createOffer())
        async with app.router.lifespan_context(app), client(app, headers=HEADERS, timeout=60) as http:
            response = await http.post("/offer", json={"type": "offer", "sdp": peer.localDescription.sdp})
            assert response.status_code == 200
            answer = response.json()
            await peer.setRemoteDescription(RTCSessionDescription(sdp=answer["sdp"], type=answer["type"]))
            incoming = await asyncio.wait_for(audio, timeout=10)
            try:
                async with asyncio.timeout(3):
                    while True:
                        frame = await incoming.recv()
                        assert not frame.to_ndarray().any(), "Listen-first must not play audio into the caller's mic"
            except TimeoutError:
                pass
            await http.post("/close")
    finally:
        await peer.close()
    assert bridge.closed
