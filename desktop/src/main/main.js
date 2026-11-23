'use strict';

const { app, BrowserWindow, clipboard, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const C = require('./config');
const { ServiceController } = require('./service');
const { StatsService, requestJson } = require('./stats');

const MCP_AGENT_CONFIG = JSON.stringify(
  {
    mcpServers: {
      'tia-portal-v16': {
        type: 'http',
        url: C.ENDPOINT,
      },
    },
  },
  null,
  2,
);

const TEMPLATE_EXTENSIONS = new Set(['.md', '.markdown']);
const TEMPLATE_PREVIEW_CHARS = 8000;

/** 读取模板文本：优先 UTF-8，失败时按 GB18030 解码（旧工程导出的说明文件常见）。 */
function readTextFile(file) {
  const buffer = fs.readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    try {
      return new TextDecoder('gb18030').decode(buffer);
    } catch {
      return buffer.toString('utf8');
    }
  }
}

function templateInfo(filePath) {
  const value = String(filePath || '').trim();
  const info = {
    configured: Boolean(value),
    path: value,
    fileName: '',
    exists: false,
    sizeBytes: null,
    modifiedAt: null,
    error: '',
  };
  if (!value) return info;
  info.fileName = path.basename(value);
  try {
    const stat = fs.statSync(value);
    if (!stat.isFile()) {
      info.error = '所选路径不是文件，请重新选择。';
      return info;
    }
    info.exists = true;
    info.sizeBytes = stat.size;
    info.modifiedAt = stat.mtime.toISOString();
  } catch {
    info.error = '模板文件不存在或无法读取，请重新选择。';
  }
  return info;
}

function knowledgeBaseInfo(directoryPath) {
  const value = String(directoryPath || '').trim();
  const info = {
    configured: Boolean(value),
    path: value,
    exists: false,
    readable: false,
    modifiedAt: null,
    error: '',
  };
  if (!value) return info;
  try {
    const stat = fs.statSync(value);
    if (!stat.isDirectory()) {
      info.error = '所选路径不是目录，请重新选择。';
      return info;
    }
    info.exists = true;
    info.modifiedAt = stat.mtime.toISOString();
    const handle = fs.opendirSync(value);
    handle.closeSync();
    info.readable = true;
  } catch {
    info.error = info.exists
      ? '知识库目录存在但无法读取，请重新选择或检查权限。'
      : '知识库目录不存在或无法访问，请重新选择。';
  }
  return info;
}

function isMarkdownFile(file) {
  return TEMPLATE_EXTENSIONS.has(path.extname(file).toLowerCase());
}

// 便携化：profile/缓存/日志全部留在程序目录内，不写系统 AppData。
try {
  const userDataDir = C.ensureUserDataDir();
  app.setPath('userData', userDataDir);
  app.setPath('sessionData', userDataDir);
  app.setAppLogsPath(require('node:path').join(userDataDir, 'logs'));
} catch (error) {
  console.error('prepare user data failed:', error);
}

const controller = new ServiceController();
const stats = new StatsService(controller);

let mainWindow = null;
let pollTimer = null;
let currentDays = 30;
let transitionUntil = 0;
let latestSnapshot = null;
let firstPollDone = false;

const SCREENSHOT_PATH = process.env.MCP_CONSOLE_SCREENSHOT || '';
const SCREENSHOT_DELAY = Number(process.env.MCP_CONSOLE_SCREENSHOT_DELAY || 4000);
const SCREENSHOT_PAGE = process.env.MCP_CONSOLE_SCREENSHOT_PAGE || 'home';
const SMOKE_ENABLED = process.env.MCP_CONSOLE_SMOKE === '1';
const SHOT_DIR =
  process.env.MCP_CONSOLE_SHOT_DIR || path.join(path.resolve(__dirname, '..', '..'), 'build', 'shots');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function saveShot(file) {
  const image = await mainWindow.webContents.capturePage();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, image.toPNG());
  console.log(`screenshot saved: ${file}`);
}

/** 自动化冒烟：点开关启动 → 切 7 天 → 停止，逐步截图，用于回归验证。 */
async function runSmoke() {
  try {
    await sleep(1600);
    await mainWindow.webContents.executeJavaScript(
      "document.getElementById('startup-notice-ack')?.click()",
    );
    await sleep(250);
    await mainWindow.webContents.executeJavaScript(
      "document.getElementById('service-toggle').click()",
    );
    await sleep(9000);
    await mainWindow.webContents.executeJavaScript(
      "document.querySelector('.segmented__btn[data-days=\"7\"]').click()",
    );
    await sleep(2600);
    await saveShot(path.join(SHOT_DIR, 'smoke-running.png'));
    await mainWindow.webContents.executeJavaScript(
      "document.getElementById('service-toggle').click()",
    );
    await sleep(6000);
    await saveShot(path.join(SHOT_DIR, 'smoke-stopped.png'));
  } catch (error) {
    console.error('smoke failed:', error);
  } finally {
    controller.killSync();
    console.log('smoke done, exiting');
    app.exit(0);
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 980,
    minHeight: 650,
    show: false,
    frame: false,
    backgroundColor: '#0a0e16',
    title: 'TIA MCP V16 控制台',
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (SMOKE_ENABLED) runSmoke();
    else if (SCREENSHOT_PATH) captureScreenshot();
  });

  for (const event of ['maximize', 'unmaximize', 'restore']) {
    mainWindow.on(event, () => {
      send('window:state', { maximized: mainWindow.isMaximized() });
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

async function captureScreenshot() {
  try {
    await new Promise((resolve) => setTimeout(resolve, Math.max(600, SCREENSHOT_DELAY)));
    // “notice” 专门用于声明框视觉回归；其他页面截图先模拟用户确认。
    if (SCREENSHOT_PAGE !== 'notice') {
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('startup-notice-ack')?.click()",
      );
      await sleep(220);
    }
    if (['reasoning', 'knowledge', 'settings'].includes(SCREENSHOT_PAGE)) {
      const targetPage = SCREENSHOT_PAGE === 'knowledge' ? 'reasoning' : SCREENSHOT_PAGE;
      await mainWindow.webContents.executeJavaScript(
        `document.querySelector('.nav-item[data-page="${targetPage}"]').click()`,
      );
      await sleep(350);
    }
    if (SCREENSHOT_PAGE === 'knowledge') {
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('knowledge-base-title')?.scrollIntoView({ block: 'start' })",
      );
      await sleep(250);
    }
    if (SCREENSHOT_PAGE === 'profile') {
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('creator-avatar')?.focus()",
      );
      await sleep(300);
    }
    if (SCREENSHOT_PAGE === 'config') {
      await mainWindow.webContents.executeJavaScript(
        "document.getElementById('btn-copy-mcp-config')?.click()",
      );
      await sleep(250);
      const copiedConfig = (await clipboard.readText()).replace(/\r\n?/g, '\n');
      if (copiedConfig !== MCP_AGENT_CONFIG) {
        throw new Error('copied MCP config does not match expected JSON');
      }
    }
    await saveShot(SCREENSHOT_PATH);
  } catch (error) {
    console.error('screenshot failed:', error);
  } finally {
    controller.killSync();
    console.log('screenshot done, exiting');
    app.exit(0);
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const interval = Date.now() < transitionUntil ? C.TRANSITION_INTERVAL_MS : C.REFRESH_INTERVAL_MS;
  pollTimer = setTimeout(poll, interval);
}

async function poll() {
  try {
    latestSnapshot = await stats.collect(currentDays);
    firstPollDone = true;
    send('console:snapshot', latestSnapshot);
  } catch (error) {
    console.error('poll failed:', error);
  } finally {
    schedulePoll();
  }
}

function boostPolling(durationMs = C.TRANSITION_HOLD_MS) {
  transitionUntil = Date.now() + durationMs;
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, 250);
}

function registerIpc() {
  ipcMain.handle('console:get-state', async () => {
    if (latestSnapshot) return latestSnapshot;
    latestSnapshot = await stats.collect(currentDays);
    return latestSnapshot;
  });

  ipcMain.handle('console:set-days', async (_event, days) => {
    const parsed = Number(days);
    currentDays = C.HISTORY_RANGES.includes(parsed) ? parsed : 30;
    latestSnapshot = await stats.collect(currentDays);
    send('console:snapshot', latestSnapshot);
    return latestSnapshot;
  });


  ipcMain.handle('console:start', async () => {
    const result = await controller.start();
    boostPolling();
    if (!result.ok) {
      latestSnapshot = await stats.collect(currentDays);
      send('console:snapshot', latestSnapshot);
    }
    return result;
  });

  ipcMain.handle('console:stop', async () => {
    const result = await controller.stop();
    boostPolling();
    latestSnapshot = await stats.collect(currentDays);
    send('console:snapshot', latestSnapshot);
    return result;
  });

  // 打开文件夹/文件：Explorer 必须允许显示窗口。旧实现使用 windowsHide:true，
  // 在部分 Windows / 安全软件组合下会创建一个不可见的资源管理器窗口，看起来像“没有反应”。
  function spawnExplorer(args) {
    return new Promise((resolve) => {
      let settled = false;
      const child = spawn('explorer.exe', args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, message: error.message });
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolve({ ok: true, message: '' });
      });
    });
  }

  async function openFolder(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (error) {
      return { ok: false, message: `日志目录不可用：${error.message}` };
    }
    // 1) 优先让 MCP 服务进程（python）打开：本机安全软件会拦截 Electron 进程的
    //    ShellExecute，表现为弹「Windows 无法访问指定设备、路径或文件」。
    let serviceError = '';
    if (controller.running) {
      const viaService = await requestJson(C.OPEN_LOG_DIR_URL, 5000);
      if (viaService && viaService.ok) {
        return { ok: true, message: '', method: viaService.method || 'service' };
      }
      serviceError = (viaService && viaService.error) || '';
    }
    // 2) 服务没在跑或调用失败：退回控制台自己拉起 explorer，最后才是 shell.openPath。
    const spawned = await spawnExplorer(['/n,/e,', dir]);
    if (spawned.ok) return { ok: true, message: '', method: 'explorer' };
    const shellError = await shell.openPath(dir);
    if (!shellError) return { ok: true, message: '', method: 'shell' };
    return {
      ok: false,
      message: serviceError || spawned.message || shellError,
    };
  }

  async function openExistingFolder(dir) {
    const info = knowledgeBaseInfo(dir);
    if (!info.exists) {
      return { ok: false, message: info.error || '知识库目录不存在，请重新选择。' };
    }
    const spawned = await spawnExplorer(['/n,/e,', info.path]);
    if (spawned.ok) return { ok: true, message: '', method: 'explorer' };
    const shellError = await shell.openPath(info.path);
    return shellError
      ? { ok: false, message: spawned.message || shellError }
      : { ok: true, message: '', method: 'shell' };
  }

  ipcMain.handle('console:open-log-dir', async () => openFolder(C.ensureLogDir()));

  ipcMain.handle('console:get-settings', () => C.readSettings());

  ipcMain.handle('console:get-template-info', () => templateInfo(C.readSettings().connectTemplate));

  ipcMain.handle('console:pick-template', async () => {
    const current = C.readSettings().connectTemplate;
    let defaultPath = app.getPath('desktop');
    if (current) {
      const directory = path.dirname(current);
      if (fs.existsSync(directory)) defaultPath = directory;
    }
    const options = {
      title: '选择连接博途输出模板',
      defaultPath,
      properties: ['openFile'],
      filters: [
        { name: 'Markdown 模板', extensions: ['md', 'markdown'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const file = result.filePaths[0];
    if (!isMarkdownFile(file)) {
      return { ok: false, message: '请选择 .md 或 .markdown 模板文件。' };
    }
    return { ok: true, path: file, info: templateInfo(file) };
  });

  ipcMain.handle('console:open-template', async () => {
    const file = C.readSettings().connectTemplate;
    if (!file) return { ok: false, message: '尚未选择模板文件。' };
    if (!fs.existsSync(file)) return { ok: false, message: '模板文件不存在，请重新选择。' };
    const error = await shell.openPath(file);
    return error ? { ok: false, message: error } : { ok: true };
  });

  ipcMain.handle('console:read-template', () => {
    const file = C.readSettings().connectTemplate;
    if (!file) return { ok: false, message: '尚未选择模板文件。' };
    try {
      const content = readTextFile(file);
      return {
        ok: true,
        content: content.slice(0, TEMPLATE_PREVIEW_CHARS),
        truncated: content.length > TEMPLATE_PREVIEW_CHARS,
      };
    } catch (error) {
      return { ok: false, message: `读取模板失败：${error.message}` };
    }
  });

  ipcMain.handle('console:get-knowledge-base-info', () =>
    knowledgeBaseInfo(C.readSettings().knowledgeBaseRoot),
  );

  ipcMain.handle('console:pick-knowledge-base', async () => {
    const current = C.readSettings().knowledgeBaseRoot;
    const defaultPath = knowledgeBaseInfo(current).exists ? current : app.getPath('documents');
    const options = {
      title: '选择知识库根目录',
      defaultPath,
      properties: ['openDirectory'],
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths.length) {
      return { ok: false, canceled: true };
    }
    const directory = result.filePaths[0];
    const info = knowledgeBaseInfo(directory);
    return info.exists && info.readable
      ? { ok: true, path: directory, info }
      : { ok: false, message: info.error || '请选择有效的知识库目录。' };
  });

  ipcMain.handle('console:open-knowledge-base', async () =>
    openExistingFolder(C.readSettings().knowledgeBaseRoot),
  );

  ipcMain.handle('console:save-settings', async (_event, value) => {
    const before = C.readSettings();
    try {
      const settings = C.normalizeSettings(value);
      const reasoningChanged =
        before.preferredLanguage !== settings.preferredLanguage ||
        before.preferredBlock !== settings.preferredBlock;
      const templateChanged = before.connectTemplate !== settings.connectTemplate;
      const knowledgeChanged = before.knowledgeBaseRoot !== settings.knowledgeBaseRoot;
      if (!reasoningChanged && !templateChanged && !knowledgeChanged) {
        const saved = C.writeSettings(settings);
        return { ok: true, settings: saved, restarted: false, message: '设置已保存。' };
      }
      const labels = [];
      if (reasoningChanged) labels.push('推理偏好');
      if (templateChanged) labels.push('输出模板');
      if (knowledgeChanged) labels.push('知识库');
      const changedText = labels.join('、');
      // 偏好、模板与知识库路径都通过环境变量传给 MCP 服务，必须重启服务才会生效。
      if (!controller.running) {
        const saved = C.writeSettings(settings);
        return {
          ok: true,
          settings: saved,
          restarted: false,
          message: `${changedText}已保存，下次启动 MCP 服务时生效。`,
        };
      }
      const confirmation = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['保存并重启', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '重启 MCP 服务',
        message: `${changedText}已修改，保存会重启 MCP 服务。`,
        detail: '正在执行的 Agent 任务或 TIA 会话可能中断；建议确认当前没有写入、编译或下载操作后再继续。',
      });
      if (confirmation.response !== 0) {
        return {
          ok: true,
          canceled: true,
          settings: before,
          restarted: false,
          message: '已取消保存，设置未改变。',
        };
      }
      const saved = C.writeSettings(settings);
      await controller.stop().catch(() => {});
      const started = await controller.start();
      if (!started || started.ok === false) {
        return {
          ok: false,
          settings: saved,
          restarted: false,
          message: `${changedText}已保存，但 MCP 服务启动失败：${
            (started && started.message) || '未知错误'
          }`,
        };
      }
      boostPolling();
      try {
        latestSnapshot = await stats.collect(currentDays);
        send('console:snapshot', latestSnapshot);
      } catch {
        // 服务重启已成功，状态刷新失败由下一轮轮询恢复，不回滚设置。
      }
      return {
        ok: true,
        settings: saved,
        restarted: true,
        message: `${changedText}已保存，MCP 服务已重启并应用新设置。`,
      };
    } catch (error) {
      return { ok: false, message: `保存设置失败：${error.message}` };
    }
  });

  ipcMain.handle('console:copy-endpoint', async () => {
    await clipboard.writeText(C.ENDPOINT);
    return { ok: true };
  });

  ipcMain.handle('console:copy-mcp-config', async () => {
    await clipboard.writeText(MCP_AGENT_CONFIG);
    return { ok: true };
  });

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('window:close', () => mainWindow?.close());
}

async function bootstrap() {
  app.setAppUserModelId(require('../../package.json').build.appId);
  registerIpc();

  controller.on('state', (state) => {
    boostPolling(4000);
    send('console:service-state', state);
  });

  createWindow();
  await poll();

  if (process.env.MCP_CONSOLE_AUTOSTART === '1') {
    await controller.start();
    boostPolling();
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(bootstrap);

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    clearTimeout(pollTimer);
    controller.killSync();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}

// 便于打包后由控制台外部触发健康检查时复用（无实际导出需求）
module.exports = { stats, controller, firstPollDone: () => firstPollDone };

