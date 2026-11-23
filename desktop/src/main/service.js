'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');

const {
  OUTPUT_BUFFER_LINES,
  SHUTDOWN_URL,
  ensureLogDir,
  roots,
  serviceEnv,
} = require('./config');
const { requestJson } = require('./stats');

const STOP_TIMEOUT_MS = 8000;
const GRACEFUL_REQUEST_MS = 1500;
const GRACEFUL_WAIT_MS = 5000;

/** 进程是否还存在（Node 在 Windows 上也能用 kill(pid, 0) 探测）。 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** 把 Windows 退出码统一成无符号值（Node 有时给的是 int32 负数）。 */
function unsignedExitCode(code) {
  if (typeof code !== 'number') return null;
  return code < 0 ? code + 0x100000000 : code;
}

/** 已知的崩溃退出码 → 可读解释。 */
function describeCrash(code) {
  switch (code) {
    case 0xe0434352:
      return '服务进程因 .NET 异常退出（0xE0434352）：多为 Openness 程序集缺失，请确认本机 V16 PublicAPI 完整并重新运行 build-bridge.ps1。';
    case 0xc0000005:
      return '服务进程崩溃（0xC0000005，访问冲突），请查看运行日志。';
    case 0xc0000409:
      return '服务进程崩溃（0xC0000409，栈溢出/安全检查失败），请查看运行日志。';
    default:
      return `服务进程已退出（退出码 ${code}），请查看运行日志。`;
  }
}

function stamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/** 负责 MCP 服务进程的启动、停止与 stdout 捕获。 */
class ServiceController extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = 'stopped';
    this.pid = null;
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastError = null;
    this.external = false;
    this.output = [];
    this._stopRequested = false;
  }

  get running() {
    return this.state === 'running' || this.state === 'starting';
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', this.describe());
  }

  describe() {
    return {
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      lastError: this.lastError,
      external: this.external,
      command: roots.service.command,
      cwd: roots.service.cwd,
      hasOutput: this.output.length > 0,
    };
  }

  _pushOutput(text) {
    this.output.push(`${stamp()} ${text}`);
    if (this.output.length > OUTPUT_BUFFER_LINES) {
      this.output.splice(0, this.output.length - OUTPUT_BUFFER_LINES);
    }
  }

  _consume(stream, level) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        const trimmed = line.trimEnd();
        if (trimmed) {
          this._pushOutput(level === 'error' ? `[stderr] ${trimmed}` : trimmed);
        }
      }
    });
    stream.on('end', () => {
      if (buffer.trim()) this._pushOutput(`[${level}] ${buffer.trim()}`);
    });
  }

  /** 启动 MCP 服务；返回 { ok, message }。 */
  async start() {
    if (this.running) {
      return { ok: true, message: '服务已在运行' };
    }
    if (this.state === 'stopping') {
      return { ok: false, message: '服务正在停止，请稍候' };
    }
    if (!fs.existsSync(roots.service.command)) {
      this.lastError = roots.packaged
        ? `未找到 MCP 服务程序：${roots.service.command}`
        : `未找到 Python 解释器：${roots.service.command}`;
      return { ok: false, message: this.lastError };
    }

    ensureLogDir();
    this.lastError = null;
    this.stoppedAt = null;
    this.external = false;
    this._stopRequested = false;
    this.output = [];
    this._setState('starting');

    let child;
    try {
      child = spawn(roots.service.command, roots.service.args, {
        cwd: roots.service.cwd,
        env: serviceEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      this.lastError = `启动失败：${error.message}`;
      this._setState('stopped');
      return { ok: false, message: this.lastError };
    }

    this.child = child;
    this.pid = child.pid ?? null;
    if (child.stdout) this._consume(child.stdout, 'stdout');
    if (child.stderr) this._consume(child.stderr, 'stderr');

    child.once('error', (error) => {
      this.child = null;
      this.pid = null;
      this.lastError = `服务进程异常：${error.message}`;
      this._setState('stopped');
    });

    child.once('exit', (code, signal) => {
      const wasStopping = this._stopRequested;
      this.child = null;
      this.pid = null;
      this.stoppedAt = new Date().toISOString();
      this.startedAt = null;
      this._stopRequested = false;
      if (!wasStopping && code !== 0) {
        if (code === 2) {
          this.lastError =
            '服务启动检查未通过（端口被占用或 Openness 用户组未授权），请查看运行日志。';
        } else if (typeof code === 'number') {
          this.lastError = describeCrash(unsignedExitCode(code));
        } else {
          this.lastError = `服务进程已被终止（${signal}），请查看运行日志。`;
        }
      }
      this.external = false;
      this._setState('stopped');
    });

    return { ok: true, message: '正在启动 MCP 服务' };
  }

  /** 健康检查通过后由轮询器调用。 */
  markRunning(pid) {
    if (this.state === 'stopped') {
      // 外部已有一个服务实例在跑：接管展示，允许通过控制台关闭。
      this.external = true;
      this.pid = pid ?? null;
      this.startedAt = this.startedAt ?? new Date().toISOString();
      this._setState('running');
      return;
    }
    if (this.state === 'starting' || this.state === 'running') {
      if (pid && !this.pid) this.pid = pid;
      this.startedAt = this.startedAt ?? new Date().toISOString();
      this._setState('running');
    }
  }

  /** 健康检查失败时由轮询器调用。 */
  markUnreachable() {
    if (this.state === 'running' && this.external) {
      this.pid = null;
      this.startedAt = null;
      this.external = false;
      this._setState('stopped');
    }
  }

  /** 进程是否还活着：child 有句柄就等 exit，外部实例靠 kill(pid,0) 探测。 */
  _waitForExit(timeoutMs) {
    return new Promise((resolve) => {
      if (this.child) {
        let done = false;
        const finish = (value) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), timeoutMs);
        this.child.once('exit', () => finish(true));
        return;
      }
      const pid = this.pid;
      if (!pid) {
        resolve(true);
        return;
      }
      const startedAt = Date.now();
      const poll = () => {
        if (!isPidAlive(pid)) {
          resolve(true);
          return;
        }
        if (Date.now() - startedAt >= timeoutMs) {
          resolve(false);
          return;
        }
        setTimeout(poll, 200);
      };
      poll();
    });
  }

  async stop() {
    const targetPid = this.pid;
    if (!this.child && !targetPid) {
      this._setState('stopped');
      return { ok: true, message: '服务已停止' };
    }
    this._stopRequested = true;
    this._setState('stopping');

    // 先请求服务自己优雅退出：它会 detach TIA，避免把 Openness 会话打断
    // （强杀 python 后 TIA 侧仍占着连接，下一次 attach 会抛 TargetInvocationException）。
    if (targetPid) {
      const graceful = await requestJson(SHUTDOWN_URL, GRACEFUL_REQUEST_MS);
      if (graceful && graceful.ok && (await this._waitForExit(GRACEFUL_WAIT_MS))) {
        this.pid = null;
        this.startedAt = null;
        this.stoppedAt = Date.now();
        this.external = false;
        this.child = null;
        this._setState('stopped');
        return {
          ok: true,
          graceful: true,
          message: graceful.detached
            ? 'MCP 服务已关停并断开 TIA 连接'
            : 'MCP 服务已优雅关停',
        };
      }
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, STOP_TIMEOUT_MS);
      if (this.child) {
        this.child.once('exit', finish);
      } else {
        // 外部实例：没有 child 句柄，直接结束等待
        finish();
      }
      execFile(
        'taskkill',
        ['/PID', String(targetPid), '/T', '/F'],
        { windowsHide: true },
        (error) => {
          if (error && !this.child) {
            this.pid = null;
            this.startedAt = null;
            this.external = false;
            this._setState('stopped');
          }
          if (!this.child) finish();
        },
      );
    });

    if (this.state === 'stopping') {
      // 兜底：taskkill 已执行但 child 未回调
      this.pid = null;
      this.startedAt = null;
      this.external = false;
      this._setState('stopped');
    }
    return { ok: true, graceful: false, message: 'MCP 服务已停止' };
  }

  /** 应用退出时同步收尾，避免留下孤儿进程。 */
  killSync() {
    if (!this.child && !this.pid) return;
    const targetPid = this.pid;
    this.child = null;
    this.pid = null;
    try {
      execFile('taskkill', ['/PID', String(targetPid), '/T', '/F'], { windowsHide: true });
    } catch {
      // 忽略：退出阶段不再抛错
    }
  }
}

module.exports = { ServiceController };
