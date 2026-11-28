(function () {
  function render(context) {
    const { state, preferences, selected, helpers } = context;
    const { escapeHtml, icon, formatTime, formatDuration, formatBytes, statusFor, canRemove, pagination, safeThumbnail } = helpers;
    const workspace = window.ClipCargoWorkspace;
    const jobsByItem = new Map(state.jobs.map((job) => [job.itemId, job]));
    const pending = ['captured', 'waiting_component', 'resolving'];
    const matchesFilter = (item) => state.filter === 'all'
      || (state.filter === 'captured' && pending.includes(item.status))
      || (state.filter === 'failed' && item.status === 'failed')
      || item.status === state.filter;
    const filtered = state.items.filter((item) => matchesFilter(item) && (state.projectFilter === 'all' || item.projectName === state.projectFilter));
    const counts = {
      all: state.items.length,
      captured: state.items.filter((item) => pending.includes(item.status)).length,
      ready: state.items.filter((item) => item.status === 'ready').length,
      failed: state.items.filter((item) => item.status === 'failed').length,
    };
    const pageCount = Math.max(1, Math.ceil(filtered.length / context.pageSize));
    state.inboxPage = Math.min(Math.max(1, state.inboxPage), pageCount);
    const visible = filtered.slice((state.inboxPage - 1) * context.pageSize, state.inboxPage * context.pageSize);
    for (const id of [...selected]) if (!state.items.some((item) => item.id === id)) selected.delete(id);
    const selectedItems = state.items.filter((item) => selected.has(item.id));
    const selectedDownloadable = selectedItems.filter((item) => item.status === 'ready' && !['queued', 'downloading', 'completed'].includes(jobsByItem.get(item.id)?.status));
    const selectedResolvable = selectedItems.filter((item) => !['waiting_component', 'resolving', 'ready'].includes(item.status));
    const selectedRemovable = selectedItems.filter((item) => canRemove(item, jobsByItem.get(item.id)));
    if (!workspace.ui.inbox.activeId || !state.items.some((item) => item.id === workspace.ui.inbox.activeId)) {
      workspace.ui.inbox.activeId = visible[0]?.id || filtered[0]?.id || null;
    }
    const active = state.items.find((item) => item.id === workspace.ui.inbox.activeId) || null;
    const activeJob = active ? jobsByItem.get(active.id) : null;
    const draft = workspace.ensureInboxDraft(active, preferences);

    const tabs = window.ClipCargoViewTabs.render([
      { id: 'all', label: '全部', count: counts.all },
      { id: 'captured', label: '待处理', count: counts.captured },
      { id: 'ready', label: '已就绪', count: counts.ready },
      { id: 'failed', label: '需处理', count: counts.failed },
    ], state.filter, 'filter', '收集状态');
    const selectionActions = `<select id="batch-project-inline" class="field-control compact-select" aria-label="移动到项目"><option value="">移至项目…</option>${state.projects.map((project) => `<option value="${escapeHtml(project.name)}">${escapeHtml(project.name)}</option>`).join('')}</select><button class="button compact" data-action="resolve-selected" ${selectedResolvable.length ? '' : 'disabled'}>${icon('refresh-cw')}重识别${selectedResolvable.length ? ` ${selectedResolvable.length}` : ''}</button><button class="button compact danger-text" data-action="remove-selected" ${selectedRemovable.length ? '' : 'disabled'}>${icon('trash-2')}${state.pendingBatchRemoval ? '确认' : '移除'}</button><button class="button compact primary" data-action="download-selected" ${selectedDownloadable.length ? '' : 'disabled'}>${icon('download')}下载${selectedDownloadable.length ? ` ${selectedDownloadable.length}` : ''}</button>`;
    const selectionBar = window.ClipCargoSelectionBar.render({ count: selected.size, allChecked: Boolean(filtered.length && filtered.every((item) => selected.has(item.id))), actions: selectionActions });

    const cards = visible.length ? visible.map((item) => {
      const job = jobsByItem.get(item.id);
      const display = statusFor(item, job);
      const isActive = active?.id === item.id;
      const thumb = item.thumbnailUrl ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="">` : `<span class="ui-icon" style="--icon:url('./assets/icons/${item.hasAudio && item.hasVideo === false ? 'music-2' : 'film'}.svg')"></span>`;
      const primary = item.status === 'waiting_component'
        ? `<button class="button compact" data-action="open-settings-section" data-settings-target="components-settings">安装组件</button>`
        : item.status !== 'ready' && item.status !== 'resolving'
          ? `<button class="button compact" data-resolve="${item.id}">${item.status === 'failed' ? '重试' : '识别'}</button>`
          : item.status === 'ready' && !['queued', 'downloading', 'completed'].includes(job?.status)
            ? `<button class="button compact primary" data-inbox-detail="${item.id}">准备下载</button>` : '';
      return `<article class="inbox-card ${isActive ? 'active' : ''}" data-inbox-card-id="${item.id}">
        <label class="card-check"><input type="checkbox" data-select-item="${item.id}" aria-label="选择 ${escapeHtml(item.title)}" ${selected.has(item.id) ? 'checked' : ''}></label>
        <button class="inbox-card-main" type="button" data-inbox-detail="${item.id}" aria-pressed="${isActive}"><span class="media-thumb">${thumb}<small>${item.durationSeconds == null ? '--:--' : formatDuration(item.durationSeconds)}</small></span><span class="inbox-card-copy"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.sourceHost)} · ${escapeHtml(item.projectName)} · ${escapeHtml(formatTime(item.createdAt))}</span>${item.errorMessage ? `<em>${escapeHtml(item.errorMessage)}</em>` : ''}</span></button>
        <div class="inbox-card-status"><span class="status status-${escapeHtml(display.status)}">${escapeHtml(display.label)}</span>${primary}</div>
      </article>`;
    }).join('') : `<div class="phase2-empty"><span class="ui-icon" style="--icon:url('./assets/icons/inbox.svg')"></span><strong>当前筛选下没有条目</strong><p>添加链接或从 Chrome 扩展发送页面。</p><button class="button primary" data-action="open-add">${icon('plus')}添加链接</button></div>`;

    let inspector;
    if (!active) {
      inspector = window.ClipCargoInspector.render({ empty: true, title: '选择一条收集内容', subtitle: '在这里检查来源、调整下载选项并归档。' });
    } else {
      const subtitleOptions = Array.isArray(active.subtitleOptions) ? active.subtitleOptions : [];
      const authRequired = /登录|会话|cookie|凭据/i.test(active.errorMessage || '') || active.authRequired === true;
      const ready = active.status === 'ready';
      const itemFailed = active.status === 'failed';
      const jobFailed = activeJob?.status === 'failed';
      const componentReady = state.components?.ytDlpReady !== false;
      const preflightTone = !componentReady || authRequired ? 'warning' : itemFailed || jobFailed ? 'danger' : ready ? 'success' : 'neutral';
      const preflightText = !componentReady ? '缺少下载引擎' : authRequired ? '需要登录态' : itemFailed ? '识别失败' : jobFailed ? '下载失败' : ready ? '预检通过' : '等待识别';
      const preflightDetail = !componentReady
        ? '需先安装 yt-dlp 下载引擎。'
        : authRequired
          ? '需通过隔离浏览器完成来源登录。'
          : itemFailed
            ? (active.errorMessage || '来源解析失败，可重试或检查链接。')
            : jobFailed
              ? (activeJob?.errorMessage || '上次下载未完成，可重试。')
              : ready
                ? `${active.hasVideo === false ? '仅音频' : '视频轨'} · ${active.hasAudio === false ? '无音轨' : '音轨'} · ${formatBytes(active.estimatedBytes || 0)}`
                : '完成识别后可配置输出参数。';
      const confirming = state.pendingInboxRemoval === active.id;
      const previewUrl = safeThumbnail(active.thumbnailUrl || active.coverDataUrl || active.cover_data_url || '');
      const preview = `<div class="inbox-inspector-preview">${previewUrl ? `<img src="${escapeHtml(previewUrl)}" alt="">` : `<span class="ui-icon" style="--icon:url('./assets/icons/${active.hasAudio && active.hasVideo === false ? 'music-2' : 'film'}.svg')"></span>`}<div class="preview-scrim"><small>${escapeHtml(active.sourceHost || '本地素材')}</small><time>${active.durationSeconds == null ? '--:--' : formatDuration(active.durationSeconds)}</time></div></div>`;
      const body = `${preview}<form class="inspector-form" data-inbox-inspector-form>
        <label><span>显示名称</span><input id="inspector-inbox-title" data-focus-key="inbox-title" data-preserve-refresh class="field-control" value="${escapeHtml(draft.title)}"></label>
        <label><span>归属项目</span><select id="inspector-inbox-project" data-focus-key="inbox-project" data-preserve-refresh class="field-control">${state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${project.name === draft.projectName ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}</select></label>
        <button class="button compact inspector-save-btn" type="button" data-action="save-inbox-inspector">保存修改</button>
      </form>
      <section class="inspector-section"><div class="section-heading"><strong>输出预设</strong><span>${ready ? `最高 ${active.maxHeight || '未知'}p` : '识别后可用'}</span></div><div class="preset-grid">${[
        ['package', 'package-open', '完整素材包'], ['video', 'film', '兼容 MP4'], ['source', 'file-video', '原格式'], ['audio', 'music-2', 'MP3'],
      ].map(([id, iconName, label]) => `<button class="preset-option ${draft.preset === id ? 'active' : ''}" type="button" data-inbox-preset="${id}">${icon(iconName)}<span>${label}</span></button>`).join('')}</div></section>
      <section class="inspector-section option-stack"><label><span>清晰度</span><select id="inbox-inspector-quality" data-preserve-refresh class="field-control" ${draft.preset === 'audio' ? 'disabled' : ''}>${[...new Set([...(active.availableHeights || []), active.maxHeight].filter(Number.isFinite))].sort((a,b) => b-a).map((height) => `<option value="${height}" ${String(draft.quality) === String(height) ? 'selected' : ''}>最高 ${height}p</option>`).join('') || `<option value="best">最佳可用</option>`}</select></label>
        <details class="inspector-save-options"><summary>更多保存选项（字幕 / 封面 / 来源记录）</summary><div>
          <label class="check-row"><input id="inbox-inspector-subtitles" type="checkbox" ${draft.saveSubtitles ? 'checked' : ''}><span>保存独立 VTT 字幕${subtitleOptions.length ? `（${subtitleOptions.length} 轨）` : ''}</span></label>
          <label class="check-row"><input id="inbox-inspector-cover" type="checkbox" ${draft.saveCover ? 'checked' : ''}><span>保存封面</span></label>
          <label class="check-row"><input id="inbox-inspector-source-record" type="checkbox" ${draft.saveSourceRecord ? 'checked' : ''}><span>保存来源记录</span></label>
          <label class="check-row"><input id="inbox-inspector-retain-source" type="checkbox" ${draft.retainSource ? 'checked' : ''}><span>素材包保留来源格式</span></label>
        </div></details>
      </section>
      <section class="preflight-card ${preflightTone}"><div class="preflight-head"><span><span class="status-dot"></span><strong>${preflightText}</strong></span>${authRequired ? `<button class="button compact" type="button" data-action="open-inbox-login">隔离登录</button>` : ''}</div><p>${escapeHtml(preflightDetail)}</p></section>
      ${confirming ? `<section class="inline-confirm-panel" data-confirm-persistent="true"><div><strong>从收集箱移除？</strong><p>只删除收集记录，不会删除已经下载的素材。</p></div><div class="inline-confirm-actions"><button class="button compact" data-cancel-inbox-remove>取消</button><button class="button compact danger" data-confirm-inbox-remove="${active.id}">确认移除</button></div></section>` : ''}
      <div class="inspector-secondary-actions">${active.captureMethod === 'local-import' ? '' : `<button class="text-button" data-open-source="${active.id}">${icon('external-link')}打开来源</button>`}<button class="text-button danger-text" data-remove="${active.id}" ${canRemove(active, activeJob) ? '' : 'disabled'}>${icon('trash-2')}从收集中移除</button></div>`;
      const actions = activeJob?.status === 'completed'
        ? `<button class="button primary wide" data-view="library">查看素材包</button>`
        : activeJob && ['queued', 'downloading', 'paused'].includes(activeJob.status)
          ? `<button class="button primary wide" data-view="tasks">查看下载任务</button>`
          : `<button class="button primary wide" data-action="download-inspector" ${ready && componentReady && !authRequired ? '' : 'disabled'}>${icon('download')}立即下载并归档</button>`;
      inspector = window.ClipCargoInspector.render({ eyebrow: `条目检视与下载 · ${escapeHtml(preflightText)}`, body, actions });
    }

    return `<div class="phase2-view inbox-workbench"><div class="workbench-split"><section class="workbench-primary"><div class="phase2-filter-row">${tabs}<div class="phase2-header-actions"><button class="button" data-action="open-local-drawer">${icon('file-up')}本地导入</button><button class="button primary" data-action="open-add">${icon('plus')}批量添加链接</button></div></div>${selectionBar}<section class="workbench-list"><div class="inbox-card-list">${cards}</div>${pagination('inbox', state.inboxPage, pageCount, filtered.length)}</section></section>${inspector}</div></div>`;
  }

  window.ClipCargoViews = window.ClipCargoViews || {};
  window.ClipCargoViews.inbox = { render };
})();
