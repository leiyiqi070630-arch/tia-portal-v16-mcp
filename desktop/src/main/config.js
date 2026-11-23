'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app } = require('electron');

const ENV_LOG_DIR = 'TIA_MCP_LOG_DIR';
const ENV_PREFERRED_LANGUAGE = 'TIA_MCP_PREFERRED_LANGUAGE';
const ENV_PREFERRED_BLOCK = 'TIA_MCP_PREFERRED_BLOCK';
const ENV_CONNECT_TEMPLATE = 'TIA_MCP_CONNECT_TEMPLATE';
const ENV_KNOWLEDGE_BASE_ROOT = 'TIA_MCP_KNOWLEDGE_BASE_ROOT';

const DEFAULT_SETTINGS = Object.freeze({
  theme: 'dark',
  preferredLanguage: 'LAD',
  preferredBlock: 'MAIN',
  connectTemplate: '',
  knowledgeBaseRoot: '',
});

const PORT = 8001;
const HOST = '127.0.0.1';
const ENDPOINT = `http://${HOST}:${PORT}/mcp`;
const PING_URL = `http://${HOST}:${PORT}/console/ping`;
const STATS_URL = `http://${HOST}:${PORT}/console/stats`;
/** 由 MCP 服务进程自己在资源管理器里打开日志目录。 */
const OPEN_LOG_DIR_URL = `http://${HOST}:${PORT}/console/open-log-dir`;
/** 环境快照：博途是否打开、Openness 用户组、程序集与连接状态。 */
const ENVIRONMENT_URL = `http://${HOST}:${PORT}/console/environment`;
/** 优雅关停：服务先 detach TIA 再退出，避免打断 Openness 会话。 */
const SHUTDOWN_URL = `http://${HOST}:${PORT}/console/shutdown`;

/** 稳定态刷新周期（需求：5 秒）。 */
const REFRESH_INTERVAL_MS = 5000;
/** 启停过渡期的快速刷新周期。 */
const TRANSITION_INTERVAL_MS = 1000;
/** 过渡期最长时长，超时后回落到稳定周期。 */
const TRANSITION_HOLD_MS = 15000;
const LOG_TAIL_LINES = 160;
const OUTPUT_BUFFER_LINES = 400;
const HISTORY_RANGES = [7, 30];

function resolveRoots() {
  const packaged = app.isPackaged;
  const appRoot = packaged
    ? path.dirname(process.execPath)
    : path.resolve(__dirname, '..', '..', '..');

  const service = packaged
    ? {
        command: path.join(appRoot, 'mcp', 'tia-portal-v16-mcp.exe'),
        args: [],
        cwd: path.join(appRoot, 'mcp'),
      }
    : {
        command: path.join(appRoot, '.venv', 'Scripts', 'python.exe'),
        args: ['mcp_run.py'],
        cwd: appRoot,
      };

  const dataRoot = process.env.TIA_V16_DESKTOP_DATA_DIR || appRoot;
  return {
    packaged,
    appRoot,
    service,
    logDir: path.join(dataRoot, 'log'),
    // 便携运行：Chromium 的 profile/缓存放进程序目录，避免写系统 AppData
    // （部分安全软件会拦截 Electron 进程写 AppData，导致 profile 创建失败）。
    userDataDir: path.join(dataRoot, 'console-data'),
    settingsFile: path.join(dataRoot, 'console-data', 'settings.json'),
    metaFile: packaged
      ? path.join(process.resourcesPath, 'app-meta', 'mcp-info.json')
      : path.join(__dirname, '..', '..', 'resources', 'mcp-info.json'),
    iconIco: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
  };
}

const roots = resolveRoots();

function normalizeSettings(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    theme: source.theme === 'light' ? 'light' : 'dark',
    preferredLanguage: source.preferredLanguage === 'SCL' ? 'SCL' : 'LAD',
    preferredBlock: source.preferredBlock === 'FB_FC' ? 'FB_FC' : 'MAIN',
    connectTemplate: typeof source.connectTemplate === 'string' ? source.connectTemplate.trim() : '',
    knowledgeBaseRoot:
      typeof source.knowledgeBaseRoot === 'string' ? source.knowledgeBaseRoot.trim() : '',
  };
}

function readSettings() {
  try {
    const raw = fs.readFileSync(roots.settingsFile, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(value) {
  const settings = normalizeSettings(value);
  ensureUserDataDir();
  const temporary = `${roots.settingsFile}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, roots.settingsFile);
  return settings;
}

/** 服务进程需要继承的环境：日志目录由控制台指定，保证前端与后端指向同一份数据。 */
function serviceEnv(extra = {}) {
  const settings = readSettings();
  return {
    ...process.env,
    [ENV_LOG_DIR]: roots.logDir,
    [ENV_PREFERRED_LANGUAGE]: settings.preferredLanguage,
    [ENV_PREFERRED_BLOCK]: settings.preferredBlock,
    [ENV_CONNECT_TEMPLATE]: settings.connectTemplate,
    [ENV_KNOWLEDGE_BASE_ROOT]: settings.knowledgeBaseRoot,
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    ...extra,
  };
}

function ensureLogDir() {
  fs.mkdirSync(roots.logDir, { recursive: true });
  return roots.logDir;
}

function ensureUserDataDir() {
  fs.mkdirSync(roots.userDataDir, { recursive: true });
  return roots.userDataDir;
}

module.exports = {
  HOST,
  PORT,
  ENDPOINT,
  PING_URL,
  STATS_URL,
  OPEN_LOG_DIR_URL,
  ENVIRONMENT_URL,
  SHUTDOWN_URL,
  REFRESH_INTERVAL_MS,
  TRANSITION_INTERVAL_MS,
  TRANSITION_HOLD_MS,
  LOG_TAIL_LINES,
  OUTPUT_BUFFER_LINES,
  HISTORY_RANGES,
  ENV_LOG_DIR,
  ENV_PREFERRED_LANGUAGE,
  ENV_PREFERRED_BLOCK,
  ENV_CONNECT_TEMPLATE,
  ENV_KNOWLEDGE_BASE_ROOT,
  DEFAULT_SETTINGS,
  roots,
  normalizeSettings,
  readSettings,
  writeSettings,
  serviceEnv,
  ensureLogDir,
  ensureUserDataDir,
};
