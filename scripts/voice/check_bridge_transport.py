"""Synthetic Node-to-Python wire check, invoked by verify_transport.mjs only."""

import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "packages/harness-overlay/voice"))
from hub_native_llm import HubBridgeClient, HubBridgeError


async def main():
    config = json.loads(os.environ.pop("HUB_VOICE_TEST_CAPABILITY"))
    client = HubBridgeClient(config["url"], config["token"], config["callId"])
    try:
        await client.heartbeat()
        events = [event async for event in client.turn(1, "Synthetic hello")]
        assert events == [
            {"type": "text", "utterance": 1, "text": "Synthetic reply."},
            {"type": "end", "utterance": 1, "status": "completed"},
        ]
        try:
            [event async for event in client.turn(1, "Synthetic hello")]
            raise AssertionError("Duplicate command was admitted")
        except HubBridgeError:
            pass
        await client.interrupt(1)
    finally:
        await client.close()


asyncio.run(main())
print("PASS: real Python/Node authentication, NDJSON streaming, duplicate rejection and cleanup")
