"""TIA Portal V16 MCP — standalone, isolated, offline project copies only."""
from __future__ import annotations

import argparse
import asyncio
from contextlib import asynccontextmanager
from functools import wraps
import json
import os
import re
from pathlib import Path
from queue import Empty, Queue
import shutil
import subprocess
import sys
import tempfile
from threading import Lock, Thread
from time import perf_counter
from typing import Any
import xml.etree.ElementTree as ET

from mcp.server.fastmcp import FastMCP
from starlette.responses import JSONResponse
import uvicorn

from console_runtime import ConsoleRuntime, open_log_directory

ROOT = Path(__file__).resolve().parent
VERSION = "0.1.0"
SERVICE = "tia-portal-v16-mcp"
HOST = "127.0.0.1"
PORT = 8001
WORK = Path(os.getenv("TIA_V16_DATA_DIR") or Path(os.getenv("LOCALAPPDATA", ROOT)) / "RobotAssociation" / "TiaMcpV16")
BRIDGE = ROOT / "bin" / "TiaBridgeV16.exe"
VERSIONS = {"auto", "16", "16.0", "v16", "v16.0"}
TOOLS: list[str] = []
GROUP = "Siemens TIA Openness"
runtime = ConsoleRuntime()


def api_path() -> Path | None:
    path = os.getenv("TIA_V16_PUBLICAPI_DLL")
    if path:
        candidate = Path(path).expanduser()
        return candidate.resolve() if candidate.is_absolute() and candidate.is_file() else None
    primary = Path(os.getenv("ProgramFiles", "C:/Program Files")) / "Siemens/Automation/Portal V16/PublicAPI/V16/Siemens.Engineering.dll"
    return primary.resolve() if primary.is_file() else None


def fail(message: str, error: str = "unsupported") -> dict[str, Any]:
    return {"ok": False, "error": error, "message": message}


class Worker:
    def __init__(self) -> None:
        self.lock = Lock()
        self.child: subprocess.Popen[str] | None = None
        self.answers: Queue[str | None] = Queue()
        self.status: dict[str, Any] = {"ok": True, "connected": False, "version": "16.0", "project": None, "selected_plc": None, "pid": None, "isolated": True}
        self.timed_out = False

    def _start(self) -> None:
        api = api_path()
        if not api or not BRIDGE.is_file():
            raise RuntimeError("请先安装 TIA Portal V16 / Openness，再运行 build-bridge.ps1。")
        runtime.log_dir.mkdir(parents=True, exist_ok=True)
        messages: Queue[str | None] = Queue()
        with (runtime.log_dir / "bridge-stderr.txt").open("ab") as err:
            child = subprocess.Popen(
                [str(BRIDGE), str(api)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=err, text=True, encoding="utf-8", errors="strict",
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        self.child, self.answers = child, messages

        def reader() -> None:
            try:
                assert child.stdout is not None
                with child.stdout:
                    for line in child.stdout:
                        messages.put(line)
            finally:
                messages.put(None)

        Thread(target=reader, daemon=True, name="v16-bridge-stdout").start()

    def _exchange(self, op: str, **kwargs: Any) -> dict[str, Any]:
        if self.timed_out:
            return fail("上次请求尚未确认完成。请不要重复打开；检查博途授权提示，再停止并重启本服务。", "bridge_timeout")
        if self.child is None or self.child.poll() is not None:
            self._start()
        assert self.child is not None and self.child.stdin is not None
        self.child.stdin.write(json.dumps({"op": op, **kwargs}, ensure_ascii=False) + "\n")
        self.child.stdin.flush()
        try:
            line = self.answers.get(timeout=150)
        except Empty:
            self.timed_out = True
            return {**fail("V16 调用超时，请检查是否等待 Openness 人工授权。", "bridge_timeout"),
                    "needs_user_action": True, "user_action": {"steps": ["在 Windows 查看并确认来自本 V16 桥接程序的 Openness 提示。","不要重复打开；完成授权后停止并重启 V16 服务。"]}}
        if line is None:
            return fail("V16 桥接进程已退出，请查看 bridge-stderr.txt。", "bridge_exit")
        result = json.loads(line)
        if result.get("ok") and "connected" in result:
            self.status = result
        return result

    def call(self, op: str, **kwargs: Any) -> dict[str, Any]:
        with self.lock:
            try:
                return self._exchange(op, **kwargs)
            except (OSError, RuntimeError, ValueError) as exc:
                return fail(str(exc), "bridge_unavailable")

    def open(self, path: str, plc: str | None) -> dict[str, Any]:
        with self.lock:
            if self.status["connected"] or self.timed_out:
                return fail("请先关闭现有会话；不自动启动第二个实例。", "session_active")
            try:
                project = Path(path)
                if not project.is_absolute() or project.suffix.lower() != ".ap16" or not project.is_file():
                    return fail("只接受已关闭的本地 .ap16 工程文件的绝对路径。", "invalid_project")
                project = project.resolve()
                if project.parent.name.casefold() != project.stem.casefold():
                    return fail("工程文件必须位于与工程同名的独立文件夹，防止误复制无关文件。", "invalid_project")
                # 只复制整个工程目录，不跟随符号链接与重解析目录。
                for directory, dirs, files in os.walk(project.parent):
                    for name in [*dirs, *files]:
                        source = Path(directory) / name
                        if source.is_symlink() or source.is_junction():
                            return fail("工程目录含链接或目录联接，请先创建干净的离线副本。", "linked_project")
                WORK.mkdir(parents=True, exist_ok=True)
                case = Path(tempfile.mkdtemp(prefix="project-", dir=WORK))
                clone = case / project.parent.name
                shutil.copytree(project.parent, clone)
                result = self._exchange("open_copy", path=str(clone / project.name), plc=plc)
                return {**result, "original_project": str(project), "workspace_copy": str(clone / project.name)}
            except (OSError, RuntimeError, ValueError) as exc:
                return fail(str(exc), "open_failed")

    def close(self) -> None:
        with self.lock:
            child = self.child
            if child is None:
                return
            # EOF lets the bridge dispose only its own Portal, even if its previous request later finishes.
            if child.stdin:
                child.stdin.close()
            try:
                child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                return
            self.child = None


worker = Worker()


mcp = FastMCP(SERVICE,
              instructions="仅 TIA Portal V16。只开无界面隔离实例并操作 .ap16 副本，不附加现有实例，不进行在线或下载。LAD 使用 V16 SimaticML XML，不接受 .s7dcl。",
              host=HOST, port=PORT, stateless_http=True, json_response=True)


def tool(fn):
    @wraps(fn)
    async def counted(*args, **kwargs):
        start = perf_counter()
        result = await asyncio.to_thread(fn, *args, **kwargs)
        runtime.record_tool_call(fn.__name__, ok=result.get("ok", False),
                                 duration_ms=round((perf_counter() - start) * 1000),
                                 error=result.get("error"))
        return result
    TOOLS.append(fn.__name__)
    mcp.tool()(counted)
    return counted


def openness() -> dict[str, Any]:
    try:
        verify = subprocess.run(["whoami.exe", "/groups", "/fo", "csv", "/nh"], capture_output=True, timeout=4,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        member = GROUP.lower().encode() in verify.stdout.lower() if verify.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        member = None
    return {"ok": bool(member), "status": "member" if member else "missing" if member is False else "unknown",
            "member": member, "required_group": GROUP, "current_user": os.getenv("USERNAME", ""),
            "message": f"当前会话{'已' if member else '尚未确认'}属于 {GROUP}。",
            "action_steps": [] if member else ["把当前 Windows 用户加入 Siemens TIA Openness 组，注销后重新登录。"]}


@tool
def detect_tia_installations() -> dict[str, Any]:
    """检测本机 V16 PublicAPI 文件，不连接博途。"""
    api = api_path()
    return {"ok": True, "installed": bool(api), "version": "16.0", "public_api_path": str(api) if api else None,
            "bridge_ready": BRIDGE.is_file(), "supported_versions": ["16.0"]}


@tool
def check_openness_prerequisites() -> dict[str, Any]:
    """检查当前 Windows 权限与 V16 本地程序集，不启动或连接博途。"""
    detected, group = api_path(), openness()
    return {**group, "ok": bool(detected and BRIDGE.is_file() and group["ok"]),
            "version": "16.0", "public_api_path": str(detected) if detected else None, "bridge_ready": BRIDGE.is_file()}


@tool
def get_tia_compatibility() -> dict[str, Any]:
    """返回 V16 首版能力和明确不支持的操作。"""
    return {"ok": True, "version": "16.0", "supported_versions": ["16.0"], "isolated_only": True,
            "simaticml": True, "simatic_sd_lad": False, "lad_write": "v16_xml_only",
            "scl_external_source": False, "online": False, "hmi": False,
            "registered_tools": TOOLS}


@tool
def connect_tia(version: str = "auto", portal_mode: str = "any-ui", project_file_path: str | None = None,
                plc_name: str | None = None, portal_process_id: int | None = None) -> dict[str, Any]:
    """仅连接独立 V16 无界面实例；将已关闭的本地 .ap16 工程复制到隔离目录。"""
    if version.strip().casefold() not in VERSIONS:
        return fail("本服务仅支持 TIA Portal V16。", "unsupported_version")
    if portal_process_id is not None or portal_mode not in {"any-ui", "without-ui", "isolated"}:
        return fail("本版只允许新起隔离实例，不附加指定 PID 或当前界面。", "attach_disabled")
    if not project_file_path:
        return fail("请提供 .ap16 工程绝对路径；原工程须先关闭。", "project_required")
    return worker.open(project_file_path, plc_name)


@tool
def disconnect_tia(close_portal: bool = False, confirm_close: bool = False) -> dict[str, Any]:
    """关闭本服务自建会话；不影响其他博途实例，未保存副本的修改将被丢弃。"""
    if close_portal and not confirm_close:
        return fail("如果指定 close_portal=true，需要 confirm_close=true。", "confirmation_required")
    if worker.child is None:
        return dict(worker.status)
    return worker.call("disconnect")


@tool
def get_tia_status() -> dict[str, Any]:
    """读取当前隔离 V16 会话状态。"""
    return dict(worker.status)


@tool
def list_plcs() -> dict[str, Any]:
    """列出当前 .ap16 副本中的 PLC。"""
    return worker.call("plcs")


@tool
def select_plc(plc_name: str) -> dict[str, Any]:
    """按名称选择唯一 PLC。"""
    return worker.call("select", plc=plc_name)


@tool
def get_plc_inventory(plc_name: str | None = None, include_tag_entries: bool = False,
                      include_properties: bool = False) -> dict[str, Any]:
    """读取程序块与变量表；可带变量地址，暂不读取硬件属性。"""
    if include_properties:
        return fail("V16 首版暂不支持 include_properties。")
    return worker.call("inventory", plc=plc_name, tags=str(include_tag_entries).lower())


@tool
def export_program_blocks(target_directory: str, block_names: list[str] | None = None,
                          export_format: str = "simaticml", plc_name: str | None = None) -> dict[str, Any]:
    """以 V16 SimaticML XML 导出程序块；使用新建子目录避免覆盖既有文件。"""
    if export_format.casefold() not in {"simaticml", "xml"}:
        return fail("V16 仅支持 SimaticML XML 导出。")
    try:
        base = Path(target_directory)
        if not base.is_absolute() or not base.is_dir():
            return fail("导出目录必须是一个已存在的绝对路径。", "invalid_path")
        out = tempfile.mkdtemp(prefix="v16-xml-", dir=base)
        return worker.call("export", directory=out, names=block_names, plc=plc_name)
    except OSError as exc:
        return fail(str(exc), "invalid_path")


@tool
def write_program_blocks(source_text: str, source_file_name: str = "mcp_source.xml",
                         target_folder_path: str | None = None, plc_name: str | None = None,
                         allow_overwrite: bool = False, cleanup_external_source: bool = True,
                         confirm_write: bool = False, allow_ob_source: bool = False) -> dict[str, Any]:
    """仅非覆盖导入由 V16 导出的单个 SimaticML 程序块，写入隔离副本；须显式确认。"""
    if not confirm_write or allow_overwrite:
        return fail("需要 confirm_write=true；本版不支持覆盖块。", "confirmation_required")
    if Path(source_file_name).suffix.casefold() != ".xml":
        return fail("只接受 .xml，SCL 外部源与 .s7dcl 当前不支持。")
    try:
        body = source_text.encode("utf-8")
        if len(body) > 4_000_000 or b"<!doctype" in body.lower() or b"<!entity" in body.lower() or "\x00" in source_text:
            return fail("拒绝过长的 XML、DTD、实体或 NUL。", "invalid_xml")
        normalized = re.sub(r"^\ufeff?\s*<\?xml[^?]*\?>", "", source_text, count=1).lstrip("\ufeff")
        body = normalized.encode("utf-8")
        root = ET.fromstring(body)
        version = root.find("Engineering")
        blocks = [b for b in root if b.tag in {"SW.Blocks.FB", "SW.Blocks.FC", "SW.Blocks.OB", "SW.Blocks.GlobalDB"}]
        if root.tag != "Document" or version is None or version.get("version") != "V16" or len(blocks) != 1:
            return fail("XML 需要包含一个 V16 导出的 FB、FC、OB 或全局 DB。", "invalid_xml")
        with tempfile.TemporaryDirectory(prefix="tia-v16-xml-") as folder:
            path = Path(folder) / "block.xml"
            path.write_bytes(body)
            return worker.call("import", path=str(path), folder=target_folder_path, plc=plc_name)
    except (OSError, UnicodeError, ET.ParseError, ValueError) as exc:
        return fail(str(exc), "invalid_xml")


@tool
def compile_plc(scope: str = "both", plc_name: str | None = None) -> dict[str, Any]:
    """离线编译隔离副本中的硬件、软件或两者，返回西门子诊断。"""
    if scope not in {"software", "hardware", "both"}:
        return fail("scope 可选 software、hardware、both。", "invalid_scope")
    return worker.call("compile", plc=plc_name, scope=scope)


@tool
def save_project(confirm_save: bool = False) -> dict[str, Any]:
    """显式保存隔离副本；不会写入原工程。"""
    if not confirm_save:
        return fail("需要 confirm_save=true，仅保存副本。", "confirmation_required")
    return worker.call("save")


@mcp.custom_route("/console/ping", methods=["GET"])
async def ping(request):
    return JSONResponse({"ok": True, "service": SERVICE, "version": VERSION})


@mcp.custom_route("/console/health", methods=["GET"])
async def health(request):
    ready = bool(api_path() and BRIDGE.is_file())
    return JSONResponse({"ok": True, "pid": os.getpid(), "parent_pid": os.getppid(), "openness_ready": ready,
                         "openness_missing": [] if ready else ["V16 PublicAPI / TiaBridgeV16.exe"]})


@mcp.custom_route("/console/stats", methods=["GET"])
async def stats(request):
    try:
        days = int(request.query_params.get("days", 30))
    except ValueError:
        days = 30
    return JSONResponse(runtime.snapshot(days))


@mcp.custom_route("/console/environment", methods=["GET"])
async def environment(request):
    pid = worker.status.get("pid")
    bridge_state = dict(worker.status)
    bridge_state["plc"] = bridge_state.get("selected_plc")
    return JSONResponse({"ok": True, "tia": {"label": "TIA Portal V16", "running": bool(pid),
                         "processes": [{"pid": pid, "role": "portal"}] if pid else []},
                         "openness": await asyncio.to_thread(openness), "service": bridge_state})


@mcp.custom_route("/console/open-log-dir", methods=["GET", "POST"])
async def open_log(request):
    return JSONResponse(await asyncio.to_thread(open_log_directory, runtime.log_dir))


@mcp.custom_route("/console/shutdown", methods=["GET", "POST"])
async def shutdown(request):
    server.should_exit = True
    return JSONResponse({"ok": True, "message": "V16 MCP 正在关停，只关闭自己的隔离实例。"})


async def loopback(scope, receive, send):
    if scope["type"] == "http":
        headers = dict(scope["headers"])
        allowed = {b"127.0.0.1", b"localhost", f"127.0.0.1:{PORT}".encode(), f"localhost:{PORT}".encode()}
        origin = headers.get(b"origin")
        if headers.get(b"host") not in allowed or headers.get(b"sec-fetch-site") == b"cross-site" or (
            origin is not None and origin not in {b"http://" + x for x in allowed}
        ):
            return await JSONResponse({"ok": False, "error": "local_clients_only"}, status_code=403)(scope, receive, send)
    return await app(scope, receive, send)


app = mcp.streamable_http_app()
sdk_lifespan = app.router.lifespan_context


@asynccontextmanager
async def process_lifespan(asgi):
    # Stateless MCP request sessions must not own the Openness process.
    runtime.start(version=VERSION, tool_count=len(TOOLS))
    try:
        async with sdk_lifespan(asgi) as state:
            yield state
    finally:
        await asyncio.to_thread(worker.close)
        runtime.stop()


app.router.lifespan_context = process_lifespan
server = uvicorn.Server(uvicorn.Config(loopback, host=HOST, port=PORT, access_log=False))

if __name__ == "__main__":
    cli = argparse.ArgumentParser(description="Standalone TIA Portal V16 MCP")
    cli.add_argument("--info", action="store_true")
    args = cli.parse_args()
    if args.info:
        print(json.dumps({"ok": True, "version": VERSION, "tool_count": len(TOOLS), "service": SERVICE}, ensure_ascii=False))
    else:
        print(f"机器人协会 · TIA Portal V16 MCP {VERSION} | http://{HOST}:{PORT}/mcp", flush=True)
        server.run()
