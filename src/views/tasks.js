(function () {
  const activeStatuses = ['queued', 'downloading', 'paused', 'processing'];

  function failed(item, userCancelled) {
    return item.status === 'failed' && !userCancelled(item);
  }

  function stageIndex(item) {
    if (item.status === 'completed') return 4;
    const stage = String(item.stage || item.status || 'queued');
    if (['queued', 'resolving', 'preparing'].includes(stage)) return 0;
    if (['downloading', 'paused'].includes(stage)) return 1;
    if (['merging', 'processing', 'organizing'].includes(stage)) return 2;
    if (['archiving', 'importing'].includes(stage)) return 3;
    return Math.max(0, Math.min(3, Math.floor(Number(item.progressPercent || 0) / 25)));
  }

  function renderStepper(item) {
    const current = stageIndex(item);
    const labels = ['解析来源', '下载媒体', '整理文件', '归档入库'];
    return `<div class="download-stepper" aria-label="四阶段下载进度">${labels.map((label, index) => `<div class="download-step ${index < current || current === 4 ? 'done' : index === current ? 'active' : ''}"><span>${index < current || current === 4 ? '<i class="ui-icon" style="--icon:url(\'./assets/icons/circle-check.svg\')"></i>' : index + 1}</span><em>${label}</em></div>`).join('')}</div>`;
  }

  function render(context) {
    const { state, helpers, historyClearedBefore } = context;
    const { escapeHtml, icon, formatTime, formatTransferRate, formatBytes, outputPresetLabel, derivativeKind, userCancelled, taskErrorMarkup, taskRecoveryButton, pagination } = helpers;
    const all = [
      ...state.jobs.map((item) => ({ type: 'download', item })),
      ...state.derivatives.filter((item) => item.kind !== 'source').map((item) => ({ type: 'processing', item })),
    ];
    const isHistoryVisible = (item) => !historyClearedBefore || Number(item.updatedAt || item.createdAt || 0) > historyClearedBefore;
    const counts = {
      active: all.filter(({ item }) => activeStatuses.includes(item.status) && !failed(item, userCancelled)).length,
      attention: all.filter(({ item }) => failed(item, userCancelled)).length,
      history: all.filter(({ item }) => (item.status === 'completed' || userCancelled(item)) && isHistoryVisible(item)).length,
    };
    const entries = all.filter(({ item }) => {
      if (state.taskFilter === 'active') return activeStatuses.includes(item.status) && !failed(item, userCancelled);
      if (state.taskFilter === 'attention') return failed(item, userCancelled);
      return (item.status === 'completed' || userCancelled(item)) && isHistoryVisible(item);
    });
    const pageCount = Math.max(1, Math.ceil(entries.length / context.pageSize));
    state.taskPage = Math.min(Math.max(1, state.taskPage), pageCount);
    const visible = entries.slice((state.taskPage - 1) * context.pageSize, state.taskPage * context.pageSize);
    const tabs = window.ClipCargoViewTabs.render([
      { id: 'active', label: '进行中', count: counts.active },
      { id: 'attention', label: '需处理', count: counts.attention },
      { id: 'history', label: '已完成历史', count: counts.history },
    ], state.taskFilter, 'task-filter', '任务状态');
    const historyAction = state.taskFilter === 'history' && entries.length
      ? state.pendingHistoryClear
        ? `<div class="history-inline-confirm" data-confirm-persistent="true"><span>只清除历史记录，不删除素材文件。</span><button class="button compact" data-action="cancel-clear-task-history">取消</button><button class="button compact danger" data-action="confirm-clear-task-history">确认清除</button></div>`
        : `<button class="button compact" data-action="prepare-clear-task-history">${icon('trash-2')}清除历史</button>`
      : '';
    const cards = visible.map(({ type, item }) => {
      const isDownload = type === 'download';
      const cancelled = userCancelled(item);
      const isFailed = failed(item, userCancelled);
      const progress = Math.max(0, Math.min(100, Number(item.progressPercent || 0)));
      const status = cancelled ? 'cancelled' : isFailed ? 'failed' : item.status;
      const statusLabel = cancelled ? '已停止' : isFailed ? '需处理' : item.status === 'queued' ? '排队中' : item.status === 'downloading' ? '下载中' : item.status === 'paused' ? '已暂停' : item.status === 'processing' ? '处理中' : '已完成';
      let actions = '';
      if (isDownload) {
        if (item.status === 'downloading') actions = `<button class="button compact" data-pause-download="${item.id}">暂停</button><button class="button compact danger-text" data-cancel-download="${item.id}">停止</button>`;
        else if (item.status === 'paused') actions = `<button class="button compact primary" data-resume-download="${item.id}">继续</button><button class="button compact danger-text" data-cancel-download="${item.id}">停止</button>`;
        else if (item.status === 'queued') actions = `<button class="button compact danger-text" data-cancel-download="${item.id}">取消</button>`;
        else if (isFailed) actions = `${taskRecoveryButton(item) || ''}<button class="button compact primary" data-retry-download="${item.id}">${icon('refresh-cw')}重试</button>`;
        else if (cancelled) actions = `<button class="button compact" data-retry-download="${item.id}">${icon('refresh-cw')}重新开始</button>`;
      } else if (item.status === 'queued' || item.status === 'processing') actions = `<button class="button compact danger-text" data-cancel-processing="${item.id}">取消</button>`;
      else if (isFailed) actions = `${taskRecoveryButton(item, 'processing') || ''}<button class="button compact primary" data-retry-processing="${item.id}">${icon('refresh-cw')}重试</button>`;
      else if (cancelled) actions = `<button class="button compact" data-retry-processing="${item.id}">${icon('refresh-cw')}重新开始</button>`;
      const detail = (isDownload
        ? [outputPresetLabel(item.outputPreset), item.quality ? `${item.quality}` : '自动', item.projectName ? escapeHtml(item.projectName) : '']
        : [derivativeKind(item.kind), item.projectName ? escapeHtml(item.projectName) : '']
      ).filter(Boolean).join(' · ');
      const isActive = activeStatuses.includes(item.status) && !isFailed;
      const metaLine = [detail, isDownload && item.sourceHost ? escapeHtml(item.sourceHost) : '', formatTime(item.updatedAt || item.createdAt)].filter(Boolean).join(' · ');
      const transfer = isDownload && ['downloading', 'paused'].includes(item.status)
        ? `<div class="task-transfer"><span>${formatBytes(item.downloadedBytes || 0)} / ${formatBytes(item.totalBytes || 0)}</span><span>${item.status === 'paused' ? '已保留断点' : `${formatTransferRate(item.speedBytesPerSecond)}${Number.isFinite(item.etaSeconds) ? ` · 约 ${Math.max(1, Math.round(item.etaSeconds))} 秒` : ''}`}</span></div>` : '';
      const error = isFailed ? taskErrorMarkup(item.errorMessage, isDownload ? 'download' : 'processing', item.errorCode, item) : '';
      const trailingActions = `${actions}${item.status === 'completed' ? `<button class="button compact" data-view="library">查看素材</button>` : ''}`;
      const inlineWarn = item.warningMessage
        ? ` <span class="task-warning-inline" title="${escapeHtml(item.warningMessage)}">· ${escapeHtml(item.warningMessage)}</span>`
        : '';
      if (!isActive && !isFailed) {
        return `<article class="task-card is-compact" ${isDownload ? `data-live-job-id="${item.id}"` : `data-live-derivative-id="${item.id}"`}><div class="task-compact-row"><div class="task-compact-copy"><strong>${escapeHtml(item.title)}</strong><small>${metaLine}${inlineWarn}</small></div><div class="task-compact-right"><span class="status status-${status}">${statusLabel}</span>${trailingActions}</div></div></article>`;
      }
      return `<article class="task-card" ${isDownload ? `data-live-job-id="${item.id}"` : `data-live-derivative-id="${item.id}"`}><header><div class="task-compact-copy"><strong>${escapeHtml(item.title)}</strong><small>${metaLine}${inlineWarn}</small></div><div class="task-compact-right"><span class="status status-${status}">${statusLabel}</span>${trailingActions}</div></header>${isDownload && isActive ? renderStepper(item) : ''}${isActive ? `<div class="task-progress"><div class="progress-track"><span data-live-progress-fill style="width:${progress}%"></span></div><strong data-live-progress-label>${Math.round(progress)}%</strong></div>${transfer}` : ''}${error}</article>`;
    }).join('');
    const emptyLabels = { active: ['队列当前空闲', '开始下载或处理后，任务会实时显示在这里。'], attention: ['没有需要处理的问题', '受限登录、缺少组件和失败任务会集中出现在这里。'], history: ['还没有完成历史', '历史记录只保存任务结果，不会影响素材文件。'] };
    const empty = `<div class="phase2-empty"><span class="ui-icon" style="--icon:url('./assets/icons/list-checks.svg')"></span><strong>${emptyLabels[state.taskFilter][0]}</strong><p>${emptyLabels[state.taskFilter][1]}</p></div>`;
    return `<div class="phase2-view tasks-center"><div class="phase2-filter-row">${tabs}<div class="filter-actions">${historyAction}</div></div><section class="task-card-list">${cards || empty}</section>${pagination('tasks', state.taskPage, pageCount, entries.length)}</div>`;
  }

  window.ClipCargoViews = window.ClipCargoViews || {};
  window.ClipCargoViews.tasks = { render };
})();
