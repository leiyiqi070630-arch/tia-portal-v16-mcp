"""控制台运行期统计：会话日志、调用计数与历史曲线数据。

设计要点
--------
* 每次 MCP 进程启动都会在日志目录新建一个会话日志文件，文件名按
  ``年月日-时分秒`` 生成；服务日志与工具调用记录都写入该文件，重启即换新文件。
* 日累计次数写入日志目录的 ``usage.json``（临时文件 + 原子替换），桌面控制台
  在服务停止后仍能读取「今日访问」与历史曲线。
* 只统计 ``tools/call``：``initialize``、``tools/list`` 等协议握手不算访问。
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import tempfile
import threading
import time
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

SERVICE_DIRECTORY = Path(__file__).resolve().parent

LOG_DIR_ENV = "TIA_MCP_LOG_DIR"
LEDGER_NAME = "usage.json"
LEDGER_VERSION = 1
LOGGER_NAME = "tia-mcp-v16.console"
SESSION_STAMP = "%Y%m%d-%H%M%S"
MAX_HISTORY_DAYS = 366
KEEP_LEDGER_DAYS = 400

logger = logging.getLogger(LOGGER_NAME)
# 控制台日志按 INFO 记录：root 默认 WARNING 会把「调用完成」这类记录吞掉。
logger.setLevel(logging.INFO)


def resolve_log_dir() -> Path:
    """日志目录：优先环境变量 ``TIA_MCP_LOG_DIR``，否则服务安装目录下的 ``log``。"""
    override = os.environ.get(LOG_DIR_ENV, "").strip()
    if override:
        return Path(override).expanduser()
    return SERVICE_DIRECTORY / "log"


def open_log_directory(path: Path | str | None = None) -> dict[str, Any]:
    """在 Windows 资源管理器中打开日志目录。

    由 **MCP 服务进程**执行：控制台（Electron）直接 shell 执行会被部分安全软件
    拦成「Windows 无法访问指定设备、路径或文件」，换到 python 进程里用
    ``explorer.exe`` 打开可以绕过这条拦截。
    """
    target = Path(path) if path is not None else resolve_log_dir()
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return {"ok": False, "path": str(target), "error": f"日志目录不可用：{error}"}
    if os.name != "nt":
        return {"ok": False, "path": str(target), "error": "只支持 Windows 资源管理器。"}
    explorer_error: str | None = None
    try:
        subprocess.Popen(["explorer.exe", os.fspath(target)], close_fds=True)
        return {"ok": True, "path": str(target), "method": "explorer"}
    except OSError as error:
        explorer_error = str(error)
    try:
        os.startfile(os.fspath(target))  # type: ignore[attr-defined]
        return {"ok": True, "path": str(target), "method": "startfile"}
    except OSError as error:
        return {"ok": False, "path": str(target), "error": str(error) or explorer_error or ""}


def _today_key() -> str:
    return date.today().isoformat()


def _format_duration(milliseconds: int) -> str:
    if milliseconds < 1000:
        return f"{milliseconds}ms"
    return f"{milliseconds / 1000:.1f}s"


class ConsoleRuntime:
    """一次 MCP 进程生命周期的日志与计数容器（线程安全）。"""

    def __init__(self, log_dir: Path | None = None) -> None:
        self.log_dir = Path(log_dir) if log_dir is not None else resolve_log_dir()
        self.session_file: Path | None = None
        self.started_at: datetime | None = None
        self._lock = threading.RLock()
        self._days: dict[str, int] = {}
        self._meta: dict[str, Any] = {}
        self._session_count = 0
        self._handler: logging.Handler | None = None
        self._active = False
        self._load_ledger()

    # ------------------------------------------------------------------ 生命周期
    def start(self, *, version: str, tool_count: int) -> Path | None:
        """创建会话日志文件并挂到根 logger；返回日志文件路径（失败时返回 None）。"""
        logger.setLevel(logging.INFO)
        with self._lock:
            self._meta = {
                "version": version,
                "tool_count": int(tool_count),
                "started_at": datetime.now().isoformat(timespec="seconds"),
            }
            self.started_at = datetime.now()
            self._active = True
            self.session_file = self._allocate_session_file(self.started_at)
            try:
                self.log_dir.mkdir(parents=True, exist_ok=True)
                handler = logging.FileHandler(self.session_file, encoding="utf-8")
                handler.setLevel(logging.INFO)
                handler.setFormatter(
                    logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
                )
                logging.getLogger().addHandler(handler)
                self._handler = handler
            except OSError as error:  # 日志不可写不能拖垮 MCP 服务
                self.session_file = None
                logger.warning("无法创建会话日志文件：%s", error)
            try:
                self._save_ledger()
            except OSError as error:
                logger.warning("无法写入访问计数文件：%s", error)
            profile = f"v{version} | 工具 {tool_count} 个"
        logger.info("[启动] TIA Portal V16 MCP %s", profile)
        logger.info(
            "[启动] 端点 http://127.0.0.1:8001/mcp | 日志目录 %s", self.log_dir
        )
        return self.session_file

    def stop(self) -> None:
        """关闭会话日志（仅移除本次添加的 handler，不影响 uvicorn 自己的输出）。"""
        with self._lock:
            handler, self._handler = self._handler, None
            if handler is None:
                return
            self._active = False
            logger.info("[停止] MCP 服务结束，本次启动访问 %d 次", self._session_count)
            handler.flush()
            logging.getLogger().removeHandler(handler)
            handler.close()

    def _allocate_session_file(self, stamp: datetime) -> Path:
        base = stamp.strftime(SESSION_STAMP)
        candidate = self.log_dir / f"{base}.log"
        index = 2
        while candidate.exists():
            candidate = self.log_dir / f"{base}-{index}.log"
            index += 1
        return candidate

    # ------------------------------------------------------------------ 计数
    def record_tool_call(
        self,
        tool: str,
        *,
        ok: bool,
        duration_ms: int,
        error: str | None = None,
    ) -> None:
        """记一次工具调用：更新今日/本次启动计数与历史账本，并写日志。"""
        key = _today_key()
        with self._lock:
            self._days[key] = self._days.get(key, 0) + 1
            self._session_count += 1
            try:
                self._save_ledger()
            except OSError as exc:
                logger.warning("访问计数写入失败：%s", exc)
        text = (
            f"[调用] {tool or 'unknown'} {'完成' if ok else '失败'} "
            f"{_format_duration(duration_ms)}"
        )
        if error:
            text = f"{text} | {error[:300]}"
        if ok:
            logger.info(text)
        else:
            logger.warning(text)

    @property
    def session_count(self) -> int:
        with self._lock:
            return self._session_count

    # ------------------------------------------------------------------ 快照
    def snapshot(self, days: int = 30) -> dict[str, Any]:
        """返回控制台需要的统计快照；``days`` 限定历史曲线长度。"""
        days = max(1, min(int(30 if days is None else days), MAX_HISTORY_DAYS))
        now = datetime.now()
        with self._lock:
            counts = dict(self._days)
            session_count = self._session_count
            meta = dict(self._meta)
            started_at = self.started_at
            session_file = self.session_file
        today = now.date().isoformat()
        history = []
        for offset in range(days - 1, -1, -1):
            key = (now.date() - timedelta(days=offset)).isoformat()
            history.append({"date": key, "count": counts.get(key, 0)})
        return {
            "ok": True,
            "version": meta.get("version", ""),
            "pid": os.getpid(),
            "tool_count": meta.get("tool_count", 0),
            "started_at": started_at.isoformat(timespec="seconds")
            if started_at
            else None,
            "uptime_seconds": round((now - started_at).total_seconds(), 1)
            if started_at
            else 0,
            "today": today,
            "today_count": counts.get(today, 0),
            "session_count": session_count,
            "total_count": sum(counts.values()),
            "history": history,
            "log_dir": str(self.log_dir),
            "log_file": str(session_file) if session_file else None,
            "endpoint": "http://127.0.0.1:8001/mcp",
        }

    # ------------------------------------------------------------------ 账本
    def _ledger_path(self) -> Path:
        return self.log_dir / LEDGER_NAME

    def _load_ledger(self) -> None:
        path = self._ledger_path()
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        days = payload.get("days")
        if isinstance(days, dict):
            self._days = {
                str(key): int(value)
                for key, value in days.items()
                if str(key) and isinstance(value, (int, float))
            }
        meta = payload.get("meta")
        if isinstance(meta, dict):
            self._meta = dict(meta)

    def _save_ledger(self) -> None:
        self.log_dir.mkdir(parents=True, exist_ok=True)
        tail = (date.today() - timedelta(days=KEEP_LEDGER_DAYS)).isoformat()
        self._days = {key: value for key, value in self._days.items() if key >= tail}
        payload = {
            "version": LEDGER_VERSION,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
            "meta": self._meta,
            "days": self._days,
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2)
        target = self._ledger_path()
        handle, temp_name = tempfile.mkstemp(
            prefix="usage-", suffix=".tmp", dir=str(self.log_dir)
        )
        try:
            with os.fdopen(handle, "w", encoding="utf-8") as stream:
                stream.write(text)
            for attempt in range(5):
                try:
                    os.replace(temp_name, target)
                    return
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.05)
        finally:
            if os.path.exists(temp_name):
                try:
                    os.unlink(temp_name)
                except OSError:
                    pass


def _tool_name(params: Any) -> str:
    if isinstance(params, dict):
        return str(params.get("name") or "")
    return str(getattr(params, "name", "") or "")
