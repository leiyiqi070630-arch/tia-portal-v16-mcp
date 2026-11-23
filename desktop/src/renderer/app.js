(function () {
  'use strict';

  const api = window.consoleAPI;
  const $ = (id) => document.getElementById(id);

  const els = {
    app: document.querySelector('.app'),
    serviceCard: document.querySelector('.service-card'),
    startupNotice: $('startup-notice'),
    startupNoticeAck: $('startup-notice-ack'),
    version: $('version-badge'),
    envTia: $('env-tia'),
    envTiaValue: $('env-tia-value'),
    envTiaMeta: $('env-tia-meta'),
    envOpenness: $('env-openness'),
    envOpennessValue: $('env-openness-value'),
    envOpennessMeta: $('env-openness-meta'),
    opennessAlert: $('openness-alert'),
    opennessSteps: $('openness-steps'),
    statToday: $('stat-today'),
    statTodayHint: $('stat-today-hint'),
    statSession: $('stat-session'),
    statSessionHint: $('stat-session-hint'),
    statTools: $('stat-tools'),
    statToolsHint: $('stat-tools-hint'),
    statUptime: $('stat-uptime'),
    statUptimeHint: $('stat-uptime-hint'),
    pill: $('service-pill'),
    pillText: $('service-pill-text'),
    toggle: $('service-toggle'),
    powerTitle: $('power-title'),
    powerHint: $('power-hint'),
    endpoint: $('endpoint-text'),
    pid: $('service-pid'),
    started: $('service-started'),
    logFileText: $('log-file-text'),
    error: $('service-error'),
    copyMcpConfig: $('btn-copy-mcp-config'),
    openLogDir: $('btn-open-logdir'),
    chartSub: $('chart-sub'),
    chartTotal: $('chart-total'),
    chartAverage: $('chart-average'),
    chartPeak: $('chart-peak'),
    logSub: $('log-sub'),
    logView: $('log-view'),
    logLive: $('log-live'),
    refreshLog: $('btn-refresh-log'),
    logDirectory: $('log-directory-text'),
    pageTitle: $('page-title'),
    pageSubtitle: $('page-subtitle'),
    preferLad: $('prefer-lad'),
    preferMain: $('prefer-main'),
    languageSummary: $('language-summary'),
    blockSummary: $('block-summary'),
    templateStatus: $('connect-template-status'),
    templatePath: $('connect-template-path'),
    pickTemplate: $('btn-pick-connect-template'),
    openTemplate: $('btn-open-connect-template'),
    clearTemplate: $('btn-clear-connect-template'),
    templatePreviewWrap: $('connect-template-preview-wrap'),
    templatePreview: $('connect-template-preview'),
    knowledgeBaseStatus: $('knowledge-base-status'),
    knowledgeBasePath: $('knowledge-base-path'),
    pickKnowledgeBase: $('btn-pick-knowledge-base'),
    openKnowledgeBase: $('btn-open-knowledge-base'),
    clearKnowledgeBase: $('btn-clear-knowledge-base'),
    conn: $('conn-dot'),
    statusText: $('status-text'),
    statusPoll: $('status-poll'),
    statusUpdated: $('status-updated'),
    toast: $('toast'),
    minimize: $('btn-minimize'),
    maximize: $('btn-maximize'),
    close: $('btn-close'),
  };

  const chart = new window.TrendChart($('trend-chart'), $('chart-tip'));

  const state = {
    days: 30,
    snapshot: null,
    busy: false,
    opennessWarned: false,
    logSignature: '',
    uptimeBase: 0,
    uptimeAt: 0,
    page: 'home',
    settings: {
      theme: 'dark',
      preferredLanguage: 'LAD',
      preferredBlock: 'MAIN',
      connectTemplate: '',
      knowledgeBaseRoot: '',
    },
    templateInfo: null,
    knowledgeBaseInfo: null,
  };

  const PAGE_META = {
    home: ['主页', '服务运行状态与调用数据'],
    reasoning: ['推理设置', '默认编程语言、块架构、输出模板与知识库'],
    settings: ['设置', '主题颜色与日志管理'],
  };

  const STATE_TEXT = {
    stopped: '已停止',
    starting: '启动中',
    stopping: '停止中',
    running: '运行中',
  };

  const POWER_HINT = {
    stopped: '点击开关启动 MCP 服务',
    starting: '正在启动，等待健康检查…',
    stopping: '正在停止服务…',
    running: '服务运行中，点击开关可停止',
  };

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function fmtInt(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toLocaleString('zh-CN') : '0';
  }

  function fmtClock(iso) {
    if (!iso) return '—';
    const date = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const date = iso instanceof Date ? iso : new Date(iso);
    if (Number.isNaN(date.getTime())) return '—';
    return `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${fmtClock(date)}`;
  }

  function fmtDuration(seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    if (total < 1) return '—';
    if (total < 60) return `${total} 秒`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} 分 ${pad2(total % 60)} 秒`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} 小时 ${pad2(minutes % 60)} 分`;
    const days = Math.floor(hours / 24);
    return `${days} 天 ${hours % 24} 小时`;
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  function bindStartupNotice() {
    if (!els.startupNotice || !els.startupNoticeAck) return;

    const acknowledge = () => {
      if (els.startupNotice.hidden || els.startupNotice.classList.contains('is-leaving')) return;
      els.startupNoticeAck.disabled = true;
      els.startupNotice.classList.add('is-leaving');

      const finish = () => {
        els.startupNotice.hidden = true;
        els.startupNotice.classList.remove('is-leaving');
        els.app?.removeAttribute('inert');
        els.app?.removeAttribute('aria-hidden');
        els.toggle?.focus({ preventScroll: true });
      };

      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
      else window.setTimeout(finish, 170);
    };

    els.startupNoticeAck.addEventListener('click', acknowledge, { once: true });
    window.requestAnimationFrame(() => els.startupNoticeAck.focus({ preventScroll: true }));
  }

  let toastTimer = null;
  function toast(message) {
    if (!message) return;
    els.toast.textContent = message;
    els.toast.hidden = false;
    requestAnimationFrame(() => els.toast.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('is-visible');
      setTimeout(() => {
        els.toast.hidden = true;
      }, 200);
    }, 2200);
  }

  function applyTheme(theme) {
    const normalized = theme === 'light' ? 'light' : 'dark';
    state.settings.theme = normalized;
    document.body.dataset.theme = normalized;
    document.querySelectorAll('.theme-option').forEach((button) => {
      const active = button.dataset.theme === normalized;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    });
    requestAnimationFrame(() => chart.refreshTheme());
  }

  function renderReasoningSettings() {
    const preferLad = state.settings.preferredLanguage !== 'SCL';
    const preferMain = state.settings.preferredBlock !== 'FB_FC';
    els.preferLad.setAttribute('aria-checked', String(preferLad));
    els.preferMain.setAttribute('aria-checked', String(preferMain));
    setText(els.languageSummary, preferLad ? '当前：LAD（梯形图）' : '当前：SCL（结构化控制语言）');
    setText(els.blockSummary, preferMain ? '当前：Main (OB1)' : '当前：FB / FC 功能块');
  }

  function formatBytes(size) {
    if (!Number.isFinite(size)) return '';
    if (size < 1024) return `${size} B`;
    if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
    return `${(size / 1024 / 1024).toFixed(1)} MB`;
  }

  function renderTemplateStatus() {
    const configured = Boolean(state.settings.connectTemplate);
    const info = state.templateInfo;
    setText(els.templatePath, configured ? state.settings.connectTemplate : '—');
    els.templatePath.title = configured ? state.settings.connectTemplate : '';
    els.openTemplate.hidden = !configured;
    els.clearTemplate.hidden = !configured;

    if (!configured) {
      els.templateStatus.textContent = '尚未选择模板文件。选择后，AI 完成连接任务会按该模板输出。';
      els.templateStatus.dataset.tone = 'muted';
      els.templatePreviewWrap.hidden = true;
      els.templatePreviewWrap.open = false;
      return;
    }
    if (!info || info.path !== state.settings.connectTemplate) {
      els.templateStatus.textContent = '正在检查模板文件…';
      els.templateStatus.dataset.tone = 'muted';
      return;
    }
    if (info.exists) {
      const parts = [`已就绪 · ${formatBytes(info.sizeBytes)}`];
      if (info.modifiedAt) parts.push(`修改于 ${new Date(info.modifiedAt).toLocaleString('zh-CN')}`);
      els.templateStatus.textContent = parts.join(' · ');
      els.templateStatus.dataset.tone = 'ok';
      els.templatePreviewWrap.hidden = false;
    } else {
      els.templateStatus.textContent = info.error || '模板文件不存在，请重新选择。';
      els.templateStatus.dataset.tone = 'warn';
      els.templatePreviewWrap.hidden = true;
      els.templatePreviewWrap.open = false;
    }
  }

  async function refreshTemplateInfo() {
    try {
      state.templateInfo = await api.getTemplateInfo();
    } catch {
      state.templateInfo = null;
    }
    renderTemplateStatus();
  }

  async function loadTemplatePreview() {
    if (!state.settings.connectTemplate) return;
    try {
      const result = await api.readTemplate();
      els.templatePreview.textContent = result.ok
        ? result.truncated
          ? `${result.content}\n…（预览已截断，完整内容见文件）`
          : result.content
        : result.message;
    } catch (error) {
      els.templatePreview.textContent = `读取模板失败：${error.message}`;
    }
  }

  let templateSaving = false;

  async function persistTemplate() {
    if (templateSaving) return;
    templateSaving = true;
    els.pickTemplate.disabled = true;
    els.clearTemplate.disabled = true;
    els.openTemplate.disabled = true;
    try {
      const result = await api.saveSettings(state.settings);
      toast(result.ok ? result.message : result.message || '保存输出模板失败');
      // 以磁盘上的设置为准；模板路径变化时主进程会重启服务。
      state.settings = await api.getSettings();
    } catch (error) {
      toast(`保存输出模板失败：${error.message}`);
    } finally {
      templateSaving = false;
      els.pickTemplate.disabled = false;
      els.clearTemplate.disabled = false;
      els.openTemplate.disabled = false;
      await refreshTemplateInfo();
    }
  }

  async function chooseTemplate() {
    let result;
    try {
      result = await api.pickTemplate();
    } catch (error) {
      toast(`选择模板失败：${error.message}`);
      return;
    }
    if (!result || !result.ok) {
      if (result && !result.canceled) toast(result.message || '请选择 .md 模板文件');
      return;
    }
    state.settings.connectTemplate = result.path;
    state.templateInfo = result.info;
    renderTemplateStatus();
    if (els.templatePreviewWrap.open) void loadTemplatePreview();
    await persistTemplate();
  }

  async function clearTemplate() {
    if (!state.settings.connectTemplate) return;
    state.settings.connectTemplate = '';
    state.templateInfo = null;
    els.templatePreviewWrap.hidden = true;
    els.templatePreviewWrap.open = false;
    renderTemplateStatus();
    await persistTemplate();
  }

  async function openTemplateFile() {
    try {
      const result = await api.openTemplate();
      if (!result.ok) toast(result.message || '无法打开模板文件');
    } catch (error) {
      toast(`无法打开模板文件：${error.message}`);
    }
  }

  function renderKnowledgeBaseStatus() {
    const configured = Boolean(state.settings.knowledgeBaseRoot);
    const info = state.knowledgeBaseInfo;
    setText(els.knowledgeBasePath, configured ? state.settings.knowledgeBaseRoot : '—');
    els.knowledgeBasePath.title = configured ? state.settings.knowledgeBaseRoot : '';
    els.openKnowledgeBase.hidden = !configured;
    els.clearKnowledgeBase.hidden = !configured;

    if (!configured) {
      els.knowledgeBaseStatus.textContent = '尚未选择知识库目录。未配置时，AI 按通用规范继续。';
      els.knowledgeBaseStatus.dataset.tone = 'muted';
      return;
    }
    if (!info || info.path !== state.settings.knowledgeBaseRoot) {
      els.knowledgeBaseStatus.textContent = '正在检查知识库目录…';
      els.knowledgeBaseStatus.dataset.tone = 'muted';
      return;
    }
    if (info.exists && info.readable !== false) {
      els.knowledgeBaseStatus.textContent = '目录已就绪 · AI 将通过 MCP 按需读取支持的文本资料';
      els.knowledgeBaseStatus.dataset.tone = 'ok';
    } else {
      els.knowledgeBaseStatus.textContent = info.error || '知识库目录不可用，请重新选择。';
      els.knowledgeBaseStatus.dataset.tone = 'warn';
    }
  }

  async function refreshKnowledgeBaseInfo() {
    try {
      state.knowledgeBaseInfo = await api.getKnowledgeBaseInfo();
    } catch {
      state.knowledgeBaseInfo = null;
    }
    renderKnowledgeBaseStatus();
  }

  let knowledgeBaseSaving = false;

  async function persistKnowledgeBase() {
    if (knowledgeBaseSaving) return;
    knowledgeBaseSaving = true;
    els.pickKnowledgeBase.disabled = true;
    els.openKnowledgeBase.disabled = true;
    els.clearKnowledgeBase.disabled = true;
    try {
      const result = await api.saveSettings(state.settings);
      toast(result.ok ? result.message : result.message || '保存知识库设置失败');
      state.settings = await api.getSettings();
    } catch (error) {
      toast(`保存知识库设置失败：${error.message}`);
    } finally {
      knowledgeBaseSaving = false;
      els.pickKnowledgeBase.disabled = false;
      els.openKnowledgeBase.disabled = false;
      els.clearKnowledgeBase.disabled = false;
      await refreshKnowledgeBaseInfo();
    }
  }

  async function chooseKnowledgeBase() {
    let result;
    try {
      result = await api.pickKnowledgeBase();
    } catch (error) {
      toast(`选择知识库失败：${error.message}`);
      return;
    }
    if (!result || !result.ok) {
      if (result && !result.canceled) toast(result.message || '请选择有效的知识库目录');
      return;
    }
    state.settings.knowledgeBaseRoot = result.path;
    state.knowledgeBaseInfo = result.info;
    renderKnowledgeBaseStatus();
    await persistKnowledgeBase();
  }

  async function clearKnowledgeBase() {
    if (!state.settings.knowledgeBaseRoot) return;
    if (
      !window.confirm(
        '清除知识库后，AI 将不再检索本地资料，并会重启 MCP 服务。确定继续？',
      )
    ) {
      return;
    }
    state.settings.knowledgeBaseRoot = '';
    state.knowledgeBaseInfo = null;
    renderKnowledgeBaseStatus();
    await persistKnowledgeBase();
  }

  async function openKnowledgeBaseDirectory() {
    try {
      const result = await api.openKnowledgeBase();
      if (!result.ok) toast(result.message || '无法打开知识库目录');
    } catch (error) {
      toast(`无法打开知识库目录：${error.message}`);
    }
  }

  function showPage(page) {
    if (!PAGE_META[page]) return;
    state.page = page;
    document.querySelectorAll('[data-page-panel]').forEach((panel) => {
      const active = panel.dataset.pagePanel === page;
      panel.hidden = !active;
      panel.classList.toggle('is-active', active);
    });
    document.querySelectorAll('.nav-item').forEach((button) => {
      const active = button.dataset.page === page;
      button.classList.toggle('is-active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    setText(els.pageTitle, PAGE_META[page][0]);
    setText(els.pageSubtitle, PAGE_META[page][1]);
    if (page === 'home') requestAnimationFrame(() => chart.refreshTheme());
  }

  function renderService(service, log) {
    const mode = service.state || 'stopped';
    const running = mode === 'running' || mode === 'starting';
    const closed = mode === 'stopped' || mode === 'stopping';

    els.serviceCard.dataset.state = mode;
    setText(els.pillText, STATE_TEXT[mode] || mode);
    els.pill.dataset.state = mode;
    const dot = els.pill.querySelector('.dot');
    if (dot) dot.className = 'dot';

    els.toggle.setAttribute('aria-checked', String(running));
    els.toggle.dataset.busy = String(state.busy || mode === 'starting' || mode === 'stopping');
    els.toggle.disabled = state.busy || mode === 'starting' || mode === 'stopping';
    els.toggle.setAttribute('aria-label', running ? '停止 MCP 服务' : '启动 MCP 服务');

    setText(els.powerTitle, state.busy ? '正在处理…' : running ? '停止服务' : '启动服务');
    setText(els.powerHint, state.busy ? '等待服务响应…' : POWER_HINT[mode] || '');

    if (service.pid) {
      setText(els.pid, `${service.pid}${service.external ? ' · 外部进程' : ''}`);
    } else {
      setText(els.pid, closed ? '—' : '启动中');
    }

    setText(els.started, service.startedAt ? fmtDateTime(service.startedAt) : '—');
    setText(els.logFileText, log && log.fileName ? log.fileName : '—');

    if (service.lastError) {
      els.error.hidden = false;
      els.error.dataset.tone = 'error';
      setText(els.error, service.lastError);
    } else if (service.external && mode === 'running') {
      els.error.hidden = false;
      els.error.dataset.tone = 'info';
      setText(els.error, '检测到 MCP 服务由控制台外部启动，当前仅接管监控；关闭开关会终止该进程。');
    } else {
      els.error.hidden = true;
      setText(els.error, '');
    }
  }

  function renderStats(stats, service) {
    setText(els.statToday, fmtInt(stats.today));
    setText(els.statSession, fmtInt(stats.session));
    setText(els.statTools, stats.toolCount ? String(stats.toolCount) : '—');

    state.uptimeBase = Number(stats.uptimeSeconds) || 0;
    state.uptimeAt = Date.now();
    const liveSeconds = uptimeSeconds();
    setText(els.statUptime, liveSeconds === null ? '—' : fmtDuration(liveSeconds));

    const running = service.state === 'running';
    setText(
      els.statTodayHint,
      stats.today
        ? `${stats.todayKey} · 累计 ${fmtInt(stats.today)} 次`
        : `${stats.todayKey} · 今日暂无调用`,
    );
    setText(
      els.statSessionHint,
      running
        ? service.startedAt
          ? `自 ${fmtClock(service.startedAt)} 启动`
          : '本次运行期间累计'
        : '服务未运行时归零',
    );
    setText(
      els.statToolsHint,
      stats.toolCount ? `MCP v${stats.version || '—'} 已注册` : '启动服务后自动读取',
    );
    setText(
      els.statUptimeHint,
      running && service.startedAt ? `启动于 ${fmtClock(service.startedAt)}` : '服务未运行',
    );

    if (stats.version) setText(els.version, `v${stats.version}`);
  }

  function renderChart(stats) {
    const history = Array.isArray(stats.history) ? stats.history : [];
    chart.setData(history);
    const total = history.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    const peak = history.reduce((best, item) => Math.max(best, Number(item.count) || 0), 0);
    const average = history.length ? total / history.length : 0;
    setText(els.chartTotal, fmtInt(total));
    setText(els.chartAverage, average >= 10 ? average.toFixed(0) : average.toFixed(1));
    setText(els.chartPeak, fmtInt(peak));
    setText(els.chartSub, state.days === 7 ? '近 7 天每天调用次数' : '近 30 天每天调用次数');
  }

  function logLineClass(line) {
    if (line.includes('[调用]')) return 'log-line--call';
    if (line.includes('[启动]')) return 'log-line--start';
    if (line.includes('[停止]')) return 'log-line--stop';
    if (/\[(ERROR|WARNING|CRITICAL)\]|\[stderr\]|Traceback/.test(line)) return 'log-line--error';
    return '';
  }

  function renderLog(log, service) {
    const lines = log.lines && log.lines.length ? log.lines : log.output || [];
    const signature = `${log.fileName || ''}|${lines.join('\n')}`;
    if (signature === state.logSignature) {
      updateLogMeta(log, service);
      return;
    }
    const nearBottom =
      els.logView.scrollHeight - els.logView.scrollTop - els.logView.clientHeight < 48;

    const fragment = document.createDocumentFragment();
    if (!lines.length) {
      const empty = document.createElement('span');
      empty.className = 'log-empty';
      empty.textContent = '暂无日志，启动服务后这里会实时显示运行记录。';
      fragment.appendChild(empty);
    } else {
      for (const line of lines) {
        const span = document.createElement('span');
        span.className = `log-line ${logLineClass(line)}`.trim();
        span.textContent = line;
        fragment.appendChild(span);
      }
    }
    els.logView.replaceChildren(fragment);
    state.logSignature = signature;
    if (nearBottom) els.logView.scrollTop = els.logView.scrollHeight;
    updateLogMeta(log, service);
  }

  function updateLogMeta(log, service) {
    const running = service.state === 'running';
    setText(
      els.logSub,
      log.fileName
        ? `${log.fileName} · 最近 ${(log.lines || []).length} 行`
        : '尚未生成日志文件 · 目录 log/',
    );
    els.logLive.hidden = !running;
    setText(els.logDirectory, log.dir || 'log/');
    els.logDirectory.title = log.dir || '';
  }

  function renderFooter(snapshot) {
    const { service, meta } = snapshot;
    const mode = service.state;
    let connState = 'offline';
    if (mode === 'running') connState = 'online';
    else if (mode === 'starting' || mode === 'stopping' || state.busy) connState = 'busy';
    els.conn.dataset.state = connState;

    let statusText;
    if (mode === 'running') statusText = `服务运行中 · ${meta.endpoint}`;
    else if (mode === 'starting') statusText = '服务启动中，等待健康检查…';
    else if (mode === 'stopping') statusText = '服务停止中…';
    else statusText = '服务已停止';
    setText(els.statusText, statusText);

    setText(els.statusUpdated, `更新于 ${fmtClock(meta.polledAt)}`);
    setText(els.statusPoll, '每 5 秒自动刷新');
  }

  function renderEnvironment(environment) {
    if (!environment) return;
    const tia = environment.tia || {};
    const openness = environment.openness || {};
    const processes = Array.isArray(tia.processes) ? tia.processes : [];
    const portalProcesses = processes.filter((item) => item.role !== 'launcher');
    const recommendedPid =
      tia.recommended_process_id ||
      portalProcesses.find((item) => item.recommended)?.pid ||
      portalProcesses[0]?.pid;

    els.envTia.dataset.state = tia.running ? 'running' : 'stopped';
    setText(els.envTiaValue, tia.running ? '运行中' : '未打开');
    setText(
      els.envTiaMeta,
      tia.running
        ? `${portalProcesses.length || processes.length} 个 Portal 进程${recommendedPid ? ` · 推荐 pid ${recommendedPid}` : ''}`
        : '启动博途后自动探测',
    );

    els.envOpenness.dataset.state =
      openness.status === 'member' ? 'member' : openness.status === 'missing' ? 'missing' : 'unknown';
    setText(
      els.envOpennessValue,
      openness.status === 'member' ? '已加入' : openness.status === 'missing' ? '未加入' : '无法确认',
    );
    setText(
      els.envOpennessMeta,
      openness.status === 'member'
        ? (openness.current_user ? `用户 ${openness.current_user}` : '当前用户')
        : openness.status === 'missing'
          ? `需要加入「${openness.required_group || 'Siemens TIA Openness'}」`
          : openness.required_group || '',
    );

    const steps = Array.isArray(openness.action_steps) ? openness.action_steps : [];
    if (openness.status === 'missing') {
      els.opennessAlert.hidden = false;
      if (els.opennessSteps) {
        const signature = steps.join('|');
        if (els.opennessSteps.dataset.signature !== signature) {
          els.opennessSteps.dataset.signature = signature;
          els.opennessSteps.replaceChildren(
            ...steps.map((step) => {
              const item = document.createElement('li');
              item.textContent = step;
              return item;
            }),
          );
        }
      }
      if (!state.opennessWarned) {
        state.opennessWarned = true;
        toast('当前用户不在「Siemens TIA Openness」组，MCP 无法连接 TIA。');
      }
    } else {
      els.opennessAlert.hidden = true;
    }
  }

  function render(snapshot) {
    if (!snapshot) return;
    state.snapshot = snapshot;
    renderEnvironment(snapshot.environment);
    renderService(snapshot.service, snapshot.log);
    renderStats(snapshot.stats, snapshot.service);
    renderChart(snapshot.stats);
    renderLog(snapshot.log, snapshot.service);
    renderFooter(snapshot);
  }

  async function refresh() {
    try {
      const snapshot = await api.getState();
      render(snapshot);
    } catch (error) {
      toast(`读取状态失败：${error.message}`);
    }
  }

  async function toggleService() {
    if (state.busy) return;
    const mode = state.snapshot?.service?.state || 'stopped';
    const running = mode === 'running' || mode === 'starting';
    state.busy = true;
    renderService(state.snapshot?.service || { state: mode }, state.snapshot?.log);
    try {
      const result = running ? await api.stopService() : await api.startService();
      if (result && !result.ok) toast(result.message || '操作失败');
      else if (result && result.message) toast(result.message);
      await refresh();
    } catch (error) {
      toast(`操作失败：${error.message}`);
    } finally {
      state.busy = false;
      await refresh();
    }
  }

  function bindSegmented() {
    const buttons = document.querySelectorAll('.segmented__btn');
    buttons.forEach((button) => {
      button.addEventListener('click', async () => {
        const days = Number(button.dataset.days);
        if (!days || days === state.days) return;
        state.days = days;
        buttons.forEach((other) => {
          const active = other === button;
          other.classList.toggle('is-active', active);
          other.setAttribute('aria-selected', String(active));
        });
        try {
          const snapshot = await api.setDays(days);
          render(snapshot);
        } catch (error) {
          toast(`切换区间失败：${error.message}`);
        }
      });
    });
  }

  function bindWindowControls() {
    els.minimize.addEventListener('click', () => api.minimize());
    els.maximize.addEventListener('click', () => api.toggleMaximize());
    els.close.addEventListener('click', () => api.close());

    const dragArea = document.querySelector('.titlebar__drag');
    dragArea.addEventListener('dblclick', () => api.toggleMaximize());

    const maxIcon = els.maximize.querySelector('svg');
    api.onWindowState(({ maximized }) => {
      els.maximize.setAttribute('aria-label', maximized ? '还原' : '最大化');
      els.maximize.title = maximized ? '还原' : '最大化';
      if (maxIcon) {
        maxIcon.innerHTML = maximized
          ? '<rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1"/><path d="M2.5 2.5V0.5h7v7h-2" fill="none" stroke="currentColor" stroke-width="1"/>'
          : '<rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1"/>';
      }
    });
  }

  function bindLogActions() {
    els.openLogDir.addEventListener('click', async () => {
      try {
        const result = await api.openLogDir();
        toast(result.ok ? '已打开日志目录' : result.message || '无法打开日志目录');
      } catch (error) {
        toast(`无法打开日志目录：${error.message}`);
      }
    });
    els.refreshLog.addEventListener('click', refresh);
  }

  function bindNavigation() {
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.addEventListener('click', () => showPage(button.dataset.page));
    });
  }

  let reasoningSaving = false;

  // 开关即保存：推理偏好写入 settings.json；MCP 服务在运行时由主进程重启以载入新环境变量。
  async function saveReasoningPreferences() {
    if (reasoningSaving) return;
    reasoningSaving = true;
    els.preferLad.disabled = true;
    els.preferMain.disabled = true;
    try {
      const result = await api.saveSettings(state.settings);
      toast(result.ok ? result.message : result.message || '保存失败');
      // 以磁盘上的设置为准，避免保存失败后界面和实际偏好不一致。
      state.settings = await api.getSettings();
      renderReasoningSettings();
    } catch (error) {
      toast(`保存设置失败：${error.message}`);
    } finally {
      reasoningSaving = false;
      els.preferLad.disabled = false;
      els.preferMain.disabled = false;
    }
  }

  function bindSettings() {
    els.preferLad.addEventListener('click', () => {
      state.settings.preferredLanguage =
        els.preferLad.getAttribute('aria-checked') === 'true' ? 'SCL' : 'LAD';
      renderReasoningSettings();
      void saveReasoningPreferences();
    });

    els.preferMain.addEventListener('click', () => {
      state.settings.preferredBlock =
        els.preferMain.getAttribute('aria-checked') === 'true' ? 'FB_FC' : 'MAIN';
      renderReasoningSettings();
      void saveReasoningPreferences();
    });

    els.pickTemplate.addEventListener('click', () => void chooseTemplate());
    els.openTemplate.addEventListener('click', () => void openTemplateFile());
    els.clearTemplate.addEventListener('click', () => void clearTemplate());
    els.templatePreviewWrap.addEventListener('toggle', () => {
      if (els.templatePreviewWrap.open) void loadTemplatePreview();
    });

    els.pickKnowledgeBase.addEventListener('click', () => void chooseKnowledgeBase());
    els.openKnowledgeBase.addEventListener('click', () => void openKnowledgeBaseDirectory());
    els.clearKnowledgeBase.addEventListener('click', () => void clearKnowledgeBase());

    document.querySelectorAll('.theme-option').forEach((button) => {
      button.addEventListener('click', async () => {
        applyTheme(button.dataset.theme);
        try {
          const result = await api.saveSettings(state.settings);
          if (!result.ok) toast(result.message || '主题保存失败');
        } catch (error) {
          toast(`主题保存失败：${error.message}`);
        }
      });
    });
  }

  function bindEndpointCopy() {
    els.endpoint.addEventListener('click', async () => {
      await api.copyEndpoint();
      toast('已复制端点地址');
    });
    els.endpoint.title = '点击复制';
    els.endpoint.style.cursor = 'pointer';

    els.copyMcpConfig.addEventListener('click', async () => {
      try {
        const result = await api.copyMcpConfig();
        if (result && result.ok) toast('MCP JSON 配置已复制，可直接粘贴到 Agent 工具');
        else toast('复制 MCP 配置失败');
      } catch (error) {
        toast(`复制 MCP 配置失败：${error.message}`);
      }
    });
  }

  // 服务时长不再用 setInterval 每秒重算：定时器会被主线程的长任务推迟，
  // 表现为「读秒卡一下再跳」。改成 requestAnimationFrame 驱动的无阻塞循环，
  // 时间基准用服务端 startedAt（绝对时间）而不是快照里的相对秒数，
  // 这样即使某次轮询延迟也不会累积误差；页面不可见时直接跳过渲染。
  function uptimeSeconds() {
    const service = state.snapshot && state.snapshot.service;
    if (!service || service.state !== 'running') return null;
    if (service.startedAt) {
      const startedMs = new Date(service.startedAt).getTime();
      if (Number.isFinite(startedMs)) {
        return Math.max(0, (Date.now() - startedMs) / 1000);
      }
    }
    if (state.uptimeAt) {
      return state.uptimeBase + (Date.now() - state.uptimeAt) / 1000;
    }
    return state.uptimeBase || null;
  }

  function startUptimeTicker() {
    let lastText = els.statUptime.textContent;
    const frame = () => {
      window.requestAnimationFrame(frame);
      if (document.hidden) return;
      const seconds = uptimeSeconds();
      const text = seconds === null ? '—' : fmtDuration(seconds);
      if (text !== lastText) {
        lastText = text;
        els.statUptime.textContent = text;
      }
    };
    window.requestAnimationFrame(frame);
  }

  async function boot() {
    // 声明框不保存“已读”标记；每次创建新的渲染进程都会重新显示。
    bindStartupNotice();
    try {
      state.settings = await api.getSettings();
    } catch (error) {
      toast(`读取设置失败：${error.message}`);
    }
    applyTheme(state.settings.theme);
    renderReasoningSettings();
    renderTemplateStatus();
    void refreshTemplateInfo();
    renderKnowledgeBaseStatus();
    void refreshKnowledgeBaseInfo();
    bindNavigation();
    bindSegmented();
    bindWindowControls();
    bindLogActions();
    bindSettings();
    bindEndpointCopy();
    els.toggle.addEventListener('click', toggleService);
    startUptimeTicker();

    api.onSnapshot((snapshot) => render(snapshot));
    api.onServiceState(() => refresh());

    await refresh();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => void boot());
  } else {
    void boot();
  }
})();
