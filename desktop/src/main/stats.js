'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');

const {
  ENDPOINT,
  ENVIRONMENT_URL,
  LOG_TAIL_LINES,
  PING_URL,
  STATS_URL,
  ensureLogDir,
  roots,
} = require('./config');

const MAX_LOG_BYTES = 4 * 1024 * 1024;
const OPENNESS_GROUP = 'Siemens TIA Openness';
// 优先采用 V16 服务自己的进程 PID；本地 tasklist 无法区分同名的 V21。

function requestJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        finish(null);
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => {
        try {
          finish(JSON.parse(body));
        } catch {
          finish(null);
        }
      });
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => finish(null));
  });
}

function isoDate(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 同步执行一条命令并取回 Buffer。
 * 用 latin1 解码：Openness 组名是 ASCII，中文乱码不影响关键字匹配，
 * 同时避免按系统代码页猜编码的问题。
 */
function captureBuffer(file, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ ok: false, text: `${stdout || ''}\n${stderr || ''}`, error: error.message });
          return;
        }
        resolve({ ok: true, text: String(stdout || '') });
      },
    );
  });
}

/** 本机直接探测博途进程与 Openness 用户组（服务没启动时也能显示）。 */
async function localEnvironment() {
  const whoami = await captureBuffer('whoami.exe', ['/groups', '/fo', 'csv', '/nh'], 6000);
  const pids = [];
  let status = 'unknown';
  if (whoami.ok) {
    status = (whoami.text || '').toLowerCase().includes(OPENNESS_GROUP.toLowerCase())
      ? 'member'
      : 'missing';
  }

  return {
    ok: true,
    source: 'local',
    checked_at: new Date().toISOString(),
    tia: { label: 'TIA Portal V16', running: pids.length > 0, processes: pids },
    openness: {
      ok: status === 'member',
      status,
      member: status === 'member',
      current_user: process.env.USERNAME || '',
      required_group: OPENNESS_GROUP,
      message:
        status === 'member'
          ? `当前用户已属于「${OPENNESS_GROUP}」组。`
          : status === 'missing'
            ? `当前用户不在「${OPENNESS_GROUP}」组，Openness 调用会被拒绝。`
            : '无法确认 Openness 用户组成员的资格。',
      action_steps:
        status === 'member'
          ? []
          : [
              '打开“计算机管理 → 本地用户和组 → 组”。',
              `把当前用户加入“${OPENNESS_GROUP}”组。`,
              '注销并重新登录 Windows（仅重启 MCP 不会刷新登录令牌）。',
              '重新启动 TIA Portal 与 MCP 服务后再次连接。',
            ],
    },
  };
}

function readLedger(logDir) {
  try {
    const raw = fs.readFileSync(path.join(logDir, 'usage.json'), 'utf8');
    const data = JSON.parse(raw);
    const days = data && typeof data.days === 'object' && data.days ? data.days : {};
    const meta = data && typeof data.meta === 'object' && data.meta ? data.meta : {};
    return { days, meta };
  } catch {
    return null;
  }
}

function readMetaFile() {
  try {
    return JSON.parse(fs.readFileSync(roots.metaFile, 'utf8'));
  } catch {
    return null;
  }
}

function historyFromLedger(ledger, days) {
  const today = new Date();
  const result = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const key = isoDate(date);
    const value = ledger && ledger.days ? Number(ledger.days[key]) : 0;
    result.push({ date: key, count: Number.isFinite(value) ? value : 0 });
  }
  return result;
}

function totalFromLedger(ledger) {
  if (!ledger) return 0;
  return Object.values(ledger.days || {}).reduce((sum, value) => {
    const number = Number(value);
    return sum + (Number.isFinite(number) ? number : 0);
  }, 0);
}

function newestLogFile(logDir) {
  let best = null;
  let bestTime = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.log')) continue;
    const full = path.join(logDir, entry.name);
    try {
      const stat = fs.statSync(full);
      if (stat.mtimeMs > bestTime) {
        best = full;
        bestTime = stat.mtimeMs;
      }
    } catch {
      // 文件可能刚好被重命名，忽略
    }
  }
  return best;
}

function tailLines(file, limit) {
  if (!file) return [];
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - MAX_LOG_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, start);
    } finally {
      fs.closeSync(fd);
    }
    const lines = buffer
      .toString('utf8')
      .split(/\r?\n/)
      .filter((line, index, all) => line !== '' || index < all.length - 1);
    return lines.slice(-limit);
  } catch {
    return [];
  }
}

/** 汇总服务状态、访问统计与日志，供渲染层一次性渲染。 */
class StatsService {
  constructor(controller) {
    this.controller = controller;
    this.lastLive = null;
    this.metaCache = readMetaFile();
  }

  async collect(days = 30) {
    ensureLogDir();
    const ping = await requestJson(PING_URL);
    const live = ping ? await requestJson(`${STATS_URL}?days=${days}`) : null;
    const environment = live
      ? (await requestJson(ENVIRONMENT_URL, 4000)) || (await localEnvironment())
      : await localEnvironment();

    if (live) {
      this.lastLive = live;
      this.controller.markRunning(live.pid);
    } else {
      this.controller.markUnreachable();
    }

    const ledger = readLedger(roots.logDir);
    const meta = this.metaCache || {};

    const history = live && Array.isArray(live.history) && live.history.length
      ? live.history.slice(-days)
      : historyFromLedger(ledger, days);

    const todayKey = isoDate(new Date());
    const today = live
      ? Number(live.today_count ?? 0)
      : Number((ledger && ledger.days && ledger.days[todayKey]) || 0);

    const stats = {
      today,
      session: live ? Number(live.session_count ?? 0) : 0,
      total: live ? Number(live.total_count ?? 0) : totalFromLedger(ledger),
      toolCount: Number(live?.tool_count ?? meta.tool_count ?? ledger?.meta?.tool_count ?? 0) || null,
      version: live?.version ?? meta.version ?? ledger?.meta?.version ?? null,
      uptimeSeconds: live ? Number(live.uptime_seconds ?? 0) : 0,
      history,
      source: live ? 'live' : ledger ? 'ledger' : 'none',
      todayKey,
    };

    const logFile = newestLogFile(roots.logDir);
    const logLines = tailLines(logFile, LOG_TAIL_LINES);
    const log = {
      dir: roots.logDir,
      file: logFile,
      fileName: logFile ? path.basename(logFile) : null,
      lines: logLines,
      output: this.controller.output.slice(-LOG_TAIL_LINES),
    };

    return {
      service: this.controller.describe(),
      stats,
      log,
      environment,
      meta: {
        endpoint: ENDPOINT,
        logDir: roots.logDir,
        days,
        polledAt: new Date().toISOString(),
        packaged: roots.packaged,
        appRoot: roots.appRoot,
      },
    };
  }
}

module.exports = { StatsService, requestJson };


