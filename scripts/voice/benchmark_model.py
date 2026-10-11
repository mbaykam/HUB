"""Test the official Pipecat Ollama adapter with synthetic handoff requests.

Tool calls are inspected only, never executed. Uses the local Ollama server;
the OpenAI-compatible client in Pipecat does not contact the OpenAI service.
"""
import asyncio
import json
import time
import sys
from loguru import logger

from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.ollama.llm import OLLamaLLMService
from pipecat.adapters.schemas.function_schema import FunctionSchema

SYSTEM = """You are HUB's concise voice assistant. Speak in one short sentence.
For research, coding or work on files, call delegate_task with the user's request.
For casual conversation answer directly. Never claim work is completed unless a
tool result confirms completion. Do not use Markdown. Do not expose reasoning."""
TOOLS = [FunctionSchema(name="delegate_task", description="Ask the smarter HUB agent to do a research, coding or file task.",
                        properties={"task": {"type": "string"}}, required=["task"])]


async def main():
    """Collect streaming latency and handoff selection without taking actions."""
    logger.remove()
    model = sys.argv[1] if len(sys.argv) > 1 else "qwen3.5:0.8b"
    llm = OLLamaLLMService(base_url="http://127.0.0.1:11434/v1", settings=OLLamaLLMService.Settings(
        model=model, temperature=0.2, max_tokens=128, extra={"reasoning_effort": "none"},
    ))
    cases = [("Hello, how are you?", False), ("Please research the latest Pipecat release and summarize its changes.", True),
             ("Please fix the sidebar bug in my project.", True), ("Thanks, that's all for now.", False)]
    results = []
    for prompt, should_delegate in cases:
        context = LLMContext(messages=[{"role": "system", "content": SYSTEM}, {"role": "user", "content": prompt}], tools=TOOLS)
        started = time.perf_counter()
        first = None; answer = ""; calls = {}
        stream = await llm.get_chat_completions(context)
        async for chunk in stream:
            if not chunk.choices:
                continue
            delta = chunk.choices[0].delta
            if (delta.content or delta.tool_calls) and first is None:
                first = time.perf_counter() - started
            answer += delta.content or ""
            for call in delta.tool_calls or []:
                entry = calls.setdefault(call.index, {"name": "", "arguments": ""})
                entry["name"] += call.function.name or ""
                entry["arguments"] += call.function.arguments or ""
        selected = any(call["name"] == "delegate_task" and isinstance(json.loads(call["arguments"]).get("task"), str) for call in calls.values())
        row = {"expected_handoff": should_delegate, "selected_handoff": selected,
               "first_content_seconds": round(first, 3) if first is not None else None,
               "total_seconds": round(time.perf_counter() - started, 3), "spoken_words": len(answer.split()),
               "passed": selected == should_delegate and len(answer.split()) <= 35}
        results.append(row); print(json.dumps(row), flush=True)
        await stream.close()
    assert all(row["passed"] for row in results), "Local model did not meet the initial handoff/verbosity gate"
    print("PASS: stock local adapter responds briefly and selects synthetic handoffs; no tasks were executed")


if __name__ == "__main__":
    asyncio.run(main())
