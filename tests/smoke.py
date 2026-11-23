"""Smoke the real HTTP/MCP service, optionally the real V16 isolation and LAD round trip."""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:8001"
FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def tree_bytes(root: Path) -> dict[str, str]:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in root.rglob("*") if p.is_file()}


async def smoke(log: Path, work: Path, args):
    env = {**os.environ, "TIA_MCP_LOG_DIR": str(log), "TIA_V16_DATA_DIR": str(work), "PYTHONUTF8": "1"}
    with (log / "server-output.txt").open("w+b") as output:
        child = subprocess.Popen([sys.executable, str(ROOT / "mcp_run.py")], cwd=ROOT,
                                 env=env, stdout=output, stderr=subprocess.STDOUT, creationflags=FLAGS)
        async with httpx.AsyncClient(base_url=BASE, trust_env=False, timeout=5.0) as http:
            own = False
            try:
                for _ in range(100):
                    if child.poll() is not None:
                        raise RuntimeError(f"server exited: {child.returncode}")
                    try:
                        ping = (await http.get("/console/ping")).json()
                        health = (await http.get("/console/health")).json()
                        if ping.get("service") == "tia-portal-v16-mcp" and child.pid in (health.get("pid"), health.get("parent_pid")):
                            own = True
                            break
                    except (httpx.HTTPError, ValueError):
                        pass
                    await asyncio.sleep(0.1)
                assert own and health["openness_ready"], (ping, health)
                print("CONSOLE ping", ping)
                print("CONSOLE environment", (await http.get("/console/environment")).json()["service"])
                blocked = await http.get("/console/ping", headers={"origin": "https://not-a-local-app.invalid"})
                assert blocked.status_code == 403, blocked.text
                print("CONSOLE cross-origin", blocked.status_code)
                async with streamable_http_client(BASE + "/mcp") as (read, write, _):
                    async with ClientSession(read, write, read_timeout_seconds=__import__("datetime").timedelta(seconds=170)) as session:
                        init = await session.initialize()
                        tools = [tool.name for tool in (await session.list_tools()).tools]
                        assert init.serverInfo.name == "tia-portal-v16-mcp" and len(tools) == 13
                        assert "download_to_plc" not in tools and "go_online" not in tools
                        print("MCP initialize", init.serverInfo.name, "tools", sorted(tools))

                        async def call(name, data=None, expected=True):
                            result = await session.call_tool(name, data or {})
                            assert not result.isError, result
                            assert result.structuredContent is not None
                            value = result.structuredContent
                            if expected is not None:
                                assert value["ok"] is expected, value
                            print("MCP", name, json.dumps(value, ensure_ascii=False)[:4000])
                            return value

                        await call("detect_tia_installations")
                        await call("get_tia_compatibility")
                        assert (await call("connect_tia", {"version": "21.0"}, False))["error"] == "unsupported_version"
                        assert (await call("connect_tia", {"portal_process_id": 1}, False))["error"] == "attach_disabled"
                        assert (await call("write_program_blocks", {"source_text": "<not-an-xml>"}, False))["error"] == "confirmation_required"
                        assert (await call("write_program_blocks", {"source_text": "<x/>", "source_file_name": "bad.s7dcl", "confirm_write": True}, False))["error"] == "unsupported"
                        assert (await call("save_project", expected=False))["error"] == "confirmation_required"
                        if args.project:
                            project = args.project.resolve()
                            original = tree_bytes(project.parent)
                            copied = await call("connect_tia", {"version": "V16", "project_file_path": str(project)}, expected=None)
                            if not copied.get("ok"):
                                raise RuntimeError(copied)
                            assert Path(copied["workspace_copy"]) != project
                            try:
                                plcs = await call("list_plcs")
                                assert len(plcs["plcs"]) == 1, plcs
                                initial = await call("get_plc_inventory", {"include_tag_entries": True})
                                assert not any(b["number"] == 1 for b in initial["blocks"]), initial
                                xml = args.xml.read_bytes()
                                template = xml.decode("utf-16" if xml.startswith((b"\xff\xfe",b"\xfe\xff")) else "utf-8-sig")
                                result = await call("write_program_blocks", {"source_text": template, "source_file_name": args.xml.name, "confirm_write": True})
                                assert any("lad" in b["language"].casefold() for b in result["blocks"]), result
                                compiled = await call("compile_plc", {"scope": "software"})
                                assert compiled["errors"] == 0, compiled
                                after = await call("get_plc_inventory")
                                main = next(b for b in after["blocks"] if b["number"] == 1)
                                exported = await call("export_program_blocks", {"target_directory": str(work), "block_names": [main["name"]]})
                                assert Path(exported["files"][0]).is_file()
                                await call("save_project", {"confirm_save": True})
                            finally:
                                await call("disconnect_tia")
                            assert original == tree_bytes(project.parent), "Original fixture changed despite copying"
                            print("FIXTURE original hash map unchanged", len(original))
                stats = (await http.get("/console/stats")).json()
                assert stats["today_count"] >= 7, stats
                print("CONSOLE statistics", stats["tool_count"], stats["session_count"])
            finally:
                if own:
                    try:
                        await http.get("/console/shutdown")
                    except httpx.HTTPError:
                        pass
                try:
                    await asyncio.to_thread(child.wait, 14)
                except subprocess.TimeoutExpired:
                    child.terminate()
                    await asyncio.to_thread(child.wait, 8)
                output.seek(0)
                print(output.read().decode("utf-8", "replace"), end="")
                print("SERVER EXIT", child.returncode)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", type=Path)
    parser.add_argument("--xml", type=Path)
    parser.add_argument("--evidence-dir", type=Path)
    args = parser.parse_args()
    if bool(args.project) != bool(args.xml):
        parser.error("--project and --xml must be provided together")
    dest = args.evidence_dir or Path(tempfile.mkdtemp(prefix="v16-verify-"))
    dest.mkdir(parents=True, exist_ok=True)
    asyncio.run(smoke(dest, dest / "copies", args))
