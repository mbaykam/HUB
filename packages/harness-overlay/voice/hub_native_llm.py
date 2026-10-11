"""Pipecat LLM adapter onto an authenticated, already-admitted native HUB chat.

DSH owns history, credentials, tools and delegated tasks. This adapter forwards
only each new final human transcription and receives public response text.
"""

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit
from uuid import UUID

import aiohttp
from pipecat.frames.frames import (
    Frame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    StartFrame,
    TTSSpeakFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.settings import LLMSettings


class HubBridgeError(Exception):
    """A stable public failure; never includes credentials or backend details."""


class HubBridgeClient:
    """Loopback-only capability; cannot choose a model, create a chat or run tools."""

    def __init__(self, url: str, token: str, call_id: str):
        parsed = urlsplit(url)
        if (
            parsed.scheme != "http"
            or parsed.hostname != "127.0.0.1"
            or not parsed.port
            or parsed.username
            or parsed.password
            or parsed.path not in ("", "/")
            or parsed.query
            or parsed.fragment
            or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token)
        ):
            raise ValueError("An ephemeral loopback HUB capability is required")
        UUID(call_id)
        self._url = url.rstrip("/")
        self._token = token
        self._call_id = call_id
        self._session: aiohttp.ClientSession | None = None
        self._closed = False

    def _http(self) -> aiohttp.ClientSession:
        if self._closed:
            raise HubBridgeError("HUB voice connection is closed")
        if self._session is None:
            self._session = aiohttp.ClientSession(
                trust_env=False,
                headers={"Authorization": f"Bearer {self._token}"},
                timeout=aiohttp.ClientTimeout(total=125, connect=3),
            )
        return self._session

    async def _command(self, path: str, **payload: Any) -> None:
        async with self._http().post(
            self._url + path,
            json={"callId": self._call_id, **payload},
            timeout=aiohttp.ClientTimeout(total=5),
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise HubBridgeError("HUB voice connection is unavailable")
            await response.read()

    async def turn(self, utterance: int, text: str) -> AsyncIterator[dict]:
        """Stream one command once. Lost or uncertain admissions are not retried."""
        async with self._http().post(
            self._url + "/turn",
            json={"callId": self._call_id, "utterance": utterance, "text": text},
            allow_redirects=False,
        ) as response:
            if response.status != 200:
                raise HubBridgeError(
                    "HUB is busy; your message was not replayed"
                    if response.status == 409
                    else "HUB could not accept this voice turn"
                )
            if response.content_type != "application/x-ndjson":
                raise HubBridgeError("Invalid HUB voice response")
            ended = False
            async for line in response.content:
                if len(line) > 65_536:
                    raise HubBridgeError("Oversized HUB voice response")
                try:
                    event = json.loads(line)
                except (ValueError, UnicodeError):
                    raise HubBridgeError("Invalid HUB voice response") from None
                if not isinstance(event, dict) or event.get("utterance") != utterance:
                    raise HubBridgeError("Mismatched HUB voice turn")
                kind = event.get("type")
                if kind == "text":
                    if not isinstance(event.get("text"), str):
                        raise HubBridgeError("Invalid HUB voice text")
                    yield {"type": kind, "utterance": utterance, "text": event["text"]}
                elif kind in ("tool-start", "tool-end"):
                    yield {
                        key: event[key]
                        for key in ("type", "utterance", "callId", "name", "status")
                        if key in event and isinstance(event[key], (str, int))
                    }
                elif kind == "end":
                    if event.get("status") not in ("completed", "aborted", "blocked", "error", "max-tokens", "interrupted"):
                        raise HubBridgeError("Invalid HUB voice completion")
                    ended = True
                    yield {"type": kind, "utterance": utterance, "status": event.get("status")}
                    break
                else:
                    raise HubBridgeError("Unexpected HUB voice event")
            if not ended:
                raise HubBridgeError("HUB voice response ended before completion")

    async def interrupt(self, utterance: int) -> None:
        await self._command("/interrupt", utterance=utterance)

    async def heartbeat(self) -> None:
        await self._command("/heartbeat")

    async def notifications(self, after: int) -> list[dict]:
        async with self._http().post(self._url + '/notifications', json={'callId':self._call_id,'after':after},
                                    timeout=aiohttp.ClientTimeout(total=5),allow_redirects=False) as response:
            if response.status != 200: raise HubBridgeError('HUB task notifications are unavailable')
            if response.content_length and response.content_length > 200_000: raise HubBridgeError('Oversized HUB task notifications')
            raw=bytearray()
            async for chunk in response.content.iter_chunked(8192):
                raw.extend(chunk)
                if len(raw)>200_000:raise HubBridgeError('Oversized HUB task notifications')
            value=json.loads(raw);events=value.get('events') if isinstance(value,dict) else None
            if not isinstance(events,list) or len(events)>16:raise HubBridgeError('Invalid HUB task notifications')
            previous=after
            for event in events:
                if not isinstance(event,dict) or type(event.get('id')) is not int or event['id']<=previous or not isinstance(event.get('text'),str) or not 0<len(event['text'])<=12000:
                    raise HubBridgeError('Invalid HUB task notifications')
                previous=event['id']
            return events

    async def close(self) -> None:
        if self._closed:
            return
        try:
            await self._command("/close")
        finally:
            self._closed = True
            if self._session:
                await self._session.close()
                self._session = None


class HubNativeLLMService(LLMService):
    """Uses Pipecat turn handling/metrics, with native DSH executing every tool.

    Events:
        on_hub_activity: Public native tool/turn status for the voice UI.
    """

    def __init__(self, bridge: HubBridgeClient, *, health=None, **kwargs):
        super().__init__(settings=LLMSettings(
            model="HUB native session", system_instruction=None, temperature=None,
            max_tokens=None, top_p=None, top_k=None, frequency_penalty=None,
            presence_penalty=None, seed=None, filter_incomplete_user_turns=False,
            user_turn_completion_config=None,
        ), **kwargs)
        self._bridge = bridge
        self._health = health
        self._utterance = 0
        self._last_message: dict | None = None
        self._heartbeat_task = None
        self._notification_task = None
        self._notification_cursor = 0
        self._speech_closed = False
        self._request_active = False
        self._register_event_handler("on_hub_activity")

    async def start(self, frame: StartFrame):
        await super().start(frame)
        self._heartbeat_task = self.create_task(self._keep_alive(), "hub-voice-lease")
        if hasattr(self._bridge, 'notifications'):
            self._notification_task = self.create_task(self._task_results(), 'hub-voice-task-results')

    def _ready_for_task_result(self):
        if self._speech_closed or self._request_active:return False
        state=self._health
        if state is None:return True
        import time
        gate=getattr(state,'playback_gate',None)
        return not (state.model_active or state.bot_speaking or state.synthesizing or
                    state.stage=='transcribing' or state.partial_text or
                    getattr(state,'user_speaking',False) or
                    gate and gate.blocked or time.perf_counter()-state.last_loud_audio<.8)

    async def _task_results(self):
        pending=[]
        while True:
            await asyncio.sleep(.5)
            if not self._ready_for_task_result():continue
            if not pending:
                try:pending=await self._bridge.notifications(self._notification_cursor)
                except Exception:continue  # Heartbeat owns fatal connection handling.
            if not pending or not self._ready_for_task_result():continue
            event=pending.pop(0)
            # This is already-durable native assistant text, never new user
            # input or another model request. Advance once; interruption must
            # not cause a command/result to be replayed automatically.
            await self.push_frame(TTSSpeakFrame(event['text']))
            self._notification_cursor=event['id']

    async def _keep_alive(self):
        while True:
            try:
                await self._bridge.heartbeat()
            except Exception:
                await self.push_error("HUB voice connection lost. Please reconnect.", fatal=True)
                return
            await asyncio.sleep(20)

    async def cleanup(self):
        self._speech_closed = True
        if self._notification_task:
            await self.cancel_task(self._notification_task)
            self._notification_task = None
        if self._heartbeat_task:
            await self.cancel_task(self._heartbeat_task)
            self._heartbeat_task = None
        try:
            await self._bridge.close()
        except Exception:
            pass  # Lease expiry is the host-owned fallback if the host is gone.
        await super().cleanup()

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if not isinstance(frame, LLMContextFrame):
            await self.push_frame(frame, direction)
            return
        messages = frame.context.get_messages()
        message = messages[-1] if messages else None
        if (
            not isinstance(message, dict)
            or message.get("role") != "user"
            or message is self._last_message
            or not isinstance(message.get("content"), str)
            or not message["content"].strip()
        ):
            return
        # The stock aggregator can queue multiple final user segments against
        # the same mutable context before this processor gets its frame. Keep
        # every unhandled adjacent segment, not only the final sentence. Stop at
        # our last attempted turn or assistant/history boundary: never replay an
        # already-admitted (or uncertain interrupted) command.
        pending = []
        for candidate in reversed(messages):
            if candidate is self._last_message or not isinstance(candidate, dict) or candidate.get("role") != "user":
                break
            content = candidate.get("content")
            if not isinstance(content, str):
                break
            if content.strip():
                pending.append(content.strip())
        text = "\n".join(reversed(pending))
        self._last_message = message
        # This context is a bounded audio-turn scratchpad, not the saved chat.
        # Native DSH provides full history and automatic memory for each turn.
        frame.context.set_messages([message])
        self._utterance += 1
        utterance = self._utterance
        completed = False
        cancelled = False
        has_text = False
        self._request_active = True
        if self._health:
            self._health.begin_turn()
            self._health.model_active = True
            self._health.stage = 'thinking'
        await self.push_frame(LLMFullResponseStartFrame())
        await self.start_ttfb_metrics()
        await self.start_processing_metrics()
        try:
            async for event in self._bridge.turn(utterance, text):
                if event["type"] == "text":
                    has_text = True
                    if self._health and self._health.first_text_at is None:
                        self._health.first_text_at = time.perf_counter()
                    await self.stop_ttfb_metrics()
                    await self.push_frame(LLMTextFrame(event["text"]))
                else:
                    await self._call_event_handler("on_hub_activity", event)
                    if event["type"] == "end":
                        completed = True
                        if event["status"] not in ("completed", "aborted"):
                            await self.push_error("HUB did not complete this voice turn.")
        except asyncio.CancelledError:
            cancelled = True
            raise
        except Exception:
            # Never log exception text: it can contain a URL, transcript or token.
            await self.push_error("HUB voice turn failed. Your command was not replayed.")
        finally:
            self._request_active = False
            if self._health:
                self._health.model_active = False
                if (cancelled or not has_text) and not self._health.bot_speaking:
                    self._health.stage = 'listening'
            if not completed:
                try:
                    await self._bridge.interrupt(utterance)
                except Exception:
                    pass
            await self.stop_all_metrics()
            if not cancelled:
                await self.push_frame(LLMFullResponseEndFrame())
