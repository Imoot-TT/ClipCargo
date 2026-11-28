(function () {
  function completedAssets(state) {
    const originals = state.jobs.filter((job) => job.status === 'completed' && !job.libraryHidden).map((job) => ({ ...job, assetType: 'original', assetId: job.id, parentJobId: job.id, kind: 'original' }));
    const derivatives = state.derivatives.filter((item) => item.status === 'completed' && !item.libraryHidden).map((item) => ({ ...item, assetType: 'derivative', assetId: item.id, parentJobId: item.parentJobId || item.jobId, kind: item.kind || 'derivative' }));
    return [...originals, ...derivatives];
  }

  function render(context) {
    const { state, selected, helpers } = context;
    const { escapeHtml, icon, formatTime, formatDuration, formatBytes, derivativeKind, outputPresetLabel, pagination, safeThumbnail } = helpers;
    const workspace = window.ClipCargoWorkspace;
    const assets = completedAssets(state);
    const packages = state.jobs.filter((job) => job.status === 'completed' && !job.libraryHidden);
    const query = state.libraryQuery.trim().toLocaleLowerCase('zh-CN');
    const filterAsset = (asset) => (!query || `${asset.title} ${asset.projectName} ${asset.sourceHost}`.toLocaleLowerCase('zh-CN').includes(query))
      && (state.libraryProject === 'all' || asset.projectName === state.libraryProject)
      && (state.libraryKind === 'all' || (state.libraryKind === 'video' && asset.assetType === 'original') || (state.libraryKind === 'derivative' && asset.assetType === 'derivative') || asset.kind === state.libraryKind);
    const filteredAssets = assets.filter(filterAsset);
    const filteredPackages = packages.filter((job) => filterAsset({ ...job, assetType: 'original', kind: 'original' }));
    const currentList = state.libraryView === 'packages' ? filteredPackages : filteredAssets;
    const pageCount = Math.max(1, Math.ceil(currentList.length / context.pageSize));
    state.libraryPage = Math.min(Math.max(1, state.libraryPage), pageCount);
    const visible = currentList.slice((state.libraryPage - 1) * context.pageSize, state.libraryPage * context.pageSize);
    for (const key of [...selected]) if (!assets.some((asset) => `${asset.assetType}:${asset.assetId}` === key)) selected.delete(key);
    const activePool = state.libraryView === 'packages'
      ? filteredPackages.map((job) => ({ assetType: 'original', assetId: job.id }))
      : filteredAssets;
    if (!activePool.length) {
      workspace.ui.library.activeKey = null;
    } else if (!workspace.ui.library.activeKey || !activePool.some((asset) => `${asset.assetType}:${asset.assetId}` === workspace.ui.library.activeKey)) {
      const first = activePool[0];
      workspace.ui.library.activeKey = first ? `${first.assetType}:${first.assetId}` : null;
    }
    const [activeType, activeIdRaw] = String(workspace.ui.library.activeKey || '').split(':');
    const activeId = Number(activeIdRaw);
    const active = activePool.length ? assets.find((asset) => asset.assetType === activeType && asset.assetId === activeId) || null : null;
    const activePackage = active ? packages.find((job) => job.id === (active.assetType === 'original' ? active.id : active.parentJobId)) : null;
    const libraryDraft = workspace.ensureLibraryDraft(active);

    const tabs = window.ClipCargoViewTabs.render([
      { id: 'packages', label: '素材包', count: packages.length },
      { id: 'assets', label: '全部文件', count: assets.length },
      { id: 'board', label: '分镜故事板' },
    ], state.libraryView, 'library-view', '素材库视图');
    const editorLabel = escapeHtml(state.editor?.name || '剪辑软件');
    const visibleKeys = visible.map((item) => (state.libraryView === 'packages' ? `original:${item.id}` : `${item.assetType}:${item.assetId}`));
    const selectedAssets = assets.filter((asset) => selected.has(`${asset.assetType}:${asset.assetId}`));
    const selectionBar = window.ClipCargoSelectionBar.render({
      count: selected.size,
      allChecked: Boolean(visibleKeys.length && visibleKeys.every((key) => selected.has(key))),
      selectAttribute: 'data-select-library-visible',
      actions: `<button class="button compact" data-action="clear-library-selection">取消选择</button><button class="button compact primary" data-action="import-selected-library" ${state.editor && selectedAssets.length ? '' : 'disabled'}>${icon('external-link')}导入 ${editorLabel} ${selectedAssets.length || ''}</button>`,
    });

    const packageCards = visible.map((job) => {
      const key = `original:${job.id}`;
      const isActive = workspace.ui.library.activeKey === key;
      const thumb = safeThumbnail(job.thumbnailUrl) ? `<img src="${safeThumbnail(job.thumbnailUrl)}" alt="">` : `<span class="ui-icon" style="--icon:url('./assets/icons/package-open.svg')"></span>`;
      return `<article class="library-package-card ${isActive ? 'active' : ''}"><label class="card-check"><input type="checkbox" data-select-library="${key}" ${selected.has(key) ? 'checked' : ''} aria-label="选择 ${escapeHtml(job.title)}"></label><button class="package-card-main" data-library-inspect="${key}"><span class="package-cover">${thumb}<small>${formatDuration(job.durationSeconds)}</small></span><span><strong>${escapeHtml(job.title)}</strong><em>${escapeHtml(job.projectName)} · ${outputPresetLabel(job.outputPreset)}</em><small>${job.imageCount || 0} 张图片 · ${job.subtitleCount || 0} 条字幕 · ${formatTime(job.updatedAt)}</small></span></button><div class="package-card-actions"><button class="button compact" data-open-asset-package="${job.id}">${icon('folder')}打开</button><button class="button compact primary" data-import-package-editor="${job.id}" ${state.editor ? '' : 'disabled'}>导入 ${editorLabel}</button></div></article>`;
    }).join('');

    const assetCards = visible.map((asset) => {
      const key = `${asset.assetType}:${asset.assetId}`;
      const isActive = workspace.ui.library.activeKey === key;
      const thumb = safeThumbnail(asset.thumbnailUrl) ? `<img src="${safeThumbnail(asset.thumbnailUrl)}" alt="">` : `<span class="ui-icon" style="--icon:url('./assets/icons/${asset.kind === 'audio' ? 'music-2' : 'file-video'}.svg')"></span>`;
      return `<article class="library-file-card ${isActive ? 'active' : ''}"><label class="card-check"><input type="checkbox" data-select-library="${key}" ${selected.has(key) ? 'checked' : ''} aria-label="选择 ${escapeHtml(asset.title)}"></label><button class="file-card-main" data-library-inspect="${key}"><span class="file-thumb">${thumb}</span><span><strong>${escapeHtml(asset.title)}</strong><em>${asset.assetType === 'original' ? outputPresetLabel(asset.outputPreset) : derivativeKind(asset.kind)} · ${escapeHtml(asset.projectName)}</em><small>${formatDuration(asset.durationSeconds)} · ${formatTime(asset.updatedAt)}</small></span></button><button class="icon-button" data-play-id="${asset.assetId}" data-play-type="${asset.assetType}" title="预览">${icon('circle-play')}</button></article>`;
    }).join('');

    const board = filteredAssets.length ? `<div class="storyboard-grid">${filteredAssets.map((asset, index) => {
      const key = `${asset.assetType}:${asset.assetId}`;
      const thumb = safeThumbnail(asset.thumbnailUrl) ? `<img src="${safeThumbnail(asset.thumbnailUrl)}" alt="">` : `<span class="ui-icon" style="--icon:url('./assets/icons/film.svg')"></span>`;
      return `<button class="storyboard-card" data-library-inspect="${key}"><span class="storyboard-index">${String(index + 1).padStart(2, '0')}</span><span class="storyboard-thumb">${thumb}<small>${formatDuration(asset.durationSeconds)}</small></span><strong>${escapeHtml(asset.title)}</strong><em>${escapeHtml(asset.projectName)}</em></button>`;
    }).join('')}</div>` : '<div class="phase2-empty"><strong>还没有可编排的素材</strong><p>下载或导入素材后会自动出现在分镜故事板中。</p></div>';

    let inspector;
    if (!active || !activePackage) {
      inspector = window.ClipCargoInspector.render({ empty: true, title: '选择素材包或文件', subtitle: '查看包内结构、字幕和安全移除选项。' });
    } else {
      const tracks = workspace.ui.library.subtitleTracks;
      const q = workspace.ui.library.subtitleQuery.toLocaleLowerCase('zh-CN');
      const cues = workspace.ui.library.subtitleCues.filter((cue) => !q || cue.text.toLocaleLowerCase('zh-CN').includes(q));
      const removalKey = `${active.assetType}:${active.assetId}`;
      const confirming = state.pendingLibraryRemoval === removalKey;
      const impact = state.pendingLibraryImpact;
      const hasSubtitles = Boolean(tracks.length || activePackage.subtitleCount);
      const subtitleBlock = hasSubtitles
        ? `<section class="inspector-section subtitle-search-section"><div class="section-heading"><strong>字幕检索</strong><span>${tracks.length || activePackage.subtitleCount} 轨</span></div><label class="search-field"><span class="ui-icon" style="--icon:url('./assets/icons/search.svg')"></span><input id="subtitle-search" data-focus-key="subtitle-search" data-preserve-refresh value="${escapeHtml(workspace.ui.library.subtitleQuery)}" placeholder="搜索字幕跳转播放…"></label><div class="subtitle-results">${workspace.ui.library.subtitleLoading ? '<p>正在读取字幕…</p>' : workspace.ui.library.subtitleError ? `<p>${escapeHtml(workspace.ui.library.subtitleError)}</p>` : cues.length ? cues.slice(0, 12).map((cue) => `<button type="button" data-subtitle-seconds="${cue.seconds}"><time>${escapeHtml(cue.time)}</time><span>${escapeHtml(cue.text)}</span></button>`).join('') : '<p>输入关键词查找字幕片段。</p>'}</div></section>`
        : '';
      const body = `<form class="inspector-form" data-library-inspector-form><label><span>素材名称</span><input id="library-inspector-title" data-focus-key="library-title" data-preserve-refresh class="field-control" value="${escapeHtml(libraryDraft.title)}"></label><label><span>归属项目</span><select id="library-inspector-project" data-focus-key="library-project" data-preserve-refresh class="field-control">${state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${project.name === libraryDraft.projectName ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}</select></label><button class="button compact inspector-save-btn" type="button" data-action="save-library-inspector">保存修改</button></form>
      <section class="inspector-section asset-facts"><div><span>时长</span><strong>${formatDuration(active.durationSeconds)}</strong></div><div><span>存储方式</span><strong>${active.managedFile === false ? '外部引用' : '本地受管'}</strong></div></section>
      ${subtitleBlock}
      ${confirming ? `<section class="inline-confirm-panel" data-confirm-persistent="true"><div><strong>安全移除素材</strong><p>${impact?.managedFile === false ? '这是外部引用，只会从素材库移除，不会触碰原文件。' : '请选择保留硬盘文件，或将 ClipCargo 管理的文件移到回收站。'}</p><small>${impact?.fileName ? `${escapeHtml(impact.fileName)} · ${formatBytes(impact.sizeBytes || 0)}` : ''}</small></div><div class="inline-confirm-actions"><button class="button compact" data-cancel-library-removal>取消</button><button class="button compact" data-confirm-library-removal-id="${active.assetId}" data-confirm-library-removal-type="${active.assetType}">仅从库移除</button>${impact?.managedFile === false ? '' : `<button class="button compact danger" data-trash-library-id="${active.assetId}" data-trash-library-type="${active.assetType}">移到回收站</button>`}</div></section>` : ''}`;
      const actions = `<button class="button compact" data-reveal-id="${active.assetId}" data-reveal-type="${active.assetType}">${icon('folder')}位置</button><button class="button compact" data-play-id="${active.assetId}" data-play-type="${active.assetType}">${icon('circle-play')}预览</button><button class="button compact primary" data-import-editor-id="${active.assetId}" data-import-editor-type="${active.assetType}" ${state.editor ? '' : 'disabled'}>导入 ${editorLabel}</button><button class="icon-button danger-text" data-remove-library-id="${active.assetId}" data-remove-library-type="${active.assetType}" aria-label="移除素材" title="移除素材">${icon('trash-2')}</button>`;
      inspector = window.ClipCargoInspector.render({ eyebrow: '素材包详情', title: escapeHtml(libraryDraft.title), subtitle: `${escapeHtml(libraryDraft.projectName)} · ${active.assetType === 'original' ? outputPresetLabel(active.outputPreset) : derivativeKind(active.kind)}`, body, actions });
    }

    const emptyLibrary = `<div class="phase2-empty"><span class="ui-icon" style="--icon:url('./assets/icons/library.svg')"></span><strong>${state.libraryProject !== 'all' ? `「${escapeHtml(state.libraryProject)}」下暂无已入库素材` : '暂无已入库素材'}</strong><p>${state.libraryProject !== 'all' ? '下载完成或导入到该项目后将显示在这里。' : '在收集箱下载视频或导入本地文件后将显示在这里。'}</p>${state.libraryProject !== 'all' ? `<button class="button compact" data-action="clear-library-filters">查看全部项目</button>` : `<button class="button compact primary" data-view="inbox">前往收集箱</button>`}</div>`;
    const listContent = state.libraryView === 'board'
      ? board
      : visible.length
        ? `<div class="${state.libraryView === 'packages' ? 'library-package-list' : 'library-file-list'}">${state.libraryView === 'packages' ? packageCards : assetCards}</div>${pagination('library', state.libraryPage, pageCount, currentList.length)}`
        : emptyLibrary;
    return `<div class="phase2-view library-workbench"><div class="workbench-split"><section class="workbench-primary"><div class="phase2-filter-row library-filter-row">${tabs}<div class="filter-actions"><select id="library-kind" class="field-control compact-select" aria-label="按类型筛选"><option value="all">全部类型</option><option value="video" ${state.libraryKind === 'video' ? 'selected' : ''}>原始素材</option><option value="derivative" ${state.libraryKind === 'derivative' ? 'selected' : ''}>处理副本</option><option value="audio" ${state.libraryKind === 'audio' ? 'selected' : ''}>音频</option></select></div></div>${selectionBar}<section class="workbench-list">${listContent}</section></section>${inspector}</div></div>`;
  }

  window.ClipCargoViews = window.ClipCargoViews || {};
  window.ClipCargoViews.library = { render, completedAssets };
})();
