"""Exercise the real Basic Memory MCP server using only a disposable synthetic vault.

Run with the Python from a venv containing requirements.txt. No model/API calls.
Do not substitute a real vault: isolation is deliberately constructed here.
"""

import asyncio
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from fastmcp import Client
from fastmcp.client.transports import StdioTransport


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def result_text(result):
    return "\n".join(block.text for block in result.content if block.type == "text")


async def eventually(operation, predicate, message, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = await operation()
        if predicate(value):
            return value
        await asyncio.sleep(0.35)
    raise AssertionError(message)


async def verify(root):
    config_dir = root / "config"
    vault = root / "vault"
    config_dir.mkdir()
    vault.mkdir()
    profile = root / "profile"
    profile.mkdir()
    (profile / "AppData" / "Local").mkdir(parents=True)
    (profile / "AppData" / "Roaming").mkdir(parents=True)
    project = "hub-memory-pilot"
    config = {
        "projects": {project: {"path": str(vault), "mode": "local"}},
        "default_project": project,
        "semantic_search_enabled": False,
        "logfire_enabled": False,
        "logfire_send_to_logfire": False,
        "write_note_overwrite_default": False,
    }
    (config_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
    # Never pass ambient cloud/model credentials to the test server.
    allowed = {"PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "PATHEXT"}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update({
        "BASIC_MEMORY_CONFIG_DIR": str(config_dir),
        "USERPROFILE": str(profile),
        "LOCALAPPDATA": str(profile / "AppData" / "Local"),
        "APPDATA": str(profile / "AppData" / "Roaming"),
        "BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED": "false",
        "BASIC_MEMORY_LOGFIRE_ENABLED": "false",
        "HF_HUB_OFFLINE": "1",
        "HF_HUB_DISABLE_TELEMETRY": "1",
        "LITELLM_LOCAL_MODEL_COST_MAP": "True",
        "DO_NOT_TRACK": "1",
        "FASTMCP_CHECK_FOR_UPDATES": "off",
        "FASTMCP_SHOW_SERVER_BANNER": "false",
        "PYTHONUTF8": "1",
    })
    executable = Path(sys.executable).parent / ("basic-memory.exe" if os.name == "nt" else "basic-memory")
    check(executable.is_file(), "Install the pinned requirements in this Python's virtual environment first")
    checks = []
    if "--bridge-only" in sys.argv:
        # Fast iteration on the native integration; the normal command still
        # performs the complete storage/restart suite before this bridge.
        extra = [arg for arg in sys.argv[1:] if arg != "--bridge-only"]
        completed = await asyncio.to_thread(
            subprocess.run, ["node", str(Path(__file__).with_name("verify_dsh_memory.mjs")), str(executable), str(config_dir), *extra],
            env=env, capture_output=True, text=True, timeout=420 if "--topics-model" in sys.argv else 240,
        )
        check(completed.returncode == 0, "Native bridge failed:\n" + completed.stdout + completed.stderr)
        return {"scope": "native bridge only; storage restart suite not run", "output": completed.stdout}

    def transport():
        return StdioTransport(command=str(executable), args=["mcp"], env=env, cwd=str(root), keep_alive=False)

    async with Client(transport(), timeout=45) as client:
        names = {tool.name for tool in await client.list_tools()}
        check({"write_note", "read_note", "edit_note", "delete_note", "search_notes", "build_context"} <= names,
              "Required Basic Memory MCP tools are missing")
        checks.append("real MCP handshake and required tools")

        async def call(name, args):
            return await client.call_tool(name, {"project": project, **args})

        await call("write_note", {"title": "Pilot Project", "directory": "projects", "content": "# Pilot Project\nSynthetic project for HUB testing."})
        written = await call("write_note", {
            "title": "Pilot Preferences", "directory": "people",
            "content": "# Pilot Preferences\n\n## Observations\n- [preference] The synthetic user likes amber tea.\n\n## Relations\n- works_on [[Pilot Project]]\n",
        })
        path_match = re.search(r"^file_path:\s*(.+)$", result_text(written), re.MULTILINE)
        check(path_match is not None, "write_note omitted file_path: " + result_text(written))
        note = (vault / path_match.group(1).strip()).resolve()
        check(note.is_relative_to(vault.resolve()), "Server returned a path outside the synthetic vault")
        await eventually(lambda: asyncio.to_thread(note.exists), bool, "MCP write never materialized as Markdown")
        check("amber tea" in note.read_text(encoding="utf-8"), "Written memory is not readable in the vault")
        checks.append("MCP writes create editable Markdown files")

        async def search(query):
            return result_text(await call("search_notes", {"query": query, "search_type": "text", "output_format": "json"}))

        await eventually(lambda: search('"amber tea"'), lambda value: "pilot-preferences" in value,
                         "Saved memory is not searchable")
        graph = result_text(await call("build_context", {"url": "memory://people/pilot-preferences", "depth": 2, "timeframe": "1d"}))
        check("Pilot Project" in graph or "pilot-project" in graph, "Stored relationship missing from context graph")
        checks.append("text recall and linked graph traversal")

        # A direct file edit simulates Obsidian, without implementing another sync layer.
        note.write_text(note.read_text(encoding="utf-8").replace("amber tea", "violet tea"), encoding="utf-8")
        await eventually(lambda: search('"violet tea"'), lambda value: "pilot-preferences" in value,
                         "External edit did not reach the search index")
        await eventually(lambda: search('"amber tea"'), lambda value: "pilot-preferences" not in value,
                         "Search still recalls the obsolete preference after external edit")
        checks.append("Obsidian-style external edit updates recall and removes stale text")

        await call("edit_note", {"identifier": "people/pilot-preferences", "operation": "find_replace",
                                 "find_text": "violet tea", "content": "silver tea"})
        await eventually(lambda: asyncio.to_thread(note.read_text, encoding="utf-8"),
                         lambda value: "silver tea" in value, "Assistant correction did not reach Markdown")
        checks.append("assistant correction updates the same Markdown file")

    # Fresh server/client, same synthetic files and private index.
    async with Client(transport(), timeout=45) as client:
        value = result_text(await client.call_tool("read_note", {"project": project, "identifier": "people/pilot-preferences"}))
        check("silver tea" in value and "amber tea" not in value, "Corrected memory did not survive restart")
        checks.append("corrected memory survives a server restart")
        await client.call_tool("delete_note", {"project": project, "identifier": "people/pilot-preferences"})
        await eventually(lambda: asyncio.to_thread(note.exists), lambda exists: not exists,
                         "MCP delete left the Markdown file behind")

        async def deleted_search():
            return result_text(await client.call_tool("search_notes", {
                "project": project, "query": '"silver tea"', "search_type": "text", "output_format": "json",
            }))
        await eventually(deleted_search, lambda value: "pilot-preferences" not in value,
                         "Deleted memory remains searchable")
        checks.append("delete removes the note and its searchable content")

    bridge = Path(__file__).with_name("verify_dsh_memory.mjs")
    completed = await asyncio.to_thread(
        subprocess.run, ["node", str(bridge), str(executable), str(config_dir), *sys.argv[1:]],
        env=env, capture_output=True, text=True, timeout=240 if sys.argv[1:] else 120,
    )
    check(completed.returncode == 0, "Native DSH bridge failed:\n" + completed.stdout + completed.stderr)
    if "--graph-browser" in sys.argv:
        print(completed.stdout, end="")
    checks.append("native DSH tool registry + upstream MCP bridge write/read/delete")
    checks.append("real DSH turns capture automatically; another session receives curated recall (scripted LLM)")
    checks.append("real recall sees current corrections and excludes deleted notes and raw evidence")
    checks.append("native DSH tool restrictions deny capture without stopping the conversation")
    checks.append("native reflection worker and persisted forgetting policy using real Basic Memory")
    if "--model-check" in sys.argv:
        checks.append("real existing OpenRouter model: casual preferences, corrections, hypothetical rejection and forgetting")
    if "--graph-browser" in sys.argv:
        checks.append("compiled PWA knowledge graph: real MCP UUID links, 55-note whole-vault body search/pagination, note opening, focus and cleanup")

    return {"basic_memory": "0.23.2", "checks": checks, "passed": len(checks),
            "scope": "synthetic vault only; native storage, lifecycle, reflection and forgetting checks; " +
                     ("opt-in existing OpenRouter model check" if "--model-check" in sys.argv else "scripted generation, no real provider calls")}


async def main():
    # Keep fixtures outside the public repo. The SDK closes its owned subprocesses
    # before TemporaryDirectory removes this exact test-owned directory.
    fixture = tempfile.TemporaryDirectory(prefix="hub-memory-pilot-")
    try:
        result = await asyncio.wait_for(verify(Path(fixture.name)), timeout=480 if "--topics-model" in sys.argv else 360)
        print(json.dumps(result, indent=2))
    finally:
        # Windows process teardown can briefly retain a log handle after stdio
        # closes. Retry cleanup without masking the original test failure.
        for attempt in range(15):
            try:
                fixture.cleanup()
                break
            except PermissionError:
                if attempt == 14:
                    print("Synthetic fixture cleanup delayed: " + fixture.name, file=sys.stderr)
                    break
                await asyncio.sleep(0.3)


if __name__ == "__main__":
    asyncio.run(main())
