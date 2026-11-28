(function () {
  const MODES = [
    ['clip', 'scissors', '截取片段', '使用时间线入点与出点'],
    ['crop-vertical', 'film', '9:16 取景', '拖动安全框调整构图'],
    ['speed-2x', 'gauge', '2 倍速', '画面与声音同步'],
    ['rotate-left', 'rotate-ccw', '左转 90°', '生成旋转副本'],
    ['rotate-right', 'rotate-cw', '右转 90°', '生成旋转副本'],
    ['compress', 'minimize-2', '压缩', '最长边不超过 1280'],
    ['audio', 'music-2', '提取 MP3', '只保留音频轨'],
    ['mute', 'volume-x', '移除声音', '生成无声视频'],
    ['convert', 'refresh-cw', '兼容 MP4', 'H.264 + AAC'],
  ];

  let mounted = null;
  let timelineDrag = null;
  let cropDrag = null;
  let positionSavedAt = 0;

  function assets(state) {
    return window.ClipCargoViews.library.completedAssets(state).filter((asset) => {
      if (!asset.filePath || asset.fileMissing || asset.hasVideo === false) return false;
      return !/\.(mp3|m4a|wav|flac|ogg)$/i.test(asset.filePath);
    });
  }

  function activeAsset(state) {
    const list = assets(state);
    const workspace = window.ClipCargoWorkspace;
    if (!workspace.ui.studio.activeKey || !list.some((asset) => `${asset.assetType}:${asset.assetId}` === workspace.ui.studio.activeKey)) {
      const preferred = workspace.ui.library.activeKey;
      workspace.ui.studio.activeKey = list.some((asset) => `${asset.assetType}:${asset.assetId}` === preferred)
        ? preferred
        : list[0] ? `${list[0].assetType}:${list[0].assetId}` : null;
    }
    return list.find((asset) => `${asset.assetType}:${asset.assetId}` === workspace.ui.studio.activeKey) || null;
  }

  function formatClock(seconds) {
    const value = Math.max(0, Number(seconds || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor(value % 3600 / 60);
    const secs = Math.floor(value % 60);
    const fraction = Math.floor((value % 1) * 10);
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${fraction}`;
  }

  function render(context) {
    const { state, helpers } = context;
    const { escapeHtml, icon } = helpers;
    const list = assets(state);
    const asset = activeAsset(state);
    if (!asset) {
      return `<div class="phase2-view studio-empty"><section class="studio-empty-card"><div>${icon('scissors')}</div><h1>预览与快剪台</h1><p>素材库中还没有可预览的视频。下载或导入视频后即可在这里标记片段并创建处理副本。</p><button class="button primary" data-view="library">前往素材库</button></section></div>`;
    }
    const workspace = window.ClipCargoWorkspace;
    const session = workspace.ensureStudioSession(asset);
    const duration = Math.max(session.duration || 0, Number(asset.durationSeconds || 0));
    const clipDuration = Math.max(0, session.outPoint - session.inPoint);
    const componentReady = state.components?.ffmpegReady !== false;
    const originalJobId = asset.assetType === 'original' ? asset.assetId : asset.parentJobId;
    const noteRows = session.notes.length ? session.notes.map((note) => `<div class="studio-note-row" data-note-id="${note.id}"><button type="button" data-note-seek="${note.id}"><time>${formatClock(note.time)}</time></button><input data-note-text="${note.id}" data-preserve-refresh value="${escapeHtml(note.text)}" aria-label="片段笔记"><button class="icon-button" type="button" data-note-delete="${note.id}" aria-label="删除笔记" title="删除笔记">${icon('x')}</button></div>`).join('') : '<p class="studio-notes-empty">按 M 在当前时间点添加笔记。</p>';
    const modeButtons = MODES.map(([id, iconName, label, detail]) => `<button type="button" class="studio-tool ${session.mode === id ? 'active' : ''}" data-studio-mode="${id}" role="radio" aria-checked="${session.mode === id}">${icon(iconName)}<span><strong>${label}</strong><small>${detail}</small></span></button>`).join('');
    const cropControls = `<section class="studio-mode-controls studio-crop-controls" ${session.mode === 'crop-vertical' ? '' : 'hidden'}><label><span>水平位置</span><input id="studio-crop-x" type="range" min="0" max="100" value="${session.cropX}"><output>${Math.round(session.cropX)}%</output></label><label><span>垂直位置</span><input id="studio-crop-y" type="range" min="0" max="100" value="${session.cropY}"><output>${Math.round(session.cropY)}%</output></label><label><span>画面缩放</span><input id="studio-crop-zoom" type="range" min="100" max="200" value="${session.cropZoom}"><output>${Math.round(session.cropZoom)}%</output></label><p>输出固定为 720×1280；拖动舞台上的安全框可同步调整位置。</p></section>`;
    const clipControls = `<section class="studio-mode-controls studio-clip-summary" ${session.mode === 'clip' ? '' : 'hidden'}><div><span>入点</span><strong data-studio-in-label>${formatClock(session.inPoint)}</strong></div><div><span>出点</span><strong data-studio-out-label>${formatClock(session.outPoint)}</strong></div><div><span>区间</span><strong data-studio-range-label>${formatClock(clipDuration)}</strong></div></section>`;
    return `<div class="phase2-view studio-view" data-studio-key="${asset.assetType}:${asset.assetId}" data-studio-job-id="${originalJobId}">
      <header class="studio-header"><div style="display:flex;align-items:center;gap:8px;min-width:0;"><button class="button compact" type="button" data-view="library">← 返回素材库</button><h1>${escapeHtml(asset.title)}</h1></div><div class="studio-header-actions"><label><span>当前素材</span><select id="studio-asset-select" class="field-control">${list.map((item) => { const key = `${item.assetType}:${item.assetId}`; return `<option value="${key}" ${key === workspace.ui.studio.activeKey ? 'selected' : ''}>${escapeHtml(item.title)}</option>`; }).join('')}</select></label><button class="button compact" type="button" data-view="tasks">${icon('list-checks')}任务</button></div></header>
      <div class="studio-layout">
        <section class="studio-canvas-column">
          <div class="studio-video-stage" id="studio-video-stage">
            <video id="studio-video" preload="metadata" playsinline></video>
            <div id="studio-loading" class="studio-stage-message" role="status">${icon('refresh-cw')}<span>正在加载本地预览…</span></div>
            <div id="studio-video-error" class="studio-stage-error" role="alert" hidden><strong>当前素材无法直接预览</strong><p></p><div><button class="button primary" data-studio-compatible ${asset.assetType === 'original' ? '' : 'hidden'}>生成兼容副本</button><button class="button" data-studio-external>使用系统播放器</button></div></div>
            <div id="studio-crop-frame" class="studio-crop-frame" tabindex="0" aria-label="9:16 竖屏取景框" ${session.mode === 'crop-vertical' ? '' : 'hidden'}><span>9:16 安全框</span></div>
          </div>
          <div class="studio-transport"><button class="icon-button transport-play" type="button" data-studio-play aria-label="播放或暂停" title="播放或暂停">${icon('play')}</button><time><span data-studio-current>${formatClock(session.currentTime)}</span> / <span data-studio-duration>${formatClock(duration)}</span></time><label>倍速<select id="studio-rate" class="field-control"><option value="0.5" ${session.playbackRate === .5 ? 'selected' : ''}>0.5×</option><option value="1" ${session.playbackRate === 1 ? 'selected' : ''}>1×</option><option value="1.25" ${session.playbackRate === 1.25 ? 'selected' : ''}>1.25×</option><option value="1.5" ${session.playbackRate === 1.5 ? 'selected' : ''}>1.5×</option><option value="2" ${session.playbackRate === 2 ? 'selected' : ''}>2×</option></select></label><button class="button compact" type="button" data-studio-external>${icon('external-link')}系统播放器</button></div>
          <section class="studio-timeline-panel">
            <div class="timeline-heading"><div><strong>可视化时间线</strong><span>拖动播放头或入/出点手柄</span></div><div><kbd>I</kbd> 入点 <kbd>O</kbd> 出点 <kbd>M</kbd> 笔记</div></div>
            <div id="studio-timeline" class="studio-timeline" role="slider" tabindex="0" aria-label="视频时间线" aria-valuemin="0" aria-valuemax="${duration}" aria-valuenow="${session.currentTime}"><div class="timeline-ruler"></div><div class="timeline-selection"></div><button class="timeline-handle in" type="button" data-timeline-handle="in" aria-label="拖动入点"><span>IN</span></button><button class="timeline-handle out" type="button" data-timeline-handle="out" aria-label="拖动出点"><span>OUT</span></button><div class="timeline-playhead"><span></span></div><div class="timeline-markers">${session.notes.map((note) => `<button type="button" data-note-seek="${note.id}" title="${escapeHtml(note.text)}" style="left:${percent(note.time, Math.max(.001, duration))}%"></button>`).join('')}</div></div>
            <div class="timeline-labels"><span>00:00</span><strong data-studio-range-label>选区 ${formatClock(clipDuration)}</strong><span>${formatClock(duration)}</span></div>
          </section>
          <section class="studio-notes"><header><div><strong>片段笔记</strong><span>随素材保存在当前工作区</span></div><button class="button compact" type="button" data-note-add>${icon('plus')}当前时间添加</button></header><div id="studio-note-list">${noteRows}</div></section>
        </section>
        <aside class="studio-tools-panel"><header><div><span>FFmpeg 非破坏式加工</span><h2>创建处理副本</h2></div><span class="state-pill ${componentReady ? 'success' : 'warning'}">${componentReady ? '工具已就绪' : '缺少 FFmpeg'}</span></header><div class="studio-tool-grid" role="radiogroup" aria-label="处理模式">${modeButtons}</div>${clipControls}${cropControls}<div id="studio-process-error" class="form-error" role="alert"></div>${componentReady ? '' : `<div class="studio-component-warning"><p>开始处理前需要安装视频处理工具。</p><button class="button" data-studio-settings>前往设置安装</button></div>`}<label class="studio-auto-import"><input id="studio-auto-import" type="checkbox" ${session.autoImport ? 'checked' : ''} ${state.editor ? '' : 'disabled'}><span><strong>完成后导入${escapeHtml(state.editor?.name || '剪映 Pro')}</strong><small>${state.editor ? '保持 ClipCargo 运行，任务完成后自动触发一次导入' : '当前未发现可用的剪辑软件'}</small></span></label><button id="studio-process-submit" class="button primary wide" type="button" ${componentReady ? '' : 'disabled'}>${icon('refresh-cw')}创建处理任务</button><p class="studio-process-note">${asset.assetType === 'derivative' ? '当前选择的是处理副本；受后端契约限制，将以对应素材包主文件继续加工。' : '原素材不会被覆盖，结果将作为新文件进入素材库。'}</p></aside>
      </div>
    </div>`;
  }

  function percent(value, duration) {
    return duration > 0 ? Math.max(0, Math.min(100, value / duration * 100)) : 0;
  }

  function patchTimeline(session, video) {
    const root = document.querySelector('.studio-view');
    const timeline = root?.querySelector('#studio-timeline');
    if (!timeline) return;
    const videoDur = video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const duration = Math.max(.001, session.duration || videoDur || 0);
    if (!session.outPoint || session.outPoint > duration) session.outPoint = duration;
    const rawTime = video && video.readyState >= 1 ? video.currentTime : session.currentTime;
    const current = Math.max(0, Math.min(duration, Number.isFinite(rawTime) ? rawTime : 0));
    session.currentTime = current;
    timeline.setAttribute('aria-valuemax', String(duration));
    timeline.setAttribute('aria-valuenow', String(current));
    timeline.querySelector('.timeline-playhead').style.left = `${percent(current, duration)}%`;
    timeline.querySelector('.timeline-handle.in').style.left = `${percent(session.inPoint, duration)}%`;
    timeline.querySelector('.timeline-handle.out').style.left = `${percent(session.outPoint, duration)}%`;
    const start = percent(session.inPoint, duration);
    const end = percent(session.outPoint, duration);
    const selection = timeline.querySelector('.timeline-selection');
    selection.style.left = `${start}%`;
    selection.style.width = `${Math.max(0, end - start)}%`;
    root.querySelectorAll('[data-studio-current]').forEach((node) => { node.textContent = formatClock(current); });
    root.querySelectorAll('[data-studio-duration]').forEach((node) => { node.textContent = formatClock(duration); });
    root.querySelectorAll('[data-studio-in-label]').forEach((node) => { node.textContent = formatClock(session.inPoint); });
    root.querySelectorAll('[data-studio-out-label]').forEach((node) => { node.textContent = formatClock(session.outPoint); });
    root.querySelectorAll('[data-studio-range-label]').forEach((node) => {
      node.textContent = node.closest('.timeline-labels') ? `选区 ${formatClock(Math.max(0, session.outPoint - session.inPoint))}` : formatClock(Math.max(0, session.outPoint - session.inPoint));
    });
  }

  function videoContentRect(video) {
    const box = video.getBoundingClientRect();
    if (!video.videoWidth || !video.videoHeight || !box.width || !box.height) return box;
    const videoRatio = video.videoWidth / video.videoHeight;
    const boxRatio = box.width / box.height;
    if (videoRatio > boxRatio) {
      const height = box.width / videoRatio;
      return { left: box.left, top: box.top + (box.height - height) / 2, width: box.width, height };
    }
    const width = box.height * videoRatio;
    return { left: box.left + (box.width - width) / 2, top: box.top, width, height: box.height };
  }

  function patchCrop(session, video) {
    const frame = document.querySelector('#studio-crop-frame');
    const stage = document.querySelector('#studio-video-stage');
    if (!frame || !stage || frame.hidden) return;
    const rect = videoContentRect(video);
    const stageRect = stage.getBoundingClientRect();
    const zoom = session.cropZoom / 100;
    let height = rect.height / zoom;
    let width = height * 9 / 16;
    if (width > rect.width / zoom) { width = rect.width / zoom; height = width * 16 / 9; }
    const rangeX = Math.max(0, rect.width - width);
    const rangeY = Math.max(0, rect.height - height);
    frame.style.width = `${width}px`;
    frame.style.height = `${height}px`;
    frame.style.left = `${rect.left - stageRect.left + rangeX * session.cropX / 100}px`;
    frame.style.top = `${rect.top - stageRect.top + rangeY * session.cropY / 100}px`;
    for (const [id, value] of [['studio-crop-x', session.cropX], ['studio-crop-y', session.cropY], ['studio-crop-zoom', session.cropZoom]]) {
      const input = document.querySelector(`#${id}`);
      if (input && document.activeElement !== input) input.value = String(value);
      const output = input?.closest('label')?.querySelector('output');
      if (output) output.textContent = `${Math.round(value)}%`;
    }
  }

  function renderNotes(session) {
    const list = document.querySelector('#studio-note-list');
    const markers = document.querySelector('.timeline-markers');
    if (!list || !markers) return;
    const escapeHtml = mounted.context.helpers.escapeHtml;
    const icon = mounted.context.helpers.icon;
    list.innerHTML = session.notes.length ? session.notes.map((note) => `<div class="studio-note-row" data-note-id="${note.id}"><button type="button" data-note-seek="${note.id}"><time>${formatClock(note.time)}</time></button><input data-note-text="${note.id}" data-preserve-refresh value="${escapeHtml(note.text)}" aria-label="片段笔记"><button class="icon-button" type="button" data-note-delete="${note.id}" aria-label="删除笔记" title="删除笔记">${icon('x')}</button></div>`).join('') : '<p class="studio-notes-empty">按 M 在当前时间点添加笔记。</p>';
    const duration = Math.max(.001, session.duration);
    markers.innerHTML = session.notes.map((note) => `<button type="button" data-note-seek="${note.id}" title="${escapeHtml(note.text)}" style="left:${percent(note.time, duration)}%"></button>`).join('');
  }

  function addNote(session, video) {
    const time = Math.max(0, Math.min(session.duration || Infinity, video.currentTime || 0));
    session.notes.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, time, text: '片段笔记' });
    session.notes.sort((a, b) => a.time - b.time);
    renderNotes(session);
    document.querySelector(`[data-note-id="${session.notes.find((note) => note.time === time)?.id}"] input`)?.select();
  }

  function setMode(session, mode) {
    if (!MODES.some(([id]) => id === mode)) return;
    session.mode = mode;
    document.querySelectorAll('[data-studio-mode]').forEach((button) => {
      const active = button.dataset.studioMode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
    });
    document.querySelector('.studio-crop-controls').hidden = mode !== 'crop-vertical';
    document.querySelector('.studio-clip-summary').hidden = mode !== 'clip';
    document.querySelector('#studio-crop-frame').hidden = mode !== 'crop-vertical';
    if (mode === 'crop-vertical') requestAnimationFrame(() => patchCrop(session, mounted.video));
  }

  function isShortcutTarget(target) {
    return target instanceof Element && Boolean(target.closest('input, textarea, select, button, [contenteditable="true"], [role="combobox"], [role="listbox"]'));
  }

  function keyboardHandler(event) {
    if (!mounted || isShortcutTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
    const { video, session } = mounted;
    const key = event.key.toLowerCase();
    const current = video && video.readyState >= 1 ? video.currentTime : session.currentTime;
    const seekTo = (next) => {
      const clamped = Math.max(0, Math.min(session.duration || Infinity, next));
      session.currentTime = clamped;
      if (video && video.readyState >= 1) video.currentTime = clamped;
      patchTimeline(session, video);
    };
    if (event.key === ' ') { event.preventDefault(); video.paused ? video.play().catch(() => {}) : video.pause(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); seekTo(current - 5); }
    else if (event.key === 'ArrowRight') { event.preventDefault(); seekTo(current + 5); }
    else if (key === 'i') { event.preventDefault(); session.inPoint = Math.min(current, session.outPoint - .1); patchTimeline(session, video); }
    else if (key === 'o') { event.preventDefault(); session.outPoint = Math.max(current, session.inPoint + .1); patchTimeline(session, video); }
    else if (key === 'm') { event.preventDefault(); addNote(session, video); }
  }

  function pointerTime(event, timeline, duration) {
    const rect = timeline.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (event.clientX - rect.left) / Math.max(1, rect.width) * duration));
  }

  async function loadMedia(asset, session, context, video) {
    const loading = document.querySelector('#studio-loading');
    const errorBox = document.querySelector('#studio-video-error');
    session.loading = true;
    session.error = '';
    session.decodeError = false;
    loading.hidden = false;
    errorBox.hidden = true;
    try {
      const [path, subtitles] = await Promise.all([
        context.invoke('get_media_path', { assetType: asset.assetType, assetId: asset.assetId }),
        context.invoke('get_media_subtitles', { assetType: asset.assetType, assetId: asset.assetId }).catch(() => []),
      ]);
      if (!mounted || mounted.asset !== asset) return;
      session.path = path;
      session.subtitles = subtitles;
      video.querySelectorAll('track').forEach((track) => track.remove());
      for (const [index, item] of subtitles.entries()) {
        const track = document.createElement('track');
        track.kind = 'subtitles'; track.label = item.label; track.srclang = item.language;
        track.src = globalThis.__TAURI__?.core?.convertFileSrc ? globalThis.__TAURI__.core.convertFileSrc(item.path) : item.path;
        track.default = index === 0;
        video.appendChild(track);
      }
      video.src = globalThis.__TAURI__?.core?.convertFileSrc ? globalThis.__TAURI__.core.convertFileSrc(path) : path;
      video.load();
    } catch (error) {
      if (!mounted || mounted.asset !== asset) return;
      session.loading = false;
      session.error = context.readableError(error);
      loading.hidden = true;
      errorBox.hidden = false;
      errorBox.querySelector('p').textContent = session.error;
    }
  }

  function teardown() {
    if (!mounted) return;
    document.removeEventListener('keydown', keyboardHandler);
    window.removeEventListener('resize', mounted.resizeHandler);
    mounted.video.pause();
    window.ClipCargoWorkspace.ui.studio.dragging = null;
    mounted = null;
  }

  function mount(context) {
    teardown();
    const asset = activeAsset(context.state);
    const video = document.querySelector('#studio-video');
    if (!asset || !video) return;
    const session = window.ClipCargoWorkspace.ensureStudioSession(asset);
    const root = document.querySelector('.studio-view');
    const resizeHandler = () => patchCrop(session, video);
    mounted = { context, asset, session, video, root, resizeHandler };
    window.ClipCargoWorkspace.ui.studio.mountedKey = `${asset.assetType}:${asset.assetId}`;
    document.addEventListener('keydown', keyboardHandler);
    window.addEventListener('resize', resizeHandler);
    video.playbackRate = session.playbackRate;
    video.addEventListener('loadedmetadata', () => {
      session.loading = false;
      session.decodeError = false;
      session.duration = Number.isFinite(video.duration) ? video.duration : Number(asset.durationSeconds || 0);
      if (!session.outPoint || session.outPoint > session.duration) session.outPoint = session.duration;
      const pending = window.ClipCargoWorkspace.ui.studio.pendingSeek;
      video.currentTime = pending == null ? Math.min(session.currentTime || 0, Math.max(0, session.duration - .1)) : Math.min(pending, session.duration);
      window.ClipCargoWorkspace.ui.studio.pendingSeek = null;
      document.querySelector('#studio-loading').hidden = true;
      patchTimeline(session, video);
      patchCrop(session, video);
    });
    video.addEventListener('error', () => {
      session.loading = false; session.decodeError = true;
      document.querySelector('#studio-loading').hidden = true;
      const box = document.querySelector('#studio-video-error');
      box.hidden = false;
      box.querySelector('p').textContent = asset.assetType === 'original' ? '当前编码无法在内置播放器中解码，可生成兼容副本或使用系统播放器。' : '当前编码无法在内置播放器中解码，请使用系统播放器。';
      patchTimeline(session, video);
      patchCrop(session, video);
    });
    video.addEventListener('timeupdate', () => {
      patchTimeline(session, video);
      if (Date.now() - positionSavedAt > 2000) {
        positionSavedAt = Date.now();
        localStorage.setItem(`clipcargo:studio-position:${asset.assetType}:${asset.assetId}`, String(video.currentTime));
      }
    });
    video.addEventListener('play', () => { document.querySelector('[data-studio-play]').innerHTML = context.helpers.icon('pause'); });
    video.addEventListener('pause', () => { document.querySelector('[data-studio-play]').innerHTML = context.helpers.icon('play'); });

    root.addEventListener('click', async (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.hasAttribute('data-studio-play')) video.paused ? video.play().catch(() => {}) : video.pause();
      else if (button.dataset.studioMode) setMode(session, button.dataset.studioMode);
      else if (button.hasAttribute('data-note-add')) addNote(session, video);
      else if (button.dataset.noteSeek) { const note = session.notes.find((entry) => entry.id === button.dataset.noteSeek); if (note) video.currentTime = note.time; }
      else if (button.dataset.noteDelete) { session.notes = session.notes.filter((entry) => entry.id !== button.dataset.noteDelete); renderNotes(session); }
      else if (button.hasAttribute('data-studio-external')) {
        try { await context.invoke('open_media_external', { assetType: asset.assetType, assetId: asset.assetId }); }
        catch (error) { context.notify(context.readableError(error)); }
      } else if (button.hasAttribute('data-studio-compatible')) {
        await submitProcessing(context, asset, session, 'convert');
      } else if (button.hasAttribute('data-studio-settings')) context.openSettings();
      else if (button.id === 'studio-process-submit') await submitProcessing(context, asset, session, session.mode);
    });
    root.addEventListener('input', (event) => {
      if (event.target.id === 'studio-rate') { session.playbackRate = Number(event.target.value); video.playbackRate = session.playbackRate; }
      else if (event.target.id === 'studio-auto-import') session.autoImport = event.target.checked;
      else if (event.target.dataset.noteText) { const note = session.notes.find((entry) => entry.id === event.target.dataset.noteText); if (note) note.text = event.target.value; }
      else if (event.target.id === 'studio-crop-x') { session.cropX = Number(event.target.value); patchCrop(session, video); }
      else if (event.target.id === 'studio-crop-y') { session.cropY = Number(event.target.value); patchCrop(session, video); }
      else if (event.target.id === 'studio-crop-zoom') { session.cropZoom = Number(event.target.value); patchCrop(session, video); }
    });
    root.addEventListener('change', (event) => {
      if (event.target.id === 'studio-rate') { session.playbackRate = Number(event.target.value); video.playbackRate = session.playbackRate; }
      else if (event.target.id === 'studio-auto-import') session.autoImport = event.target.checked;
    });
    root.querySelector('#studio-asset-select').addEventListener('change', (event) => context.openAsset(event.target.value));

    const timeline = root.querySelector('#studio-timeline');
    timeline.addEventListener('pointerdown', (event) => {
      const handle = event.target.closest('[data-timeline-handle]')?.dataset.timelineHandle || 'playhead';
      timelineDrag = { handle, pointerId: event.pointerId };
      window.ClipCargoWorkspace.ui.studio.dragging = 'timeline';
      timeline.setPointerCapture(event.pointerId);
      const time = pointerTime(event, timeline, session.duration);
      if (handle === 'in') session.inPoint = Math.min(time, session.outPoint - .1);
      else if (handle === 'out') session.outPoint = Math.max(time, session.inPoint + .1);
      else { session.currentTime = time; if (video.readyState >= 1) video.currentTime = time; }
      patchTimeline(session, video);
      event.preventDefault();
    });
    timeline.addEventListener('pointermove', (event) => {
      if (!timelineDrag || timelineDrag.pointerId !== event.pointerId) return;
      const time = pointerTime(event, timeline, session.duration);
      if (timelineDrag.handle === 'in') session.inPoint = Math.min(time, session.outPoint - .1);
      else if (timelineDrag.handle === 'out') session.outPoint = Math.max(time, session.inPoint + .1);
      else { session.currentTime = time; if (video.readyState >= 1) video.currentTime = time; }
      patchTimeline(session, video);
    });
    const endTimelineDrag = () => { timelineDrag = null; window.ClipCargoWorkspace.ui.studio.dragging = null; };
    timeline.addEventListener('pointerup', endTimelineDrag);
    timeline.addEventListener('pointercancel', endTimelineDrag);

    const frame = root.querySelector('#studio-crop-frame');
    frame.addEventListener('pointerdown', (event) => {
      cropDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: session.cropX, y: session.cropY };
      window.ClipCargoWorkspace.ui.studio.dragging = 'crop';
      frame.setPointerCapture(event.pointerId); event.preventDefault();
    });
    frame.addEventListener('pointermove', (event) => {
      if (!cropDrag || cropDrag.pointerId !== event.pointerId) return;
      const rect = videoContentRect(video);
      const frameRect = frame.getBoundingClientRect();
      session.cropX = Math.max(0, Math.min(100, cropDrag.x + (event.clientX - cropDrag.startX) / Math.max(1, rect.width - frameRect.width) * 100));
      session.cropY = Math.max(0, Math.min(100, cropDrag.y + (event.clientY - cropDrag.startY) / Math.max(1, rect.height - frameRect.height) * 100));
      patchCrop(session, video);
    });
    const endCropDrag = () => { cropDrag = null; window.ClipCargoWorkspace.ui.studio.dragging = null; };
    frame.addEventListener('pointerup', endCropDrag);
    frame.addEventListener('pointercancel', endCropDrag);
    patchTimeline(session, video);
    patchCrop(session, video);
    loadMedia(asset, session, context, video);
  }

  async function submitProcessing(context, asset, session, overrideMode = null) {
    const mode = overrideMode || session.mode;
    const error = document.querySelector('#studio-process-error');
    const submit = document.querySelector('#studio-process-submit');
    const jobId = asset.assetType === 'original' ? asset.assetId : asset.parentJobId;
    if (!jobId) { error.textContent = '找不到对应的素材包主文件。'; return; }
    if (mode === 'clip' && (!(session.outPoint > session.inPoint) || session.outPoint - session.inPoint < .1)) { error.textContent = '出点必须晚于入点至少 0.1 秒。'; return; }
    error.textContent = '';
    if (submit) { submit.disabled = true; submit.setAttribute('aria-busy', 'true'); submit.textContent = '正在创建任务…'; }
    try {
      const result = await context.invoke('process_media', { input: {
        jobId,
        mode,
        startSeconds: mode === 'clip' ? session.inPoint : null,
        endSeconds: mode === 'clip' ? session.outPoint : null,
        cropPositionX: mode === 'crop-vertical' ? session.cropX / 100 : null,
        cropPositionY: mode === 'crop-vertical' ? session.cropY / 100 : null,
        cropScale: mode === 'crop-vertical' ? session.cropZoom / 100 : null,
      } });
      if (!['queued', 'processing'].includes(result.status)) throw new Error(result.errorMessage || '处理任务未能启动。');
      if (session.autoImport && context.state.editor && result.id) window.ClipCargoWorkspace.ui.studio.pendingAutoImports.set(result.id, { editorId: context.state.editor.id, attempted: false });
      await context.refresh({ quiet: true });
      context.notify(session.autoImport && context.state.editor ? `处理任务已创建，完成后将自动导入 ${context.state.editor.name}` : '处理任务已加入任务队列');
    } catch (caught) {
      error.textContent = context.readableError(caught);
    } finally {
      if (submit) { submit.disabled = context.state.components?.ffmpegReady === false; submit.removeAttribute('aria-busy'); submit.innerHTML = `${context.helpers.icon('refresh-cw')}创建处理任务`; }
    }
  }

  async function processPendingImports(context) {
    const pending = window.ClipCargoWorkspace.ui.studio.pendingAutoImports;
    for (const [derivativeId, item] of pending) {
      const derivative = context.state.derivatives.find((entry) => entry.id === derivativeId);
      if (!derivative || derivative.status !== 'completed' || item.attempted) continue;
      item.attempted = true;
      try {
        const result = await context.invoke('import_media_to_editor', { editorId: item.editorId, assetType: 'derivative', assetId: derivativeId });
        context.notify(`处理完成，已导入${result.editorName}`);
      } catch (error) {
        context.notify(`处理已完成；自动导入失败：${context.readableError(error)}`);
      } finally { pending.delete(derivativeId); }
    }
  }

  window.ClipCargoViews = window.ClipCargoViews || {};
  window.ClipCargoViews.studio = { render, mount, teardown, assets, activeAsset, processPendingImports, formatClock };
})();
