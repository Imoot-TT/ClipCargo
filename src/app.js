const invoke = window.__TAURI__?.core?.invoke;
const openNativeFileDialog = window.__TAURI__?.dialog?.open;
const mediaFileFilters = [{
  name: '媒体文件',
  extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mp3', 'm4a', 'wav', 'flac'],
}];

async function chooseMediaFiles(multiple) {
  if (typeof openNativeFileDialog !== 'function') throw new Error('系统文件选择器不可用，请重新安装完整版本。');
  const selection = await openNativeFileDialog({ multiple, directory: false, filters: mediaFileFilters });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

async function chooseDownloadDirectory() {
  if (typeof openNativeFileDialog !== 'function') throw new Error('系统文件夹选择器不可用，请重新安装完整版本。');
  return openNativeFileDialog({ multiple: false, directory: true, defaultPath: state.components?.downloadsDirectory || undefined });
}

async function chooseComponentsDirectory() {
  if (typeof openNativeFileDialog !== 'function') throw new Error('系统文件夹选择器不可用，请重新安装完整版本。');
  return openNativeFileDialog({ multiple: false, directory: true, defaultPath: state.components?.componentDirectory || undefined });
}

const DEVELOPMENT_EXTENSION_ID = 'dpogajmenckmdbpacaoilnhhdcjpbheb';
const STORE_EXTENSION_ID = 'maenmnckhgckmkcaijmpeghkcfhchiha';

function setButtonBusy(button, label) {
  if (!(button instanceof HTMLButtonElement)) return;
  button.dataset.busyOriginal = button.innerHTML;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.innerHTML = `${icon('refresh-cw')}${escapeHtml(label)}`;
}

function clearButtonBusy(button) {
  if (!(button instanceof HTMLButtonElement)) return;
  button.disabled = false;
  button.removeAttribute('aria-busy');
  if (button.dataset.busyOriginal) {
    button.innerHTML = button.dataset.busyOriginal;
    delete button.dataset.busyOriginal;
  }
}
const main = document.querySelector('#main');
const count = document.querySelector('#inbox-count');
const taskCount = document.querySelector('#task-count');
const backdrop = document.querySelector('#dialog-backdrop');
const urlInput = document.querySelector('#url-input');
const urlSummary = document.querySelector('#url-summary');
const formError = document.querySelector('#form-error');
const projectInput = document.querySelector('#project-input');
const projectCombobox = document.querySelector('#project-combobox');
const projectToggle = document.querySelector('#project-toggle');
const projectSuggestionList = document.querySelector('#project-options');
const importButton = document.querySelector('#import-button');
const dialogClose = document.querySelector('#dialog-close');
const dialogCancel = document.querySelector('#dialog-cancel');
const projectBackdrop = document.querySelector('#project-backdrop');
const projectList = document.querySelector('#project-list');
const projectError = document.querySelector('#project-error');
const newProjectName = document.querySelector('#new-project-name');
const toast = document.querySelector('#toast');
const playerBackdrop = document.querySelector('#player-backdrop');
const mediaPlayer = document.querySelector('#media-player');
const playerTitle = document.querySelector('#player-title');
const playerStatus = document.querySelector('#player-status');
const playerError = document.querySelector('#player-error');
const playerConvert = document.querySelector('#player-convert');
let activePlayerAsset = null;
let playerPositionKey = '';
let lastPositionSavedAt = 0;
const processBackdrop = document.querySelector('#process-backdrop');
const processMode = document.querySelector('#process-mode');
const processError = document.querySelector('#process-error');
const cropEditor = document.querySelector('#crop-editor');
const cropPreview = document.querySelector('#crop-preview');
const cropMask = document.querySelector('#crop-mask');
const cropX = document.querySelector('#crop-x');
const cropY = document.querySelector('#crop-y');
const cropZoom = document.querySelector('#crop-zoom');
const cropStatus = document.querySelector('#crop-status');
let activeProcessJobId = null;
let cropDragging = null;
const downloadBackdrop = document.querySelector('#download-backdrop');
const downloadQuality = document.querySelector('#download-quality');
const downloadPreset = document.querySelector('#download-preset');
const downloadSubtitles = document.querySelector('#download-subtitles');
const downloadSubtitleOptions = document.querySelector('#download-subtitle-options');
const downloadRetainSource = document.querySelector('#download-retain-source');
const downloadCover = document.querySelector('#download-cover');
const downloadSourceRecord = document.querySelector('#download-source-record');
const downloadSummary = document.querySelector('#download-summary');
const downloadExceptions = document.querySelector('#download-exceptions');
const downloadError = document.querySelector('#download-error');
const inboxDetailBackdrop = document.querySelector('#inbox-detail-backdrop');
const inboxDetailName = document.querySelector('#inbox-detail-name');
const inboxDetailProject = document.querySelector('#inbox-detail-project');
const inboxDetailMeta = document.querySelector('#inbox-detail-meta');
const inboxDetailError = document.querySelector('#inbox-detail-error');
const batchMoveBackdrop = document.querySelector('#batch-move-backdrop');
const batchMoveProject = document.querySelector('#batch-move-project');
const batchMoveError = document.querySelector('#batch-move-error');
const mediaEditBackdrop = document.querySelector('#media-edit-backdrop');
const mediaEditName = document.querySelector('#media-edit-name');
const mediaEditProject = document.querySelector('#media-edit-project');
const mediaEditError = document.querySelector('#media-edit-error');
const localImportBackdrop = document.querySelector('#local-import-backdrop');
const localImportProject = document.querySelector('#local-import-project');
const localImportSummary = document.querySelector('#local-import-summary');
const localImportError = document.querySelector('#local-import-error');
const componentInstallBackdrop = document.querySelector('#component-install-backdrop');
const componentInstallTitle = document.querySelector('#component-install-title');
const componentInstallPurpose = document.querySelector('#component-install-purpose');
const componentInstallDownload = document.querySelector('#component-install-download');
const componentInstallSize = document.querySelector('#component-install-size');
const componentInstallSource = document.querySelector('#component-install-source');
const componentInstallPath = document.querySelector('#component-install-path');
const componentInstallError = document.querySelector('#component-install-error');
const componentInstallConfirm = document.querySelector('#component-install-confirm');
const componentInstallCancel = document.querySelector('#component-install-cancel');
const componentInstallClose = document.querySelector('#component-install-close');
const dropOverlay = document.querySelector('#drop-overlay');
let activeDownloadItemIds = [];
let activeInboxDetailId = null;
const selectedInboxItems = new Set();
const persistedTaskErrorCodes = new Map();
let activeMediaEdit = null;
let pendingLocalImportPaths = [];
let pendingComponentInstall = null;
let componentCancelRequested = false;
let activeComponentInstallKind = null;
let componentInstallFailure = '';
let modalReturnFocus = null;
let linkImportInProgress = false;
let customSelectSequence = 0;

const defaultPreferences = { theme: 'system', downloadPreset: 'package', downloadQuality: '1080', saveSubtitles: true, defaultProject: '未分类', downloadConcurrency: 2 };
function loadPreferences() {
  try {
    const stored = JSON.parse(localStorage.getItem('clipcargo:preferences') || '{}');
    return {
      theme: ['system', 'light', 'dark'].includes(stored.theme) ? stored.theme : defaultPreferences.theme,
      downloadPreset: ['package', 'source', 'video', 'audio'].includes(stored.downloadPreset) ? stored.downloadPreset : defaultPreferences.downloadPreset,
      downloadQuality: ['1080', '720', 'best'].includes(stored.downloadQuality) ? stored.downloadQuality : defaultPreferences.downloadQuality,
      saveSubtitles: stored.saveSubtitles === undefined ? defaultPreferences.saveSubtitles : Boolean(stored.saveSubtitles),
      defaultProject: typeof stored.defaultProject === 'string' && stored.defaultProject.trim() ? stored.defaultProject.trim().slice(0, 50) : defaultPreferences.defaultProject,
      downloadConcurrency: [1, 2, 3, 4].includes(Number(stored.downloadConcurrency)) ? Number(stored.downloadConcurrency) : defaultPreferences.downloadConcurrency,
    };
  } catch { return { ...defaultPreferences }; }
}
let preferences = loadPreferences();
function savePreferences() {
  localStorage.setItem('clipcargo:preferences', JSON.stringify(preferences));
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.style.colorScheme = preferences.theme === 'system' ? 'light dark' : preferences.theme;
}
savePreferences();

const savedView = localStorage.getItem('clipcargo:last-view');
const state = { view: ['inbox', 'tasks', 'library', 'browser'].includes(savedView) ? savedView : 'inbox', items: [], jobs: [], derivatives: [], projects: [{ name: '未分类', isSystem: true, itemCount: 0 }], filter: 'all', projectFilter: 'all', inboxPage: 1, taskFilter: 'active', taskPage: 1, libraryView: 'projects', librarySourceJob: null, libraryQuery: '', librarySort: 'newest', libraryProject: 'all', libraryKind: 'all', libraryPage: 1, editor: null, bridge: null, components: null, authConfigured: false, authBrowser: null, authLoginOpen: false, authRetryJobId: null, bridgeChecking: false, loading: true, editingProject: null, pendingProjectDelete: null, pendingLibraryRemoval: null, pendingLibraryImpact: null, pendingInboxRemoval: null, pendingBatchRemoval: false, pendingComponentRemoval: null, relinkTarget: null };
let toastTimer;
let librarySearchTimer;
let projectActiveIndex = -1;

const INBOX_PAGE_SIZE = 50;
const TASK_PAGE_SIZE = 50;
const LIBRARY_PAGE_SIZE = 48;

function preferredProject() {
  return state.projects.some((project) => project.name === preferences.defaultProject) ? preferences.defaultProject : '未分类';
}

function canonicalProjectName(rawName) {
  const trimmed = String(rawName || '').trim().slice(0, 50);
  if (!trimmed) return '未分类';
  return state.projects.find((project) => project.name.localeCompare(trimmed, 'zh-CN', { sensitivity: 'accent' }) === 0)?.name || trimmed;
}

function projectSuggestions(query = projectInput.value) {
  const normalizedQuery = String(query || '').trim().toLocaleLowerCase('zh-CN');
  return state.projects.filter((project) => !normalizedQuery || project.name.toLocaleLowerCase('zh-CN').includes(normalizedQuery));
}

function renderProjectSuggestions(query = projectInput.value) {
  const suggestions = projectSuggestions(query);
  const selectedName = canonicalProjectName(projectInput.value);
  projectActiveIndex = -1;
  projectSuggestionList.innerHTML = suggestions.length
    ? suggestions.map((project, index) => `<button id="project-option-${index}" class="project-option${project.name === selectedName ? ' selected' : ''}" type="button" role="option" aria-selected="${project.name === selectedName}" data-project-name="${escapeHtml(project.name)}"><span class="project-option-main"><strong>${escapeHtml(project.name)}</strong><small>${project.itemCount || 0} 条内容${project.isSystem ? ' · 系统项目' : ''}</small></span><span class="project-option-check">${project.name === selectedName ? icon('circle-check') : ''}</span></button>`).join('')
    : '<div class="project-options-empty"><strong>没有匹配的项目</strong><span>可以直接输入新项目名称</span></div>';
}

function closeProjectSuggestions() {
  projectCombobox.classList.remove('open');
  projectSuggestionList.hidden = true;
  projectInput.setAttribute('aria-expanded', 'false');
  projectInput.removeAttribute('aria-activedescendant');
  projectActiveIndex = -1;
}

function openProjectSuggestions() {
  if (projectInput.disabled) return;
  renderProjectSuggestions();
  projectSuggestionList.hidden = false;
  projectCombobox.classList.add('open');
  projectInput.setAttribute('aria-expanded', 'true');
}

function chooseProjectSuggestion(name) {
  projectInput.value = canonicalProjectName(name);
  updateLinkSummary();
  closeProjectSuggestions();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[character]));
}

function readableError(error) {
  if (error instanceof Error && error.message) return error.message;
  const message = String(error ?? '未知错误');
  return message.replace(/^Error:\s*/i, '');
}

function classifyTaskError(message, kind = 'download', persistedCode = '', context = null) {
  const text = String(message || '').toLocaleLowerCase('zh-CN');
  persistedCode ||= persistedTaskErrorCodes.get(String(message || '')) || '';
  const rules = [
    { code: 'DISK_FULL', match: ['磁盘空间不足', 'disk full', 'no space left'], action: '清理 ClipCargo 所在磁盘空间后重试。' },
    { code: 'RATE_LIMITED', match: ['限制请求', '限流', 'rate limit', 'too many requests', 'http error 429'], action: '稍后再试，并降低同时下载数量。' },
    { code: 'AUTH_REQUIRED', match: ['登录', '授权', 'cookie', 'sign in'], action: '在“登录受限内容”中启用失败重试，再按原参数重新尝试。' },
    { code: 'SOURCE_GONE', match: ['已删除', '不可访问', '设为私密', 'not available', 'unavailable'], action: '打开来源确认内容是否仍然可用。' },
    { code: 'UNSUPPORTED_SOURCE', match: ['当前不支持', '没有找到可下载', 'no video formats', 'unsupported'], action: '保留链接并检查是否复制了完整分享地址。' },
    { code: 'NETWORK_UNREACHABLE', match: ['网络', '连接中断', '超时', 'timed out', 'connection reset'], action: '检查网络和系统代理，恢复后重试。' },
    { code: 'PERMISSION_DENIED', match: ['权限', '拒绝访问', 'permission denied', 'access is denied', '被占用'], action: '关闭占用文件的程序，或选择可写目录。' },
    { code: 'COMPONENT_MISSING', match: ['缺少', '尚未安装', '找不到 ffmpeg', '找不到 yt-dlp'], action: '前往设置安装完成当前操作所需的工具。' },
    { code: 'OUTPUT_INVALID', match: ['校验未通过', '没有可识别', '零字节', '时长偏差'], action: '保留原片，改用兼容预设重新处理。' },
    { code: 'CANCELLED_BY_USER', match: ['已停止', '已取消', '取消。'], action: '需要时可按原参数重新创建任务。' },
  ];
  const persisted = rules.find((rule) => rule.code === persistedCode);
  if (persisted) return persisted;
  const found = rules.find((rule) => rule.match.some((fragment) => text.includes(fragment)));
  if (found) return found;
  return kind === 'processing'
    ? { code: 'PROCESS_FAILED', action: '检查原片是否仍可读取，再按原参数重试。' }
    : context?.outputPreset === 'video'
      ? { code: 'PROCESS_FAILED', action: '当前已经是兼容 MP4，不是格式选择错误。请先确认来源网页仍可播放；若网站明确要求登录，再启用登录失败重试。' }
      : { code: 'PROCESS_FAILED', action: '确认来源网页仍可播放后重试；需要通用 MP4 时可选择兼容 MP4。' };
}

function taskErrorMarkup(message, kind = 'download', persistedCode = '', context = null) {
  if (!message) return '';
  const error = classifyTaskError(message, kind, persistedCode, context);
  const cancelled = error.code === 'CANCELLED_BY_USER';
  const labels = {
    DISK_FULL: '磁盘空间不足，任务已停止。',
    RATE_LIMITED: '网站暂时限制了下载请求。',
    AUTH_REQUIRED: '该网站需要登录后才能访问这个视频。',
    SOURCE_GONE: '来源内容已失效或无法访问。',
    UNSUPPORTED_SOURCE: '暂未识别到可下载的视频。',
    NETWORK_UNREACHABLE: '网络连接失败。',
    PERMISSION_DENIED: '文件被占用或保存位置不可写。',
    COMPONENT_MISSING: '缺少完成此操作所需的工具。',
    OUTPUT_INVALID: '下载结果未通过完整性检查。',
    CANCELLED_BY_USER: '任务已停止。',
    PROCESS_FAILED: kind === 'processing' ? '视频处理未完成。' : '下载未完成。',
  };
  const userMessage = labels[error.code] || (kind === 'processing' ? '视频处理未完成。' : '下载未完成。');
  return `<details class="task-error${cancelled ? ' task-cancelled' : ''}"><summary title="${escapeHtml(userMessage)}">${escapeHtml(userMessage)}</summary><div class="task-error-detail">${escapeHtml(error.action)}</div></details>`;
}

function taskRecoveryButton(item, kind = 'download') {
  const code = classifyTaskError(item.errorMessage, kind, item.errorCode).code;
  if (code === 'AUTH_REQUIRED') return `<button class="button compact" data-action="open-settings-section" data-settings-target="auth-settings" data-auth-job-id="${item.id}">${icon('key-round')}登录后重试</button>`;
  if (code === 'COMPONENT_MISSING') return `<button class="button compact" data-action="open-settings-section" data-settings-target="components-settings">${icon('download')}安装所需工具</button>`;
  return '';
}

function userCancelled(item) {
  return item?.errorCode === 'CANCELLED_BY_USER'
    || (item?.status === 'failed' && classifyTaskError(item.errorMessage, item.kind ? 'processing' : 'download').code === 'CANCELLED_BY_USER');
}

function notify(message, duration = 5000) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.hidden = true; }, duration);
}

function icon(name, className = 'ui-icon') {
  return `<span class="${className}" style="--icon: url('./assets/icons/${name}.svg')" aria-hidden="true"></span>`;
}

function closeCustomSelects(except = null) {
  document.querySelectorAll('.custom-select.open').forEach((wrapper) => {
    if (wrapper === except) return;
    wrapper.classList.remove('open');
    wrapper.querySelector('.custom-select-trigger')?.setAttribute('aria-expanded', 'false');
  });
}

function closeActionMenus(except = null) {
  document.querySelectorAll('details.media-more[open]').forEach((menu) => {
    if (menu !== except) menu.open = false;
  });
}

function enhanceSelects(root = document) {
  root.querySelectorAll('.custom-select').forEach((wrapper) => {
    const select = wrapper.querySelector('select');
    if (!select) return;
    wrapper.before(select);
    select.classList.remove('native-select');
    select.removeAttribute('aria-hidden');
    select.removeAttribute('tabindex');
    select.hidden = false;
    wrapper.remove();
  });
  root.querySelectorAll('select').forEach((select) => {
    if (select.dataset.customSelect === 'false') return;
    const wrapper = document.createElement('div');
    wrapper.className = `custom-select${select.classList.contains('compact-select') ? ' compact-select' : ''}`;
    select.before(wrapper);
    wrapper.append(select);
    select.classList.add('native-select');
    select.hidden = true;
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'custom-select-trigger';
    trigger.setAttribute('role', 'combobox');
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent?.trim() || '选择');
    trigger.innerHTML = `<span class="custom-select-value"></span>${icon('chevron-right', 'ui-icon custom-select-chevron')}`;

    const menu = document.createElement('div');
    menu.className = 'custom-select-menu';
    menu.id = `${select.id || `custom-select-${customSelectSequence++}`}-menu`;
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', select.getAttribute('aria-label') || select.closest('label')?.childNodes[0]?.textContent?.trim() || '选项');
    trigger.setAttribute('aria-controls', menu.id);
    const options = [...select.options];
    const sync = () => {
      const selected = select.selectedOptions[0];
      trigger.querySelector('.custom-select-value').textContent = selected?.textContent || '';
      trigger.disabled = select.disabled;
      menu.querySelectorAll('.custom-select-option').forEach((item) => {
        const active = item.dataset.value === select.value;
        item.classList.toggle('selected', active);
        item.setAttribute('aria-selected', String(active));
      });
    };
    const choose = (value) => {
      select.value = value;
      sync();
      select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    options.forEach((option) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'custom-select-option';
      item.dataset.value = option.value;
      item.textContent = option.textContent;
      item.setAttribute('role', 'option');
      item.disabled = option.disabled;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        choose(option.value);
        closeCustomSelects();
        trigger.focus();
      });
      menu.append(item);
    });
    const open = () => {
      closeCustomSelects(wrapper);
      wrapper.classList.add('open');
      trigger.setAttribute('aria-expanded', 'true');
      menu.querySelector('.selected')?.focus({ preventScroll: true });
    };
    trigger.addEventListener('click', (event) => {
      event.stopPropagation();
      if (wrapper.classList.contains('open')) closeCustomSelects(); else open();
    });
    trigger.addEventListener('keydown', (event) => {
      if (['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault();
        open();
      }
    });
    menu.addEventListener('keydown', (event) => {
      const items = [...menu.querySelectorAll('.custom-select-option:not(:disabled)')];
      const current = Math.max(0, items.indexOf(document.activeElement));
      let next = current;
      if (event.key === 'ArrowDown') next = (current + 1) % items.length;
      else if (event.key === 'ArrowUp') next = (current - 1 + items.length) % items.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = items.length - 1;
      else if (event.key === 'Escape') { event.preventDefault(); closeCustomSelects(); trigger.focus(); return; }
      else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); document.activeElement?.click(); return; }
      else if (event.key === 'Tab') { closeCustomSelects(); return; }
      else return;
      event.preventDefault();
      items[next]?.focus();
    });
    wrapper.append(trigger, menu);
    sync();
  });
}

function pagination(scope, page, pageCount, total) {
  if (pageCount <= 1) return '';
  const label = scope === 'inbox' ? '收集箱' : scope === 'tasks' ? '任务' : '素材库';
  return `<nav class="pagination" aria-label="${label}分页"><button class="button compact" data-page-scope="${scope}" data-page-direction="previous" ${page <= 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} / ${pageCount} 页 · 共 ${total} 项</span><button class="button compact" data-page-scope="${scope}" data-page-direction="next" ${page >= pageCount ? 'disabled' : ''}>下一页</button></nav>`;
}

function formatTime(seconds) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .format(new Date(seconds * 1000));
  } catch { return ''; }
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return `${minutes}:${rest}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知';
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GiB`;
  return `${Math.round(bytes / 1_048_576)} MiB`;
}

function compactComponentVersion(value) {
  const match = String(value || '').match(/\b(\d+(?:\.\d+){1,3})\b/);
  return match ? match[1] : '已安装';
}

function statusLabel(status) {
  return ({ captured: '待识别', waiting_component: '等待安装', resolving: '识别中', ready: '已识别', failed: '识别失败' })[status] || status;
}

function jobLabel(status) {
  return ({ queued: '排队中', downloading: '下载中', paused: '已暂停', completed: '已完成', failed: '下载失败' })[status] || status;
}

function inboxDisplayStatus(item, job) {
  if (item.status === 'ready' && job) return { status: job.status, label: jobLabel(job.status) };
  return { status: item.status, label: statusLabel(item.status) };
}

function downloadStageLabel(stage) {
  return ({ queued: '等待开始', downloading: '正在下载', processing: '正在转换', verifying: '正在校验', archiving: '正在归档', paused: '已暂停', completed: '已完成', failed: '已停止' })[stage] || '正在下载';
}

function formatTransferRate(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) return '';
  if (bytesPerSecond >= 1_048_576) return `${(bytesPerSecond / 1_048_576).toFixed(1)} MiB/s`;
  if (bytesPerSecond >= 1024) return `${Math.round(bytesPerSecond / 1024)} KiB/s`;
  return `${Math.round(bytesPerSecond)} B/s`;
}

function downloadProgressDetail(item) {
  const bytes = Number.isFinite(item.downloadedBytes)
    ? `${formatBytes(item.downloadedBytes)}${Number.isFinite(item.totalBytes) ? ` / ${formatBytes(item.totalBytes)}` : ''}`
    : '';
  const rate = formatTransferRate(item.speedBytesPerSecond);
  const eta = Number.isFinite(item.etaSeconds) ? `剩余约 ${formatDuration(item.etaSeconds)}` : '';
  const left = [downloadStageLabel(item.stage), `${Math.round(item.progressPercent || 0)}%`, bytes].filter(Boolean).join(' · ');
  const right = [rate, eta].filter(Boolean).join(' · ');
  return `<div class="progress-label"><span>${escapeHtml(left)}</span>${right ? `<span>${escapeHtml(right)}</span>` : ''}</div>`;
}

function derivativeKind(kind) {
  return ({ convert: '兼容 MP4', clip: '片段', audio: 'MP3 音频', 'crop-vertical': '9:16 竖屏', 'rotate-left': '左转 90°', 'rotate-right': '右转 90°', mute: '无声视频', 'speed-2x': '2 倍速', compress: '压缩副本', source: '下载源文件' })[kind] || kind;
}

function qualityLabel(quality) {
  if (/^\d{3,4}$/.test(String(quality))) return `${quality}p`;
  return ({ best: '最佳可用', audio: 'MP3 音频', local: '本地导入' })[quality] || '最佳可用';
}

function outputPresetLabel(preset) {
  return ({ package: '完整素材包', source: '保留来源格式', video: '兼容 MP4', audio: 'MP3 音频' })[preset] || '兼容 MP4';
}

function queuePosition(items, id) {
  const index = items.filter((item) => item.status === 'queued').map((item) => item.id).sort((a, b) => a - b).indexOf(id);
  return index < 0 ? '' : ` · 队列第 ${index + 1} 位`;
}

function safeThumbnail(url) {
  if (typeof url !== 'string' || !url.trim()) return '';
  if (/^data:image\/(?:jpeg|png|webp|avif);base64,/i.test(url)) return url;
  if (/^https:\/\//i.test(url)) return url;
  if (/^http:\/\//i.test(url)) return url.replace(/^http:/i, 'https:');
  if (/^(?:[a-z]:[\\/]|\\\\)/i.test(url) && typeof window.__TAURI__?.core?.convertFileSrc === 'function') {
    return window.__TAURI__.core.convertFileSrc(url);
  }
  return '';
}

function inboxErrorLabel(message, persistedCode = '') {
  if (!message) return '';
  const error = classifyTaskError(message, 'download', persistedCode);
  const labels = {
    AUTH_REQUIRED: '需要登录后访问；当前浏览器会话不可用。',
    RATE_LIMITED: '网站暂时限制请求，请稍后重试。',
    SOURCE_GONE: '来源内容已失效或无法访问。',
    UNSUPPORTED_SOURCE: '暂未识别到可下载的视频。',
    NETWORK_UNREACHABLE: '网络连接失败，请检查网络后重试。',
    PERMISSION_DENIED: '文件被占用或保存位置不可写。',
    COMPONENT_MISSING: '缺少完成此操作所需的工具。',
  };
  return labels[error.code] || '识别未完成，请重试。';
}

function analyzeLinks(projectName = projectInput.value.trim() || '未分类') {
  const inputPresent = Boolean(urlInput.value.trim());
  const lines = globalThis.ClipCargoLinkUtils.extractHttpUrls(urlInput.value);
  const result = { lines, inputPresent, valid: [], duplicates: [], invalid: [], overLimit: lines.length > 100 };
  const seen = new Set();
  if (inputPresent && !lines.length) result.invalid.push({ raw: urlInput.value.trim(), reason: '未找到 HTTP(S) 链接' });
  lines.forEach((raw) => {
    if (raw.length > 8192) { result.invalid.push({ raw, reason: '超过 8192 个字符' }); return; }
    let parsed;
    try { parsed = new URL(raw); }
    catch { result.invalid.push({ raw, reason: '不是完整链接' }); return; }
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      result.invalid.push({ raw, reason: '仅支持 HTTP(S) 链接' }); return;
    }
    const normalized = parsed.toString();
    if (seen.has(normalized) || state.items.some((item) => item.pageUrl === normalized && item.projectName === projectName)) {
      result.duplicates.push({ raw, normalized }); return;
    }
    seen.add(normalized);
    result.valid.push({ raw, normalized });
  });
  return result;
}

function updateLinkSummary() {
  const analysis = analyzeLinks();
  if (!analysis.inputPresent) {
    urlSummary.textContent = '自动提取 HTTP(S) 链接，最多 100 条';
    urlSummary.className = 'input-summary';
  } else {
    urlSummary.textContent = `可加入 ${analysis.valid.length} · 重复 ${analysis.duplicates.length} · 无效 ${analysis.invalid.length}${analysis.overLimit ? ' · 已超过 100 条上限' : ''}`;
    urlSummary.className = `input-summary${analysis.invalid.length || analysis.overLimit ? ' has-error' : ''}`;
  }
  importButton.disabled = linkImportInProgress || analysis.overLimit || analysis.valid.length === 0;
  return analysis;
}

function showModal(modal, preferredFocus) {
  modalReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  enhanceSelects(modal);
  const focusTarget = preferredFocus?.tagName === 'SELECT'
    ? preferredFocus.closest('.custom-select')?.querySelector('.custom-select-trigger')
    : preferredFocus;
  queueMicrotask(() => focusTarget?.focus());
}

function hideModal(modal) {
  modal.hidden = true;
  const returnTarget = modalReturnFocus;
  modalReturnFocus = null;
  if (returnTarget?.isConnected) queueMicrotask(() => returnTarget.focus());
}

function activeModal() {
  return [backdrop, projectBackdrop, playerBackdrop, processBackdrop, downloadBackdrop, inboxDetailBackdrop, batchMoveBackdrop, mediaEditBackdrop, localImportBackdrop, componentInstallBackdrop].find((modal) => !modal.hidden);
}

function trapModalFocus(event, modal) {
  const focusable = [...modal.querySelectorAll('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), video[controls], [tabindex]:not([tabindex="-1"])')]
    .filter((element) => !element.hidden && element.getClientRects().length);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

function renderProjectDialog() {
  projectList.innerHTML = state.projects.map((project) => {
    const name = escapeHtml(project.name);
    if (state.editingProject === project.name) {
      return `<div class="project-row editing"><input class="field-control" data-project-edit-input value="${name}" maxlength="50" aria-label="新的项目名称"><div class="project-actions"><button class="button compact" data-project-cancel>取消</button><button class="button compact primary" data-project-save="${name}">保存</button></div></div>`;
    }
    if (state.pendingProjectDelete === project.name) {
      return `<div class="project-row confirming"><div><strong>${name}</strong><small>${project.itemCount} 条内容将归入“未分类”，文件不会删除</small></div><div class="project-actions"><button class="button compact" data-project-cancel>取消</button><button class="button compact danger-text" data-project-confirm-delete="${name}">确认删除</button></div></div>`;
    }
    return `<div class="project-row"><div><strong>${name}</strong><small>${project.itemCount} 条内容${project.isSystem ? ' · 系统项目' : ''}</small></div>${project.isSystem ? '' : `<div class="project-actions"><button class="button compact" data-project-edit="${name}">重命名</button><button class="button compact danger-text" data-project-delete="${name}">删除</button></div>`}</div>`;
  }).join('');
}

function openProjectDialog() {
  state.editingProject = null;
  state.pendingProjectDelete = null;
  projectError.textContent = '';
  newProjectName.value = '';
  renderProjectDialog();
  showModal(projectBackdrop, newProjectName);
}

function closeProjectDialog() {
  state.editingProject = null;
  state.pendingProjectDelete = null;
  projectError.textContent = '';
  hideModal(projectBackdrop);
}

function renderInbox() {
  const projects = state.projects.map((project) => project.name);
  const jobsByItemId = new Map(state.jobs.map((job) => [job.itemId, job]));
  const pendingStatuses = ['captured', 'waiting_component', 'resolving'];
  const filtered = state.items.filter((item) => (state.filter === 'all' || (state.filter === 'captured' ? pendingStatuses.includes(item.status) : item.status === state.filter)) && (state.projectFilter === 'all' || item.projectName === state.projectFilter));
  const inboxPageCount = Math.max(1, Math.ceil(filtered.length / INBOX_PAGE_SIZE));
  state.inboxPage = Math.min(Math.max(1, state.inboxPage), inboxPageCount);
  const visible = filtered.slice((state.inboxPage - 1) * INBOX_PAGE_SIZE, state.inboxPage * INBOX_PAGE_SIZE);
  const waiting = state.items.filter((item) => pendingStatuses.includes(item.status)).length;
  const selectableIds = new Set(state.items.map((item) => item.id));
  const allDownloadable = state.items.filter((item) => {
    const job = jobsByItemId.get(item.id);
    return item.status === 'ready' && !['queued', 'downloading', 'completed'].includes(job?.status);
  });
  const allDownloadableIds = new Set(allDownloadable.map((item) => item.id));
  for (const id of selectedInboxItems) if (!selectableIds.has(id)) selectedInboxItems.delete(id);
  const selectedHidden = [...selectedInboxItems].filter((id) => !filtered.some((item) => item.id === id)).length;
  const selectedItems = state.items.filter((item) => selectedInboxItems.has(item.id));
  const selectedDownloadable = selectedItems.filter((item) => allDownloadableIds.has(item.id));
  const selectedResolvable = selectedItems.filter((item) => !['waiting_component', 'resolving', 'ready'].includes(item.status));
  const selectedRemovable = selectedItems.filter((item) => !jobsByItemId.has(item.id));
  main.innerHTML = `<div class="page-toolbar">
    <div class="tabs" role="tablist" aria-label="素材状态">
      <button class="tab ${state.filter === 'all' ? 'active' : ''}" role="tab" aria-selected="${state.filter === 'all'}" tabindex="${state.filter === 'all' ? '0' : '-1'}" data-filter="all">全部<span>${state.items.length}</span></button>
      <button class="tab ${state.filter === 'captured' ? 'active' : ''}" role="tab" aria-selected="${state.filter === 'captured'}" tabindex="${state.filter === 'captured' ? '0' : '-1'}" data-filter="captured">待处理<span>${waiting}</span></button>
    </div>
    <div class="heading-actions"><select id="project-filter" class="field-control compact-select" aria-label="按项目筛选"><option value="all">全部项目</option>${projects.map((project) => `<option value="${escapeHtml(project)}" ${state.projectFilter === project ? 'selected' : ''}>${escapeHtml(project)}</option>`).join('')}</select><button class="button project-button" data-action="manage-projects">${icon('folder')}项目</button><button class="button primary" data-action="open-add">${icon('plus')}添加链接</button></div>
    </div>
    ${selectedInboxItems.size ? `<div class="selection-bar"><label><input type="checkbox" data-select-visible ${filtered.length && filtered.every((item) => selectedInboxItems.has(item.id)) ? 'checked' : ''} ${filtered.length ? '' : 'disabled'}><span>已选 ${selectedInboxItems.size}${selectedHidden ? `（其中 ${selectedHidden} 项已隐藏）` : ''}</span></label><div class="selection-actions"><button class="button" data-action="resolve-selected" ${selectedResolvable.length ? '' : 'disabled'}>${icon('refresh-cw')}识别 ${selectedResolvable.length || ''}</button><button class="button" data-action="move-selected">${icon('folder')}移动</button><button class="button danger-text" data-action="remove-selected" ${selectedRemovable.length ? '' : 'disabled'}>${icon('trash-2')}${state.pendingBatchRemoval ? `确认移除 ${selectedRemovable.length} 项` : `移除 ${selectedRemovable.length || ''}`}</button><button class="button primary" data-action="download-selected" ${selectedDownloadable.length ? '' : 'disabled'}>${icon('download')}下载 ${selectedDownloadable.length || ''}</button></div></div>` : ''}
    ${state.loading ? '<div class="empty-state"><div>正在读取收集箱…</div></div>' : filtered.length ? `
      <div class="inbox-table"><div class="inbox-table-head"><label class="inbox-select" title="选择筛选结果"><input type="checkbox" data-select-visible aria-label="选择筛选结果" ${filtered.length && selectedInboxItems.size && filtered.every((item) => selectedInboxItems.has(item.id)) ? 'checked' : ''}></label><span>标题</span><span>来源</span><span>项目</span><span>时间</span><span>状态</span><span>操作</span></div><div class="inbox-list">${visible.map((item) => {
        const job = jobsByItemId.get(item.id);
        const displayStatus = inboxDisplayStatus(item, job);
        const confirmingRemoval = state.pendingInboxRemoval === item.id;
        const primaryAction = item.status === 'waiting_component'
          ? `<button class="button compact primary" data-view="browser">${icon('download')}安装下载引擎</button>`
          : item.status !== 'resolving' && item.status !== 'ready'
          ? `<button class="button compact" data-resolve="${item.id}">${icon(item.status === 'failed' ? 'refresh-cw' : 'circle-play')}${item.status === 'failed' ? '重试' : '识别'}</button>`
          : item.status === 'ready' && job?.status !== 'queued' && job?.status !== 'downloading' && job?.status !== 'completed'
            ? `<button class="button compact primary" data-download="${item.id}">${icon('download')}${job?.status === 'failed' ? '重试下载' : '下载'}</button>` : '';
        const secondaryActions = `${item.captureMethod === 'local-import' ? '' : `<button class="menu-action" data-open-source="${item.id}">${icon('external-link')}打开来源</button>`}${item.status === 'ready' && !job ? `<button class="menu-action" data-resolve="${item.id}">${icon('refresh-cw')}重新识别</button>` : ''}${job ? '' : `<button class="menu-action danger-text" data-remove="${item.id}">${icon('trash-2')}移除</button>`}`;
        return `
        <article class="inbox-row">
          <label class="inbox-select" title="选择条目"><input type="checkbox" data-select-item="${item.id}" aria-label="选择 ${escapeHtml(item.title)}" ${selectedInboxItems.has(item.id) ? 'checked' : ''}></label>
          <div class="inbox-title-cell"><div class="item-title-wrap"><button class="item-title item-title-button" data-inbox-detail="${item.id}" title="查看条目详情">${escapeHtml(item.title)}</button><div class="item-meta compact-only"><span>${escapeHtml(item.sourceHost)}</span><span>·</span><span>${escapeHtml(item.projectName)}</span><span>·</span><span>${escapeHtml(formatTime(item.createdAt))}</span></div>${item.errorMessage && item.status !== 'waiting_component' ? `<div class="item-error">${escapeHtml(inboxErrorLabel(item.errorMessage, item.errorCode))}</div>` : ''}</div></div>
          <div class="inbox-source">${escapeHtml(item.sourceHost)}${item.durationSeconds != null ? `<small>${formatDuration(item.durationSeconds)} · ${item.captureMethod === 'extension' ? '浏览器扩展' : item.captureMethod === 'local-import' ? '本地导入' : '粘贴链接'}</small>` : ''}</div>
          <div class="inbox-project">${escapeHtml(item.projectName)}</div>
          <time class="inbox-time">${escapeHtml(formatTime(item.createdAt))}</time>
          <div class="inbox-status-cell"><span class="status status-${escapeHtml(displayStatus.status)}">${escapeHtml(displayStatus.label)}</span></div>
          <div class="item-action">${confirmingRemoval ? `<button class="button compact" data-cancel-inbox-remove>取消</button><button class="button compact danger-text" data-confirm-inbox-remove="${item.id}">${icon('trash-2')}确认移除</button>` : `${primaryAction}${secondaryActions ? `<details class="media-more"><summary class="icon-button" aria-label="更多操作" title="更多操作">${icon('ellipsis')}</summary><div class="media-more-menu">${secondaryActions}</div></details>` : ''}`}</div>
        </article>`; }).join('')}</div></div>${pagination('inbox', state.inboxPage, inboxPageCount, filtered.length)}` : `
      <div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('inbox')}</div><h2>还没有链接</h2><p>粘贴链接，或从浏览器扩展发送。</p><button class="button primary" data-action="open-add">${icon('plus')}添加链接</button></div></div>`}`;
}

function visibleInboxItems() {
  return state.items.filter((item) => (state.filter === 'all' || (state.filter === 'captured' ? ['captured', 'waiting_component', 'resolving'].includes(item.status) : item.status === state.filter))
    && (state.projectFilter === 'all' || item.projectName === state.projectFilter));
}

function renderInboxDetail() {
  const item = state.items.find((entry) => entry.id === activeInboxDetailId);
  if (!item) return;
  const job = state.jobs.find((entry) => entry.itemId === item.id);
  inboxDetailName.value = item.title;
  inboxDetailProject.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${project.name === item.projectName ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  const resolution = item.status !== 'ready' ? '尚未识别' : Number.isFinite(item.maxHeight) ? `最高 ${item.maxHeight}p` : '来源未提供';
  const tracks = item.status === 'ready'
    ? `${item.hasVideo === false ? '无视频轨' : '有视频轨'} · ${item.hasAudio === false ? '无音轨' : '有音轨'}`
    : '尚未识别';
  const specification = item.status === 'ready' ? `${resolution} · ${tracks}` : '尚未识别';
  const subtitles = (item.subtitleOptions || []).length
    ? item.subtitleOptions.map((option) => `${option.language}（${option.automatic ? '自动' : '人工'}）`).join('、')
    : item.status === 'ready' ? '来源未提供' : '尚未识别';
  inboxDetailMeta.innerHTML = `
    <div><dt>原始标题</dt><dd>${escapeHtml(item.originalTitle || item.title)}</dd></div>
    <div><dt>来源</dt><dd title="${escapeHtml(item.pageUrl)}">${escapeHtml(item.pageUrl)}</dd></div>
    <div><dt>收集方式</dt><dd>${item.captureMethod === 'extension' ? '浏览器扩展' : item.captureMethod === 'local-import' ? '本地导入' : '粘贴链接'}</dd></div>
    <div><dt>收集时间</dt><dd>${escapeHtml(formatTime(item.createdAt))}</dd></div>
    <div><dt>最近识别</dt><dd>${item.resolvedAt ? escapeHtml(formatTime(item.resolvedAt)) : '尚未识别'}</dd></div>
    <div><dt>状态</dt><dd>${escapeHtml(inboxDisplayStatus(item, job).label)}</dd></div>
    <div><dt>时长</dt><dd>${item.durationSeconds != null ? formatDuration(item.durationSeconds) : '来源未提供'}</dd></div>
    <div><dt>规格</dt><dd>${escapeHtml(specification)}</dd></div>
    <div><dt>字幕</dt><dd title="${escapeHtml(subtitles)}">${escapeHtml(subtitles)}</dd></div>
    ${item.errorMessage ? `<div class="detail-error"><dt>问题</dt><dd>${escapeHtml(inboxErrorLabel(item.errorMessage, item.errorCode))}</dd></div><div><dt>建议</dt><dd>${escapeHtml(classifyTaskError(item.errorMessage, 'download', item.errorCode).action)}</dd></div>` : ''}`;
  const sourceButton = document.querySelector('#inbox-detail-source');
  sourceButton.hidden = item.captureMethod === 'local-import';
  const primary = document.querySelector('#inbox-detail-primary');
  primary.hidden = false;
  if (job?.status === 'completed') { primary.textContent = '查看素材'; primary.dataset.detailAction = 'library'; }
  else if (job && ['queued', 'downloading'].includes(job.status)) { primary.textContent = '查看任务'; primary.dataset.detailAction = 'tasks'; }
  else if (item.status === 'waiting_component') { primary.textContent = '安装下载引擎'; primary.dataset.detailAction = 'components'; }
  else if (item.status === 'ready') { primary.textContent = '准备下载'; primary.dataset.detailAction = 'download'; }
  else { primary.textContent = item.status === 'failed' ? '重新识别' : '识别'; primary.dataset.detailAction = 'resolve'; }
}

function openInboxDetail(id) {
  if (!state.items.some((item) => item.id === id)) return;
  activeInboxDetailId = id;
  inboxDetailError.textContent = '';
  renderInboxDetail();
  showModal(inboxDetailBackdrop, inboxDetailName);
}

function closeInboxDetail() {
  activeInboxDetailId = null;
  inboxDetailError.textContent = '';
  hideModal(inboxDetailBackdrop);
}

function taskMatchesFilter(item, filter) {
  if (filter === 'active') return ['queued', 'downloading', 'paused', 'processing'].includes(item.status);
  if (filter === 'attention') return item.status === 'failed' && !userCancelled(item);
  return item.status === 'completed' || userCancelled(item);
}

function renderTasks() {
  const jobs = state.jobs.filter((job) => taskMatchesFilter(job, state.taskFilter));
  const processing = state.derivatives.filter((item) => item.kind !== 'source' && taskMatchesFilter(item, state.taskFilter));
  const entries = [...jobs.map((item) => ({ type: 'download', item })), ...processing.map((item) => ({ type: 'processing', item }))];
  persistedTaskErrorCodes.clear();
  entries.forEach(({ item }) => {
    if (item.errorMessage && item.errorCode) persistedTaskErrorCodes.set(item.errorMessage, item.errorCode);
  });
  const taskPageCount = Math.max(1, Math.ceil(entries.length / TASK_PAGE_SIZE));
  state.taskPage = Math.min(Math.max(1, state.taskPage), taskPageCount);
  const pageEntries = entries.slice((state.taskPage - 1) * TASK_PAGE_SIZE, state.taskPage * TASK_PAGE_SIZE);
  const taskRows = pageEntries.map(({ type, item }) => {
    const cancelled = userCancelled(item);
    if (type === 'download') return `<article class="task-row"><div class="task-icon">${icon(cancelled ? 'square' : item.status === 'failed' ? 'circle-alert' : item.status === 'completed' ? 'circle-check' : 'download')}</div><div><strong>${escapeHtml(item.title)}</strong><div class="item-meta">下载 · ${escapeHtml(item.sourceHost)} · ${escapeHtml(outputPresetLabel(item.outputPreset))}${item.outputPreset === 'audio' ? '' : ` · ${escapeHtml(qualityLabel(item.quality))}`}${item.saveSubtitles ? ` · 字幕 ${escapeHtml((item.subtitleLanguages || []).join('、') || '自动')}` : ''}${item.saveCover ? ' · 封面' : ''}${item.retainSource ? ' · 保留原格式' : ''}${item.status === 'queued' ? queuePosition(state.jobs, item.id) : ''}</div>${item.status === 'downloading' || item.status === 'paused' ? `<div class="progress-track" aria-label="下载进度 ${Math.round(item.progressPercent || 0)}%"><span style="width:${Math.max(0, Math.min(100, item.progressPercent || 0))}%"></span></div>${downloadProgressDetail(item)}` : ''}${taskErrorMarkup(item.errorMessage, 'download', item.errorCode, item)}${item.warningMessage ? `<div class="item-warning">${escapeHtml(item.warningMessage)}</div>` : ''}</div><div class="item-action"><span class="status status-${cancelled ? 'cancelled' : item.status}">${cancelled ? '已停止' : jobLabel(item.status)}</span>${item.status === 'downloading' ? `<button class="button compact" data-pause-download="${item.id}">暂停</button><button class="button compact danger-text" data-cancel-download="${item.id}">停止</button>` : ''}${item.status === 'queued' ? `<button class="button compact danger-text" data-cancel-download="${item.id}">取消</button>` : ''}${item.status === 'paused' ? `<button class="button compact primary" data-resume-download="${item.id}">继续</button>` : ''}${item.status === 'failed' ? `${taskRecoveryButton(item)}<button class="button compact" data-retry-download="${item.id}">${icon('refresh-cw')}${cancelled ? '按原参数重新开始' : '按原参数重试'}</button>` : ''}</div></article>`;
    return `<article class="task-row"><div class="task-icon">${icon(cancelled ? 'square' : item.status === 'failed' ? 'circle-alert' : item.status === 'completed' ? 'circle-check' : 'scissors')}</div><div><strong>${escapeHtml(item.title)}</strong><div class="item-meta">${escapeHtml(derivativeKind(item.kind))}${item.status === 'queued' ? queuePosition(state.derivatives, item.id) : ''}</div>${item.status === 'processing' ? `<div class="progress-track" aria-label="处理进度 ${Math.round(item.progressPercent || 0)}%"><span style="width:${Math.max(0, Math.min(100, item.progressPercent || 0))}%"></span></div><div class="progress-label">${Math.round(item.progressPercent || 0)}%</div>` : ''}${taskErrorMarkup(item.errorMessage, 'processing', item.errorCode)}</div><div class="item-action"><span class="status status-${cancelled ? 'cancelled' : item.status}">${cancelled ? '已取消' : item.status === 'queued' ? '排队中' : item.status === 'processing' ? '处理中' : item.status === 'completed' ? '已完成' : '处理失败'}</span>${item.status === 'queued' || item.status === 'processing' ? `<button class="button compact danger-text" data-cancel-processing="${item.id}">取消</button>` : ''}${item.status === 'failed' ? `${taskRecoveryButton(item, 'processing')}<button class="button compact" data-retry-processing="${item.id}">${icon('refresh-cw')}${cancelled ? '按原参数重新开始' : '按原参数重试'}</button>` : ''}</div></article>`;
  }).join('');
  const taskFilters = [
    ['active', '进行中'],
    ['attention', '需处理'],
    ['history', '历史'],
  ];
  const emptyTaskLabels = { active: '没有正在进行的任务', attention: '没有需要处理的问题', history: '还没有历史记录' };
  main.innerHTML = `<div class="page-toolbar page-toolbar-simple"><div class="tabs" role="tablist" aria-label="任务状态">${taskFilters.map(([value, label]) => `<button class="tab ${state.taskFilter === value ? 'active' : ''}" role="tab" aria-selected="${state.taskFilter === value}" tabindex="${state.taskFilter === value ? '0' : '-1'}" data-task-filter="${value}">${label}</button>`).join('')}</div></div>` + (entries.length ? `
    <div class="task-list task-list-spaced">${taskRows}</div>${pagination('tasks', state.taskPage, taskPageCount, entries.length)}` : `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('list-checks')}</div><h2>${emptyTaskLabels[state.taskFilter]}</h2><button class="button" data-view="inbox">前往收集箱</button></div></div>`);
}

function libraryAssets() {
  const parentJobs = new Map(state.jobs.map((job) => [job.id, job]));
  return [
    ...state.jobs.filter((job) => job.status === 'completed' && !job.libraryHidden).map((job) => ({ ...job, parentJobId: job.id, assetType: 'original', assetId: job.id, kindLabel: '原片', mediaKind: /\.(mp3|m4a|wav|flac|ogg)$/i.test(job.filePath || '') ? 'audio' : 'video' })),
    ...state.derivatives.filter((item) => item.status === 'completed' && !item.libraryHidden && item.kind !== 'source').map((item) => {
      const parentJobId = item.parentJobId ?? item.jobId;
      const parent = parentJobs.get(parentJobId) || {};
      return { ...parent, ...item, sourceHost: parent.sourceHost || item.sourceHost, thumbnailUrl: parent.thumbnailUrl || item.thumbnailUrl, durationSeconds: item.durationSeconds ?? parent.durationSeconds, parentJobId, assetType: 'derivative', assetId: item.id, kindLabel: derivativeKind(item.kind), mediaKind: item.kind === 'audio' || /\.(mp3|m4a|wav|flac|ogg)$/i.test(item.filePath || '') ? 'audio' : 'video' };
    }),
  ];
}

function libraryAssetCard(item) {
      const removalKey = `${item.assetType}:${item.assetId}`;
      const confirmingRemoval = state.pendingLibraryRemoval === removalKey;
      const externalReference = item.assetType === 'original' && item.managedFile === false;
      const primaryAction = !item.fileMissing && item.assetType === 'original'
        ? `<button class="button compact" data-process="${item.id}">${icon('scissors')}处理</button>`
        : item.fileMissing ? `<button class="button compact primary" data-relink-type="${item.assetType}" data-relink-id="${item.assetId}" data-relink-reference="${externalReference}">${icon('folder')}重新定位</button>` : '';
      const editorAction = !item.fileMissing && state.editor ? `<button class="button compact" data-import-editor-type="${item.assetType}" data-import-editor-id="${item.assetId}">${icon('external-link')}交给剪映</button>` : '';
      const secondaryActions = `${item.fileMissing ? `<button class="menu-action" aria-label="拖入文件定位" data-relink-drop-type="${item.assetType}" data-relink-drop-id="${item.assetId}" data-relink-drop-reference="${externalReference}">${icon('folder')}拖入文件定位</button>` : `<button class="menu-action" aria-label="编辑信息" data-edit-library-type="${item.assetType}" data-edit-library-id="${item.assetId}">${icon('pencil')}编辑信息</button><button class="menu-action" aria-label="打开文件位置" data-reveal-type="${item.assetType}" data-reveal-id="${item.assetId}">${icon('folder')}文件位置</button><button class="menu-action" aria-label="复制文件路径" data-copy-type="${item.assetType}" data-copy-id="${item.assetId}">${icon('link')}复制路径</button>`}<button class="menu-action danger-text" aria-label="从素材库移除" data-remove-library-type="${item.assetType}" data-remove-library-id="${item.assetId}">${icon('trash-2')}移除</button>`;
      const impact = confirmingRemoval ? state.pendingLibraryImpact : null;
      const impactLine = impact ? `${escapeHtml(impact.fileName)}${Number.isFinite(impact.sizeBytes) ? ` · ${formatBytes(impact.sizeBytes)}` : ' · 文件大小未知'}${impact.referenceCount > 1 ? ` · ${impact.referenceCount} 条素材记录引用` : ''}` : '';
      const removalMessage = externalReference ? `只会移除外部引用，用户原文件不会被删除。${item.fileMissing ? ' 当前路径已经失效。' : ''}` : item.fileMissing ? '素材文件已经不存在，只能移除记录。' : impact?.referenceCount > 1 ? '移到回收站会让所有引用该文件的记录显示缺失。' : '选择保留硬盘文件，或将文件移到 Windows 回收站。';
      const badge = item.fileMissing
        ? '<span class="state-pill warning">文件缺失</span>'
        : externalReference
          ? '<span class="state-pill neutral">外部引用</span>'
          : '';
      const metadata = `<span>${escapeHtml(item.kindLabel)}</span><span>·</span><span>${escapeHtml(item.projectName || '未分类')}</span>${item.sourceHost ? `<span>·</span><span>${escapeHtml(item.sourceHost)}</span>` : ''}${item.durationSeconds != null ? `<span>·</span><span>${formatDuration(item.durationSeconds)}</span>` : ''}`;
      const mediaActions = `<div class="media-primary-actions">${primaryAction}${editorAction}</div><details class="media-more"><summary class="icon-button" aria-label="更多操作" title="更多操作">${icon('ellipsis')}</summary><div class="media-more-menu">${secondaryActions}</div></details>`;
      return `<article class="media-card ${item.fileMissing ? 'missing' : ''}"><button class="media-preview" ${item.fileMissing ? 'disabled' : `data-play-type="${item.assetType}" data-play-id="${item.assetId}"`}><div class="media-thumb">${safeThumbnail(item.thumbnailUrl) ? `<img src="${escapeHtml(safeThumbnail(item.thumbnailUrl))}" alt="" loading="lazy">` : ''}<span class="play-overlay">${icon(item.fileMissing ? 'circle-alert' : 'circle-play')}</span></div><div class="media-info"><div class="media-title-row"><strong title="${escapeHtml(item.title)}">${escapeHtml(item.title)}</strong></div><div class="media-badge-row">${badge}</div><div class="item-meta">${metadata}</div></div></button>${confirmingRemoval ? `<div class="library-removal-confirm"><span>${impactLine ? `<strong>${impactLine}</strong><br>` : ''}${removalMessage}</span><div><button class="button compact" data-cancel-library-removal>取消</button><button class="button compact" data-confirm-library-removal-type="${item.assetType}" data-confirm-library-removal-id="${item.assetId}">仅移出库</button>${item.fileMissing || externalReference ? '' : `<button class="button compact danger-text" data-trash-library-type="${item.assetType}" data-trash-library-id="${item.assetId}">移到回收站</button>`}</div></div>` : `<div class="media-actions">${mediaActions}</div>`}</article>`;
}

function renderLibrary() {
  const query = state.libraryQuery.trim().toLocaleLowerCase('zh-CN');
  const allAssets = libraryAssets();
  const projectOptions = state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${state.libraryProject === project.name ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  const tabs = `<div class="tabs library-view-tabs" role="tablist" aria-label="素材库视图"><button class="tab ${state.libraryView === 'projects' ? 'active' : ''}" role="tab" aria-selected="${state.libraryView === 'projects'}" data-library-view="projects">素材项目</button><button class="tab ${state.libraryView === 'assets' ? 'active' : ''}" role="tab" aria-selected="${state.libraryView === 'assets'}" data-library-view="assets">全部素材</button></div>`;
  const controls = `<div class="library-controls"><input id="library-search" class="search-control" type="search" placeholder="搜索标题、来源或路径" value="${escapeHtml(state.libraryQuery)}"><select id="library-project" class="field-control compact-select" aria-label="按项目筛选"><option value="all">全部项目</option>${projectOptions}</select>${state.libraryView === 'assets' ? `<select id="library-kind" class="field-control compact-select" aria-label="按素材类型筛选"><option value="all" ${state.libraryKind === 'all' ? 'selected' : ''}>全部类型</option><option value="video" ${state.libraryKind === 'video' ? 'selected' : ''}>视频</option><option value="audio" ${state.libraryKind === 'audio' ? 'selected' : ''}>音频</option><option value="original" ${state.libraryKind === 'original' ? 'selected' : ''}>原片</option><option value="derivative" ${state.libraryKind === 'derivative' ? 'selected' : ''}>处理副本</option></select>` : ''}<select id="library-sort" class="field-control compact-select" aria-label="素材排序"><option value="newest" ${state.librarySort === 'newest' ? 'selected' : ''}>最新</option><option value="oldest" ${state.librarySort === 'oldest' ? 'selected' : ''}>最早</option><option value="name" ${state.librarySort === 'name' ? 'selected' : ''}>名称</option><option value="duration" ${state.librarySort === 'duration' ? 'selected' : ''}>时长</option></select><button class="button" data-action="choose-local-media">${icon('file-video')}导入</button></div>`;

  if (state.libraryView === 'projects') {
    let projects = state.jobs.filter((job) => job.status === 'completed' && !job.libraryHidden).map((job) => {
      const assets = allAssets.filter((asset) => asset.parentJobId === job.id);
      return { job, assets, videoCount: assets.filter((asset) => asset.mediaKind === 'video').length, audioCount: assets.filter((asset) => asset.mediaKind === 'audio').length };
    }).filter(({ job }) => {
      const matchesQuery = !query || [job.title, job.sourceHost, job.projectName, job.filePath].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
      return matchesQuery && (state.libraryProject === 'all' || job.projectName === state.libraryProject);
    });
    projects.sort((a, b) => state.librarySort === 'oldest' ? a.job.updatedAt - b.job.updatedAt : state.librarySort === 'name' ? a.job.title.localeCompare(b.job.title, 'zh-CN') : state.librarySort === 'duration' ? (b.job.durationSeconds || -1) - (a.job.durationSeconds || -1) : b.job.updatedAt - a.job.updatedAt);
    const pageCount = Math.max(1, Math.ceil(projects.length / LIBRARY_PAGE_SIZE));
    state.libraryPage = Math.min(Math.max(1, state.libraryPage), pageCount);
    const pageProjects = projects.slice((state.libraryPage - 1) * LIBRARY_PAGE_SIZE, state.libraryPage * LIBRARY_PAGE_SIZE);
    main.innerHTML = `<div class="page-toolbar library-toolbar">${tabs}${controls}</div>` + (projects.length ? `<div class="asset-project-grid">${pageProjects.map(({ job, videoCount, audioCount }) => `<article class="asset-project-card ${job.fileMissing ? 'missing' : ''}"><button class="asset-project-preview" data-open-library-project="${job.id}"><div class="asset-project-cover">${safeThumbnail(job.thumbnailUrl) ? `<img src="${escapeHtml(safeThumbnail(job.thumbnailUrl))}" alt="" loading="lazy">` : `<span>${icon('film')}</span>`}${job.fileMissing ? `<span class="project-missing">文件缺失</span>` : ''}</div><div class="asset-project-content"><strong title="${escapeHtml(job.title)}">${escapeHtml(job.title)}</strong><span>${escapeHtml(job.sourceHost || '本地素材')} · ${escapeHtml(job.projectName || '未分类')}${job.durationSeconds != null ? ` · ${formatDuration(job.durationSeconds)}` : ''}</span><div class="asset-counts"><span>${icon('film')}视频 ${videoCount}</span><span>${icon('music-2')}音频 ${audioCount}</span><span>${icon('file-video')}图片 ${job.imageCount || 0}</span><span>${icon('list-checks')}字幕 ${job.subtitleCount || 0}</span></div></div></button><div class="asset-project-actions"><button class="button compact primary" data-open-library-project="${job.id}">查看素材</button>${job.fileMissing ? '' : `${state.editor ? `<button class="button compact" data-import-package-editor="${job.id}">${icon('external-link')}导入剪映</button>` : ''}<button class="button compact" data-open-asset-package="${job.id}">${icon('folder')}打开文件夹</button><button class="button compact" data-process="${job.id}">${icon('scissors')}处理</button>`}</div></article>`).join('')}</div>${pagination('library', state.libraryPage, pageCount, projects.length)}` : state.libraryQuery || state.libraryProject !== 'all' ? `<div class="empty-state"><div class="empty-state-inner"><h2>没有匹配的素材项目</h2><button class="button" data-action="clear-library-filters">清除筛选</button></div></div>` : `<div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('film')}</div><h2>素材库为空</h2><button class="button" data-view="inbox">前往收集箱</button></div></div>`);
  } else {
    let assets = allAssets.filter((item) => {
      const matchesQuery = !query || [item.title, item.kindLabel, item.sourceHost, item.projectName, item.filePath].some((value) => String(value || '').toLocaleLowerCase('zh-CN').includes(query));
      const matchesProject = state.libraryProject === 'all' || item.projectName === state.libraryProject;
      const matchesKind = state.libraryKind === 'all' || (state.libraryKind === 'original' && item.assetType === 'original') || (state.libraryKind === 'derivative' && item.assetType === 'derivative') || state.libraryKind === item.mediaKind;
      const matchesSource = state.librarySourceJob == null || item.parentJobId === state.librarySourceJob;
      return matchesQuery && matchesProject && matchesKind && matchesSource;
    });
    assets.sort((a, b) => state.librarySort === 'oldest' ? a.updatedAt - b.updatedAt : state.librarySort === 'name' ? a.title.localeCompare(b.title, 'zh-CN') : state.librarySort === 'duration' ? (b.durationSeconds || -1) - (a.durationSeconds || -1) : b.updatedAt - a.updatedAt);
    const pageCount = Math.max(1, Math.ceil(assets.length / LIBRARY_PAGE_SIZE));
    state.libraryPage = Math.min(Math.max(1, state.libraryPage), pageCount);
    const pageAssets = assets.slice((state.libraryPage - 1) * LIBRARY_PAGE_SIZE, state.libraryPage * LIBRARY_PAGE_SIZE);
    const sourceJob = state.librarySourceJob == null ? null : state.jobs.find((job) => job.id === state.librarySourceJob);
    const sourceBar = sourceJob ? `<div class="library-source-bar"><button class="button compact" data-library-view="projects">${icon('chevron-right')}返回项目</button><div class="library-source-title"><span>来源标题</span><strong title="${escapeHtml(sourceJob.title)}">${escapeHtml(sourceJob.title)}</strong></div>${state.editor ? `<button class="button compact" data-import-package-editor="${sourceJob.id}">${icon('external-link')}导入剪映</button>` : ''}<button class="button compact" data-open-asset-package="${sourceJob.id}">${icon('folder')}打开文件夹</button></div>` : '';
    main.innerHTML = `<div class="page-toolbar library-toolbar">${tabs}${controls}</div>${sourceBar}` + (assets.length ? `<div class="media-grid">${pageAssets.map(libraryAssetCard).join('')}</div>${pagination('library', state.libraryPage, pageCount, assets.length)}` : state.libraryQuery || state.libraryProject !== 'all' || state.libraryKind !== 'all' || sourceJob ? `
    <div class="empty-state"><div class="empty-state-inner"><h2>没有匹配的素材</h2><button class="button" data-action="clear-library-filters">清除筛选</button></div></div>` : `
    <div class="empty-state"><div class="empty-state-inner"><div class="empty-icon">${icon('film')}</div><h2>素材库为空</h2><button class="button" data-view="inbox">前往收集箱</button></div></div>`);
  }
  main.querySelectorAll('.media-thumb img').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
  main.querySelectorAll('.asset-project-cover img').forEach((image) => {
    image.addEventListener('error', () => image.remove(), { once: true });
  });
}

function openMediaEdit(assetType, assetId) {
  const source = assetType === 'original' ? state.jobs : state.derivatives;
  const item = source.find((entry) => entry.id === assetId);
  if (!item) { notify('素材已不存在'); return; }
  activeMediaEdit = { assetType, assetId };
  mediaEditName.value = item.title;
  mediaEditProject.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${project.name === item.projectName ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
  mediaEditError.textContent = '';
  showModal(mediaEditBackdrop, mediaEditName);
  mediaEditName.select();
}

function closeMediaEdit() {
  activeMediaEdit = null;
  mediaEditError.textContent = '';
  hideModal(mediaEditBackdrop);
}

async function openLocalImport(paths) {
  if (!paths?.length) return;
  localImportError.textContent = '';
  try {
    const preview = await invoke('inspect_local_media', { paths });
    pendingLocalImportPaths = [...paths];
    localImportSummary.textContent = `${preview.count} 个文件 · ${formatBytes(preview.totalBytes)}${preview.count > 1 ? '（总计）' : ''}`;
    localImportProject.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${project.name === preferredProject() ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('');
    localImportBackdrop.querySelector('[name="local-import-mode"][value="copy"]').checked = true;
    showModal(localImportBackdrop, localImportProject);
  } catch (error) { notify(readableError(error)); }
}

function closeLocalImport() {
  pendingLocalImportPaths = [];
  localImportError.textContent = '';
  hideModal(localImportBackdrop);
}

const componentInstallPlans = {
  'yt-dlp': { title: '下载引擎', purpose: '识别视频链接并下载可用的原画质内容。', download: '约 18 MiB', installed: '约 20 MiB', source: 'yt-dlp 官方 GitHub Release', command: 'install_yt_dlp' },
  deno: { title: '网站兼容工具', purpose: '支持部分需要网页脚本解析的网站，安装后由 ClipCargo 自动使用。', download: '约 45 MiB', installed: '约 100 MiB', source: 'Deno 官方 GitHub Release', command: 'install_deno' },
  ffmpeg: { title: '视频处理工具', purpose: '完成音画合并、转 MP4、裁剪和音频提取。', download: '约 110 MiB', installed: '约 250 MiB', source: 'gyan.dev FFmpeg Essentials', command: 'install_ffmpeg' },
};

function openComponentInstall(kind) {
  const plan = componentInstallPlans[kind];
  if (!plan) return;
  pendingComponentInstall = kind;
  componentInstallTitle.textContent = `安装${plan.title}`;
  componentInstallPurpose.textContent = plan.purpose;
  componentInstallDownload.textContent = `${plan.download}（随官方版本变化）`;
  componentInstallSize.textContent = plan.installed;
  componentInstallSource.textContent = plan.source;
  componentInstallPath.textContent = state.components?.componentDirectory || 'ClipCargo 应用数据目录';
  componentInstallError.textContent = '';
  componentCancelRequested = false;
  componentInstallConfirm.disabled = false;
  componentInstallCancel.disabled = false;
  componentInstallCancel.textContent = '取消';
  componentInstallClose.disabled = false;
  componentInstallConfirm.removeAttribute('aria-busy');
  componentInstallConfirm.innerHTML = `${icon('download')}确认下载并安装`;
  showModal(componentInstallBackdrop, componentInstallConfirm);
}

function closeComponentInstall() {
  if (componentInstallConfirm.disabled) return;
  pendingComponentInstall = null;
  componentInstallError.textContent = '';
  hideModal(componentInstallBackdrop);
}

async function confirmComponentInstall() {
  const kind = pendingComponentInstall;
  const plan = componentInstallPlans[kind];
  if (!plan) return;
  activeComponentInstallKind = kind;
  pendingComponentInstall = null;
  componentCancelRequested = false;
  componentInstallFailure = '';
  hideModal(componentInstallBackdrop);
  state.components = { ...(state.components || {}), installing: true, installPhase: 'downloading', installProgressPercent: 0 };
  render();
  notify(`${plan.title}已转入后台安装，可以继续使用其他页面`);
  const phaseTimer = setInterval(async () => {
    try {
      const progress = await invoke('component_install_status');
      state.components = { ...(state.components || {}), ...progress };
      if (state.view === 'browser') render();
    } catch { /* 安装主请求会呈现最终错误。 */ }
  }, 500);
  try {
    const result = await invoke(plan.command);
    clearInterval(phaseTimer);
    state.components = await invoke('component_status');
    let resumed = 0;
    let resumeFailed = 0;
    if (kind === 'yt-dlp') {
      const waitingIds = state.items.filter((item) => item.status === 'waiting_component').map((item) => item.id);
      for (const id of waitingIds) {
        try {
          const resolved = await invoke('resolve_inbox_item', { id });
          if (resolved?.status === 'ready') resumed += 1;
          else resumeFailed += 1;
        }
        catch { resumeFailed += 1; }
      }
      if (waitingIds.length) await refreshInbox({ quiet: true });
    }
    activeComponentInstallKind = null;
    render();
    const resumeParts = [];
    if (resumed) resumeParts.push(`已继续识别 ${resumed} 个等待条目`);
    if (resumeFailed) resumeParts.push(`${resumeFailed} 个等待条目仍需检查`);
    const resumeMessage = resumeParts.length ? `；${resumeParts.join('，')}` : '';
    notify(`${plan.title} ${result.version} 安装完成并通过校验${resumeMessage}`);
  } catch (error) {
    clearInterval(phaseTimer);
    state.components = await invoke('component_status').catch(() => ({ installing: false }));
    if (componentCancelRequested && readableError(error).includes('已取消')) {
      activeComponentInstallKind = null;
      componentCancelRequested = false;
      render();
      notify('工具安装已取消，现有版本没有改变');
      return;
    }
    activeComponentInstallKind = null;
    componentInstallFailure = readableError(error);
    render();
    notify(`${plan.title}安装失败：${componentInstallFailure}`);
  }
}

async function cancelComponentInstall() {
  if (!state.components?.installing) { closeComponentInstall(); return; }
  componentCancelRequested = true;
  render();
  try { await invoke('cancel_component_install'); }
  catch (error) {
    componentCancelRequested = false;
    notify(readableError(error));
  }
}

async function submitLocalImport() {
  if (!pendingLocalImportPaths.length) return;
  const button = document.querySelector('#local-import-submit');
  const importMode = localImportBackdrop.querySelector('[name="local-import-mode"]:checked')?.value || 'copy';
  button.disabled = true;
  localImportError.textContent = '';
  try {
    const imported = await invoke('import_local_media', { paths: pendingLocalImportPaths, projectName: localImportProject.value, importMode });
    closeLocalImport();
    await refreshInbox();
    state.view = 'library';
    render();
    notify(`已${importMode === 'copy' ? '复制导入' : '引用'} ${imported.length} 个本地素材`);
  } catch (error) { localImportError.textContent = readableError(error); }
  finally { button.disabled = false; }
}

function renderBrowser() {
  const bridge = state.bridge;
  const components = state.components;
  const bridgeLoading = !bridge;
  const componentsLoading = !components;
  const parserReady = components?.ytDlpReady;
  const bridgeReady = Boolean(bridge?.registered);
  const extensionVerified = Boolean(bridge?.extensionVerified);
  const extensionActive = Boolean(bridge?.extensionActive);
  const activeExtensionId = extensionVerified ? bridge?.extensionId : null;
  const isStoreExtension = activeExtensionId === STORE_EXTENSION_ID;
  const isDevelopmentExtension = activeExtensionId === DEVELOPMENT_EXTENSION_ID;
  const showDeveloperExtensionFlow = isDevelopmentExtension || (bridge?.debugBuild === true && !extensionVerified);
  const extensionPackageVersion = bridge?.extensionPackageVersion || '';
  const extensionNeedsReload = Boolean(
    isDevelopmentExtension
    && extensionPackageVersion
    && bridge?.extensionVersion
    && bridge.extensionVersion !== extensionPackageVersion,
  );
  const bridgeHostInstalled = bridge?.hostInstalled === true;
  const bridgeBadge = bridgeLoading
    ? '检测中…'
    : extensionActive
      ? (isStoreExtension ? '商店版已启用' : isDevelopmentExtension ? '测试版已启用' : '已启用')
      : extensionVerified
        ? (isStoreExtension ? '商店版已安装' : isDevelopmentExtension ? '测试版已安装' : '已安装')
        : bridgeHostInstalled ? '待安装' : '桥接未就绪';
  const extensionDetail = bridgeLoading
    ? '正在读取扩展和桌面连接状态…'
    : extensionNeedsReload
      ? `开发测试扩展 ${escapeHtml(bridge.extensionVersion)} 与本地文件 ${escapeHtml(extensionPackageVersion)} 不一致，请重新加载本地扩展文件。`
      : isStoreExtension
      ? `Chrome Web Store 版 ${escapeHtml(bridge.extensionVersion || '未知')} · ${extensionActive ? '已连接 ClipCargo' : '等待浏览器连接'}`
      : extensionActive
      ? `${isDevelopmentExtension ? '开发测试版' : '扩展'} ${escapeHtml(bridge.extensionVersion || '未知')} · 最近通信 ${escapeHtml(formatTime(bridge.lastSeenAt))}`
      : extensionVerified
        ? `扩展 ${escapeHtml(bridge.extensionVersion || '未知')} · 等待浏览器重新连接`
        : bridgeHostInstalled
          ? '尚未检测到 Chrome Web Store 扩展，安装后视频卡片会显示 ClipCargo 浮标。'
          : '桌面桥接尚未准备好，请重新安装完整版本。';
  const extensionDistributionNote = showDeveloperExtensionFlow
    ? '<span>开发测试版 · 仅供开发者使用</span>'
    : isStoreExtension
      ? ''
      : '<span>未检测到 Chrome Web Store 扩展，请先安装商店版。</span>';
  const extensionAction = showDeveloperExtensionFlow
    ? `<button class="button" data-action="open-extension" ${bridgeHostInstalled ? '' : 'disabled'}>${icon('folder')}打开本地扩展文件</button>`
    : `<button class="button primary" data-action="open-extension-store">${icon('globe-2')}打开 Chrome 商店</button>`;
  const extensionCheckAction = state.bridgeChecking
    ? `<button class="button" data-action="check-extension" disabled aria-busy="true" aria-label="正在检测…">${icon('refresh-cw')}正在检测…</button>`
    : `<button class="button" data-action="check-extension" ${bridgeHostInstalled ? '' : 'disabled'}>${icon('refresh-cw')}检测连接</button>`;
  const extensionTestDetails = showDeveloperExtensionFlow ? '<details class="setup-details"><summary>开发者测试说明</summary><p>本地测试扩展只用于开发验证，不代表商店用户安装的版本。</p><ol><li>点击“打开本地扩展文件”，在浏览器扩展页开启开发者模式。</li><li>选择软件释放的扩展文件夹并加载。</li><li>开发测试时保持开发者模式开启；普通用户不需要这一步。</li></ol></details>' : '';
  const installPhaseText = { downloading: '正在下载', verifying: '正在校验', installing: '正在安装' }[components?.installPhase] || '正在准备';
  const installProgress = Number.isFinite(components?.installProgressPercent) ? Math.max(0, Math.min(100, components.installProgressPercent)) : 0;
  const installingTitle = componentInstallPlans[activeComponentInstallKind]?.title || '所需工具';
  const componentRow = (kind, title, ready, detail) => {
    const confirming = state.pendingComponentRemoval === kind;
    const installAction = kind === 'yt-dlp' ? 'install-yt-dlp' : `install-${kind}`;
    if (confirming) return `<div class="component-row confirming"><div><strong>${title}</strong><small>卸载后相关识别、下载或处理功能将不可用，已保存的素材不会删除。</small></div><span class="state-pill warning">确认卸载</span><div class="component-confirm-actions"><button class="button compact" data-action="cancel-remove-component">取消</button><button class="button compact danger-text" data-action="confirm-remove-component" data-component-kind="${kind}">${icon('trash-2')}卸载</button></div></div>`;
    return `<div class="component-row"><div><strong>${title}</strong><small>${componentsLoading ? '正在读取工具状态…' : detail}</small></div><span class="state-pill ${componentsLoading ? 'neutral' : ready ? 'success' : 'warning'}">${componentsLoading ? '检测中…' : ready ? '已就绪' : '未安装'}</span><div class="component-actions"><button class="button compact ${ready ? '' : 'primary'}" data-action="${installAction}" ${componentsLoading || components?.installing ? 'disabled aria-busy="true"' : ''}>${icon(ready ? 'refresh-cw' : 'download')}${componentsLoading ? '检测中…' : components?.installing ? '安装中…' : ready ? '更新' : '安装'}</button>${ready ? `<button class="button compact danger-text" data-action="remove-component" data-component-kind="${kind}">卸载</button>` : ''}</div></div>`;
  };
  main.innerHTML = `
    <div class="settings-grid">
      <div class="settings-column">
        <section class="setting-card"><div class="setting-icon">${icon('settings')}</div><div class="setting-body"><div class="setting-title"><h2>常规</h2></div><div class="setting-fields"><label>主题<select id="setting-theme" class="field-control"><option value="system" ${preferences.theme === 'system' ? 'selected' : ''}>跟随系统</option><option value="light" ${preferences.theme === 'light' ? 'selected' : ''}>浅色</option><option value="dark" ${preferences.theme === 'dark' ? 'selected' : ''}>深色</option></select></label><label>默认项目<select id="setting-default-project" class="field-control">${state.projects.map((project) => `<option value="${escapeHtml(project.name)}" ${preferredProject() === project.name ? 'selected' : ''}>${escapeHtml(project.name)}</option>`).join('')}</select></label><label>同时下载<select id="setting-download-concurrency" class="field-control"><option value="1" ${preferences.downloadConcurrency === 1 ? 'selected' : ''}>1 个任务</option><option value="2" ${preferences.downloadConcurrency === 2 ? 'selected' : ''}>2 个任务</option><option value="3" ${preferences.downloadConcurrency === 3 ? 'selected' : ''}>3 个任务</option><option value="4" ${preferences.downloadConcurrency === 4 ? 'selected' : ''}>4 个任务</option></select></label><label>默认输出<select id="setting-download-preset" class="field-control"><option value="package" ${preferences.downloadPreset === 'package' ? 'selected' : ''}>完整素材包</option><option value="video" ${preferences.downloadPreset === 'video' ? 'selected' : ''}>兼容 MP4</option><option value="source" ${preferences.downloadPreset === 'source' ? 'selected' : ''}>保留来源格式</option><option value="audio" ${preferences.downloadPreset === 'audio' ? 'selected' : ''}>只要音频</option></select></label>${preferences.downloadPreset !== 'audio' ? `<label>默认清晰度<select id="setting-download-quality" class="field-control"><option value="1080" ${preferences.downloadQuality === '1080' ? 'selected' : ''}>最高 1080p</option><option value="720" ${preferences.downloadQuality === '720' ? 'selected' : ''}>最高 720p</option><option value="best" ${preferences.downloadQuality === 'best' ? 'selected' : ''}>最佳可用</option></select></label><label class="check-setting"><input id="setting-save-subtitles" type="checkbox" ${preferences.saveSubtitles ? 'checked' : ''} ${preferences.downloadPreset === 'package' ? 'disabled' : ''}>默认保存字幕</label>` : ''}</div></div></section>
        <section class="setting-card"><div class="setting-icon">${icon('puzzle')}</div><div class="setting-body"><div class="setting-title"><h2>浏览器收集</h2><span class="state-pill ${bridgeLoading ? 'neutral' : extensionActive ? 'success' : extensionVerified ? 'neutral' : 'warning'}">${bridgeBadge}</span></div><small class="setting-status-detail">${extensionDetail}</small>${extensionDistributionNote ? `<div class="extension-distribution-note">${extensionDistributionNote}</div>` : ''}<div class="setting-actions">${extensionAction}${extensionCheckAction}</div>${extensionTestDetails}</div></section>
      </div>
      <div class="settings-column">
        <section id="auth-settings" class="setting-card" tabindex="-1"><div class="setting-icon">${icon('key-round')}</div><div class="setting-body"><div class="setting-title"><h2>需要登录的视频</h2><span class="state-pill ${state.authLoginOpen ? 'warning' : state.authConfigured ? 'neutral' : 'neutral'}">${state.authLoginOpen ? '等待登录' : state.authConfigured ? '已保存登录配置' : '未设置'}</span></div><p class="setting-hint">仅在下载需要登录时，用独立窗口保存配置；不会读取日常浏览器账号。</p><div class="setting-actions">${state.authLoginOpen ? `<button class="button primary" data-action="finish-source-login">我已完成登录</button><button class="button" data-action="clear-source-browser">取消</button>` : `<button class="button" data-action="open-source-login" data-browser="chrome">${state.authConfigured && state.authBrowser === 'chrome' ? '重新打开 Chrome 登录' : '在 Chrome 中登录'}</button><button class="button" data-action="open-source-login" data-browser="edge">${state.authConfigured && state.authBrowser === 'edge' ? '重新打开 Edge 登录' : '在 Edge 中登录'}</button>${state.authConfigured ? '<button class="button danger-text" data-action="clear-source-browser">清除登录配置</button>' : ''}`}</div></div></section>
        <section class="setting-card"><div class="setting-icon">${icon('hard-drive')}</div><div class="setting-body"><div class="setting-title"><h2>文件保存位置</h2><span class="state-pill ${components?.storageFreeBytes == null ? 'neutral' : components.storageFreeBytes < 536870912 ? 'warning' : 'success'}">${components?.storageFreeBytes == null ? '等待检测' : `${formatBytes(components.storageFreeBytes)} 可用`}</span></div><div class="storage-path" title="${escapeHtml(components?.downloadsDirectory || '')}">${escapeHtml(components?.downloadsDirectory || '尚未确定')}</div><div class="setting-actions"><button class="button primary" data-action="choose-downloads-directory">${icon('folder')}更改位置</button><button class="button" data-action="open-downloads-directory">${icon('external-link')}打开文件夹</button></div></div></section>
        <section id="components-settings" class="setting-card components-card" tabindex="-1"><div class="setting-icon">${icon('blocks')}</div><div class="setting-body"><div class="setting-title"><h2>所需工具</h2><span class="state-pill neutral">按需安装${components?.totalBytes ? ` · ${formatBytes(components.totalBytes)}` : ''}</span></div><div class="component-location"><div><strong>工具安装位置</strong><small title="${escapeHtml(components?.componentDirectory || '')}">${escapeHtml(components?.componentDirectory || '尚未确定')}</small></div><div class="setting-actions"><button class="button compact" data-action="choose-components-directory">${icon('folder')}更改位置</button><button class="button compact" data-action="open-components">${icon('external-link')}打开工具目录</button></div></div>${components?.installing ? `<div class="component-install-progress" role="status" aria-live="polite"><div><strong>${escapeHtml(installingTitle)} · ${componentCancelRequested ? '正在取消…' : installPhaseText}</strong><span>${installProgress}%</span></div><progress max="100" value="${installProgress}">${installProgress}%</progress><button class="button compact" data-action="cancel-active-component-install" ${componentCancelRequested ? 'disabled' : ''}>${componentCancelRequested ? '正在取消…' : '取消安装'}</button></div>` : componentInstallFailure ? `<div class="component-install-failure" role="alert"><span>${escapeHtml(componentInstallFailure)}</span><button class="button compact" data-action="dismiss-component-error">关闭</button></div>` : ''}<div class="component-list">
        ${componentRow('yt-dlp', '下载引擎', parserReady, parserReady ? `版本 ${escapeHtml(compactComponentVersion(components.ytDlpVersion))} · ${formatBytes(components.ytDlpBytes)}` : '识别视频链接并下载原画质内容')}
        ${componentRow('deno', '网站兼容工具', components?.denoReady, components?.denoReady ? `版本 ${escapeHtml(compactComponentVersion(components.denoVersion))} · ${formatBytes(components.denoBytes)}` : '支持部分需要网页脚本解析的网站，安装后自动使用')}
        ${componentRow('ffmpeg', '视频处理工具', components?.ffmpegReady, components?.ffmpegReady ? `版本 ${escapeHtml(compactComponentVersion(components.ffmpegVersion))} · ${formatBytes(components.ffmpegBytes)}` : '合并音画、转 MP4、裁剪和提取音频')}
        </div></div></section>
      </div>
    </div>`;
}

function render() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    const current = button.dataset.view === state.view;
    button.classList.toggle('active', current);
    button.toggleAttribute('aria-current', current);
    if (current) button.setAttribute('aria-current', 'page');
  });
  count.textContent = state.items.length;
  const actionableTaskCount = state.jobs.filter((job) => taskMatchesFilter(job, 'active') || taskMatchesFilter(job, 'attention')).length
    + state.derivatives.filter((item) => taskMatchesFilter(item, 'active') || taskMatchesFilter(item, 'attention')).length;
  taskCount.textContent = actionableTaskCount;
  taskCount.hidden = actionableTaskCount === 0;
  if (state.view === 'inbox') renderInbox();
  else if (state.view === 'browser') renderBrowser();
  else if (state.view === 'tasks') renderTasks();
  else renderLibrary();
  enhanceSelects(main);
}

function interactionSelector(element) {
  if (!(element instanceof HTMLElement) || element === document.body) return null;
  if (element.id) return `#${CSS.escape(element.id)}`;
  if (element.tagName === 'SUMMARY') {
    const index = [...main.querySelectorAll('summary')].indexOf(element);
    if (index >= 0) return `@summary:${index}`;
  }
  for (const attribute of ['data-inbox-detail', 'data-download', 'data-resolve', 'data-pause-download', 'data-resume-download', 'data-cancel-download', 'data-retry-download', 'data-cancel-processing', 'data-retry-processing', 'data-action']) {
    if (element.hasAttribute(attribute)) return `[${attribute}="${CSS.escape(element.getAttribute(attribute))}"]`;
  }
  return null;
}

function renderPreservingInteraction() {
  const active = document.activeElement;
  const selector = interactionSelector(active);
  const selection = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? [active.selectionStart, active.selectionEnd] : null;
  const openDetails = [...main.querySelectorAll('details')].map((details, index) => details.open ? index : -1).filter((index) => index >= 0);
  const scrollPosition = [window.scrollX, window.scrollY];
  render();
  openDetails.forEach((index) => { const details = main.querySelectorAll('details')[index]; if (details) details.open = true; });
  if (selector) {
    const replacement = selector.startsWith('@summary:')
      ? main.querySelectorAll('summary')[Number(selector.slice(9))]
      : document.querySelector(selector);
    if (replacement instanceof HTMLElement && !replacement.hasAttribute('disabled')) {
      replacement.focus({ preventScroll: true });
      if (selection && 'setSelectionRange' in replacement && selection[0] != null && selection[1] != null) replacement.setSelectionRange(selection[0], selection[1]);
    }
  }
  window.scrollTo(...scrollPosition);
}

async function refreshSettingsState() {
  if (!invoke) return;
  const [bridge, components, auth] = await Promise.all([
    invoke('bridge_status').catch(() => null),
    invoke('component_status').catch(() => null),
    invoke('source_auth_status').catch(() => ({ configured: false })),
  ]);
  state.bridge = bridge;
  state.components = components;
  state.authConfigured = Boolean(auth?.configured);
  state.authBrowser = auth?.browser || null;
  state.authLoginOpen = Boolean(auth?.loginOpen);
}

async function refreshEditorState() {
  if (!invoke) return;
  const editors = await invoke('list_video_editors').catch(() => []);
  state.editor = Array.isArray(editors) ? editors.find((editor) => editor.id === 'jianying-pro' && editor.verified === true) || null : null;
}

async function refreshInbox({ quiet = false } = {}) {
  if (!invoke) {
    state.loading = false;
    render();
    if (!quiet) notify('请在 Tauri 桌面环境中运行此界面');
    return;
  }
  try {
    const wasLoading = state.loading;
    const previousItemIds = new Set(state.items.map((item) => item.id));
    const previousSnapshot = JSON.stringify([state.items, state.jobs, state.derivatives, state.projects]);
    const [items, jobs, derivatives, projects] = await Promise.all([invoke('list_inbox'), invoke('list_download_jobs'), invoke('list_media_derivatives'), invoke('list_projects')]);
    const dataChanged = previousSnapshot !== JSON.stringify([items, jobs, derivatives, projects]);
    const receivedItem = items.some((item) => !previousItemIds.has(item.id));
    state.items = items;
    state.jobs = jobs;
    state.derivatives = derivatives;
    state.projects = projects;
    if (preferences.defaultProject !== preferredProject()) {
      preferences.defaultProject = preferredProject();
      savePreferences();
    }
    state.loading = false;
    if (wasLoading) render();
    else if (dataChanged) renderPreservingInteraction();
    if (quiet && receivedItem) notify('已收到浏览器收集的页面');
  } catch (error) {
    const wasLoading = state.loading;
    state.loading = false;
    if (wasLoading) render();
    if (!quiet) notify(readableError(error));
  }
}

let refreshTimer = null;
function hasActiveWork() {
  return state.jobs.some((job) => ['queued', 'downloading'].includes(job.status))
    || state.derivatives.some((item) => ['queued', 'processing'].includes(item.status));
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  const relevantView = state.view === 'inbox' || state.view === 'tasks';
  const nextDelay = delay ?? (document.hidden || !relevantView ? 15_000 : hasActiveWork() ? 2_000 : 5_000);
  refreshTimer = setTimeout(async () => {
    if (!document.hidden && (state.view === 'inbox' || state.view === 'tasks')) await refreshInbox({ quiet: true });
    scheduleRefresh();
  }, nextDelay);
}

function openDialog() {
  formError.textContent = '';
  urlInput.value = '';
  projectInput.value = state.projectFilter === 'all' ? preferredProject() : state.projectFilter;
  renderProjectSuggestions();
  closeProjectSuggestions();
  updateLinkSummary();
  showModal(backdrop, urlInput);
}

function closeDialog() {
  if (linkImportInProgress) return;
  hideModal(backdrop);
  formError.textContent = '';
}

function closePlayer() {
  savePlayerPosition();
  mediaPlayer.pause();
  mediaPlayer.removeAttribute('src');
  mediaPlayer.querySelectorAll('track').forEach((track) => track.remove());
  mediaPlayer.load();
  activePlayerAsset = null;
  playerPositionKey = '';
  hideModal(playerBackdrop);
  playerError.textContent = '';
  playerStatus.hidden = true;
  playerConvert.hidden = true;
  playerConvert.disabled = false;
  playerConvert.textContent = '生成兼容副本';
}

async function openPlayer(assetType, assetId) {
  const asset = assetType === 'original'
    ? state.jobs.find((entry) => entry.id === assetId && entry.status === 'completed')
    : state.derivatives.find((entry) => entry.id === assetId && entry.status === 'completed');
  if (!asset?.filePath) return;
  activePlayerAsset = { assetType, assetId, video: !/\.(mp3|m4a|wav|flac|ogg)$/i.test(asset.filePath) };
  playerPositionKey = `clipcargo:position:${assetType}:${assetId}`;
  playerTitle.textContent = asset.title;
  playerError.textContent = '';
  playerStatus.hidden = false;
  playerStatus.textContent = '正在加载预览…';
  playerConvert.hidden = true;
  mediaPlayer.controls = true;
  mediaPlayer.querySelectorAll('track').forEach((track) => track.remove());
  mediaPlayer.src = window.__TAURI__.core.convertFileSrc(asset.filePath);
  showModal(playerBackdrop, mediaPlayer);
  try {
    const tracks = await invoke('get_media_subtitles', { assetType, assetId });
    tracks.forEach((item, index) => {
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.label = item.label;
      track.srclang = item.language;
      track.src = window.__TAURI__.core.convertFileSrc(item.path);
      track.default = index === 0;
      mediaPlayer.appendChild(track);
    });
  } catch (error) {
    playerError.textContent = `字幕未能加载：${readableError(error)}`;
  }
  mediaPlayer.load();
  mediaPlayer.play().catch(() => {});
}

function savePlayerPosition() {
  if (!playerPositionKey || !Number.isFinite(mediaPlayer.currentTime)) return;
  if (mediaPlayer.ended || mediaPlayer.currentTime < 1) localStorage.removeItem(playerPositionKey);
  else localStorage.setItem(playerPositionKey, String(mediaPlayer.currentTime));
}

function isPlayerShortcutTarget(element) {
  if (!(element instanceof Element)) return false;
  if (element.matches('input, textarea, select, button, video, [contenteditable="true"]')) return true;
  return Boolean(element.closest('[role="combobox"], [role="listbox"], [role="option"], [role="slider"]'));
}

function updateCropMask() {
  if (cropEditor.hidden || !cropPreview.videoWidth || !cropPreview.clientWidth) return;
  const width = cropPreview.clientWidth;
  const height = cropPreview.clientHeight;
  const zoom = Number(cropZoom.value) / 100;
  let cropWidth = Math.min(width, height * 9 / 16) / zoom;
  let cropHeight = cropWidth * 16 / 9;
  if (cropHeight > height / zoom) { cropHeight = height / zoom; cropWidth = cropHeight * 9 / 16; }
  const left = (width - cropWidth) * Number(cropX.value) / 100;
  const top = (height - cropHeight) * Number(cropY.value) / 100;
  cropMask.style.width = `${cropWidth}px`;
  cropMask.style.height = `${cropHeight}px`;
  cropMask.style.left = `${cropPreview.offsetLeft + left}px`;
  cropMask.style.top = `${cropPreview.offsetTop + top}px`;
  document.querySelector('#crop-zoom-value').value = `${cropZoom.value}%`;
  if (cropStatus) cropStatus.textContent = `位置：水平 ${Math.round(Number(cropX.value))}%，垂直 ${Math.round(Number(cropY.value))}% · 缩放 ${cropZoom.value}%`;
}

async function openProcess(jobId) {
  activeProcessJobId = jobId;
  selectProcessMode('convert');
  document.querySelector('#clip-range').hidden = true;
  const duration = state.jobs.find((job) => job.id === jobId)?.durationSeconds;
  const startInput = document.querySelector('#clip-start');
  const endInput = document.querySelector('#clip-end');
  document.querySelector('#clip-start-error').textContent = '';
  document.querySelector('#clip-end-error').textContent = '';
  startInput.removeAttribute('aria-invalid');
  endInput.removeAttribute('aria-invalid');
  startInput.value = '0';
  endInput.value = String(Number.isFinite(duration) && duration > 0 ? Math.min(10, duration) : 10);
  startInput.max = Number.isFinite(duration) && duration > 0 ? String(duration) : '';
  endInput.max = Number.isFinite(duration) && duration > 0 ? String(duration) : '';
  const durationNote = document.querySelector('#clip-duration');
  durationNote.textContent = Number.isFinite(duration) && duration > 0 ? `素材时长 ${formatDuration(duration)}` : '素材时长未知，处理前只校验时间顺序';
  durationNote.hidden = true;
  cropEditor.hidden = true;
  processBackdrop.querySelector('.process-dialog')?.classList.remove('crop-active');
  cropX.value = '50'; cropY.value = '50'; cropZoom.value = '100';
  cropPreview.pause(); cropPreview.removeAttribute('src'); cropPreview.load();
  if (invoke) state.components = await invoke('component_status').catch(() => state.components);
  const componentMissing = !state.components?.ffmpegReady;
  processError.textContent = componentMissing ? '开始处理前需要安装视频处理工具。' : '';
  document.querySelector('#process-component-action').hidden = !componentMissing;
  document.querySelector('#process-submit').disabled = componentMissing;
  showModal(processBackdrop, processMode);
  try {
    const path = await invoke('get_media_path', { assetType: 'original', assetId: jobId });
    if (activeProcessJobId === jobId) { cropPreview.src = window.__TAURI__.core.convertFileSrc(path); cropPreview.load(); }
  } catch (error) {
    const previewError = `预览未能加载：${readableError(error)}`;
    processError.textContent = processError.textContent ? `${processError.textContent} ${previewError}` : previewError;
  }
}

function selectProcessMode(mode) {
  processMode.value = mode;
  processBackdrop.querySelectorAll('[data-process-mode]').forEach((button) => {
    const selected = button.dataset.processMode === mode;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-checked', String(selected));
  });
  processMode.dispatchEvent(new Event('change'));
}

function validateClipInputs() {
  const startInput = document.querySelector('#clip-start');
  const endInput = document.querySelector('#clip-end');
  const startError = document.querySelector('#clip-start-error');
  const endError = document.querySelector('#clip-end-error');
  const start = startInput.valueAsNumber;
  const end = endInput.valueAsNumber;
  const duration = state.jobs.find((job) => job.id === activeProcessJobId)?.durationSeconds;
  startError.textContent = '';
  endError.textContent = '';
  startInput.removeAttribute('aria-invalid');
  endInput.removeAttribute('aria-invalid');
  if (!Number.isFinite(start) || start < 0) startError.textContent = '请输入不小于 0 的开始时间。';
  if (!Number.isFinite(end) || end <= 0) endError.textContent = '请输入大于 0 的结束时间。';
  else if (Number.isFinite(start) && end <= start) endError.textContent = '结束时间必须大于开始时间。';
  else if (Number.isFinite(duration) && end > duration + 0.05) endError.textContent = `不能超过素材时长 ${formatDuration(duration)}。`;
  if (startError.textContent) startInput.setAttribute('aria-invalid', 'true');
  if (endError.textContent) endInput.setAttribute('aria-invalid', 'true');
  return { valid: !startError.textContent && !endError.textContent, start, end };
}

function closeProcess() {
  activeProcessJobId = null;
  cropPreview.pause(); cropPreview.removeAttribute('src'); cropPreview.load();
  hideModal(processBackdrop);
  processError.textContent = '';
  document.querySelector('#process-component-action').hidden = true;
}

async function submitProcess() {
  if (activeProcessJobId == null) return;
  const mode = processMode.value;
  const clipRange = mode === 'clip' ? validateClipInputs() : null;
  const startSeconds = clipRange?.start ?? null;
  const endSeconds = clipRange?.end ?? null;
  const cropPositionX = mode === 'crop-vertical' ? Number(cropX.value) / 100 : null;
  const cropPositionY = mode === 'crop-vertical' ? Number(cropY.value) / 100 : null;
  const cropScale = mode === 'crop-vertical' ? Number(cropZoom.value) / 100 : null;
  if (mode === 'clip' && !clipRange.valid) { processError.textContent = '请修正标出的时间范围。'; return; }
  const submit = document.querySelector('#process-submit');
  let blockedByCapabilities = false;
  submit.disabled = true; submit.textContent = '处理中…';
  try {
    const result = await invoke('process_media', { input: { jobId: activeProcessJobId, mode, startSeconds, endSeconds, cropPositionX, cropPositionY, cropScale } });
    await refreshInbox();
    if (['queued', 'processing'].includes(result.status)) { closeProcess(); state.view = 'tasks'; render(); notify(result.status === 'queued' ? '处理任务已加入队列' : '处理任务已开始'); }
    else { processError.textContent = result.errorMessage || '处理任务未能启动。'; }
  } catch (error) {
    processError.textContent = readableError(error);
    blockedByCapabilities = /没有(?:音频|视频)轨/.test(processError.textContent);
  } finally {
    submit.disabled = blockedByCapabilities || !state.components?.ffmpegReady;
    submit.textContent = '开始处理';
  }
}

function openBatchMove() {
  if (!selectedInboxItems.size) return;
  batchMoveProject.innerHTML = state.projects.map((project) => `<option value="${escapeHtml(project.name)}">${escapeHtml(project.name)}</option>`).join('');
  batchMoveProject.value = state.projectFilter !== 'all' && state.projects.some((project) => project.name === state.projectFilter) ? state.projectFilter : '未分类';
  batchMoveError.textContent = '';
  showModal(batchMoveBackdrop, batchMoveProject);
}

function closeBatchMove() {
  batchMoveError.textContent = '';
  hideModal(batchMoveBackdrop);
}

async function submitBatchMove() {
  const ids = [...selectedInboxItems];
  const submit = document.querySelector('#batch-move-submit');
  if (!ids.length) return closeBatchMove();
  submit.disabled = true;
  submit.textContent = '正在移动…';
  try {
    const moved = await invoke('move_inbox_items', { ids, projectName: batchMoveProject.value });
    selectedInboxItems.clear();
    closeBatchMove();
    await refreshInbox();
    notify(`已移动 ${moved} 个条目`);
  } catch (error) { batchMoveError.textContent = readableError(error); }
  finally { submit.disabled = false; submit.textContent = '移动'; }
}

async function resolveSelected() {
  const ids = state.items.filter((item) => selectedInboxItems.has(item.id) && !['waiting_component', 'resolving', 'ready'].includes(item.status)).map((item) => item.id);
  if (!ids.length) return;
  let resolved = 0;
  const failures = [];
  for (const id of ids) {
    try { await invoke('resolve_inbox_item', { id }); resolved += 1; }
    catch (error) { failures.push(readableError(error)); }
  }
  await refreshInbox();
  notify(failures.length ? `已识别 ${resolved} 项，${failures.length} 项失败` : `已识别 ${resolved} 项`);
}

async function removeSelected() {
  const ids = state.items.filter((item) => selectedInboxItems.has(item.id) && !state.jobs.some((job) => job.itemId === item.id)).map((item) => item.id);
  if (!ids.length) return;
  const failures = [];
  let removed = 0;
  for (const id of ids) {
    try { await invoke('remove_inbox_item', { id }); selectedInboxItems.delete(id); removed += 1; }
    catch (error) { failures.push(readableError(error)); }
  }
  state.pendingBatchRemoval = false;
  await refreshInbox();
  notify(failures.length ? `已移除 ${removed} 项，${failures.length} 项失败` : `已移除 ${removed} 项`);
}

function updateDownloadPresetFields() {
  const audioOnly = downloadPreset.value === 'audio';
  const sourceOnly = downloadPreset.value === 'source';
  const packageMode = downloadPreset.value === 'package';
  const qualityControl = downloadQuality.closest('.custom-select') || downloadQuality;
  qualityControl.hidden = audioOnly;
  if (qualityControl === downloadQuality) downloadQuality.hidden = audioOnly;
  document.querySelector('#download-quality-label').hidden = audioOnly;
  document.querySelector('#download-quality-note').hidden = audioOnly;
  document.querySelector('#download-subtitles-row').hidden = audioOnly;
  document.querySelector('#download-quality-note').textContent = sourceOnly
    ? '保留平台提供的容器和编码；音画分离时仍可能进行合并封装。'
    : packageMode
      ? '一次生成兼容 MP4、MP3、字幕、封面和来源信息，并按视频、音频、图片、字幕归档到同一来源目录。'
      : '兼容 MP4 是最终保存格式。来源编码不兼容时才会转码。';
  if (audioOnly) downloadSubtitles.checked = false;
  if (packageMode) {
    downloadSubtitles.checked = true;
    downloadCover.checked = true;
    downloadSourceRecord.checked = true;
  }
  downloadSubtitles.disabled = packageMode;
  downloadCover.disabled = packageMode;
  downloadSourceRecord.disabled = packageMode;
  renderDownloadSubtitleOptions();
  downloadRetainSource.disabled = sourceOnly;
  document.querySelector('#download-retain-source-row').title = sourceOnly ? '来源格式本身就是最终文件，不会再复制一份' : '转码后仍保留下载到的原始格式文件';
  if (activeDownloadItemIds.length) {
    renderDownloadSummary();
    applyDownloadPreflight();
  }
}

function itemAvailableHeights(item) {
  const parsed = [...new Set((Array.isArray(item?.availableHeights) ? item.availableHeights : [])
    .map(Number).filter((height) => Number.isInteger(height) && height >= 144 && height <= 4320))]
    .sort((left, right) => right - left);
  if (parsed.length) return parsed;
  const legacyHeight = Number(item?.maxHeight);
  return Number.isInteger(legacyHeight) && legacyHeight >= 144 && legacyHeight <= 4320 ? [legacyHeight] : [];
}

function downloadHeightLabel(height) {
  const suffix = height >= 4320 ? ' · 8K' : height >= 2160 ? ' · 4K' : height >= 1440 ? ' · 2K' : '';
  return `${height}p${suffix}`;
}

function renderDownloadQualityOptions(items) {
  const heightLists = items.map(itemAvailableHeights);
  let heights = [];
  if (heightLists.length && heightLists.every((list) => list.length)) {
    const remaining = new Set(heightLists[0]);
    heightLists.slice(1).forEach((list) => {
      const current = new Set(list);
      [...remaining].forEach((height) => { if (!current.has(height)) remaining.delete(height); });
    });
    heights = [...remaining].sort((left, right) => right - left);
  }
  downloadQuality.innerHTML = [
    '<option value="best">最佳可用</option>',
    ...heights.map((height) => `<option value="${height}">${downloadHeightLabel(height)}</option>`),
  ].join('');
  const preferred = String(preferences.downloadQuality || 'best');
  if (preferred === 'best' || [...downloadQuality.options].some((option) => option.value === preferred)) {
    downloadQuality.value = preferred;
  } else if (heights.length) {
    const preferredHeight = Number(preferred);
    downloadQuality.value = String(heights.find((height) => !Number.isFinite(preferredHeight) || height <= preferredHeight) || heights[0]);
  } else {
    downloadQuality.value = 'best';
  }
  const qualityText = heights.length
    ? `当前真实可选 ${heights.map((height) => `${height}p`).join('、')}。`
    : '解析结果未提供可比较的清晰度清单，将使用来源的最佳可用版本。';
  document.querySelector('#download-quality-note').textContent = downloadPreset.value === 'package'
    ? `将生成兼容 MP4、MP3、字幕、封面和来源信息，并按类型整理到同一来源目录；${qualityText}`
    : `仅显示所选视频共同提供的清晰度；${qualityText}`;
}

function renderDownloadSubtitleOptions() {
  if (!downloadSubtitles.checked || downloadPreset.value === 'audio') {
    downloadSubtitleOptions.hidden = true;
    downloadSubtitleOptions.innerHTML = '';
    return;
  }
  const items = state.items.filter((item) => activeDownloadItemIds.includes(item.id));
  const languages = new Map();
  items.flatMap((item) => item.subtitleOptions || []).forEach((option) => {
    const current = languages.get(option.language) || { language: option.language, manual: false, automatic: false, count: 0 };
    current.manual ||= !option.automatic; current.automatic ||= Boolean(option.automatic); current.count += 1;
    languages.set(option.language, current);
  });
  const options = [...languages.values()];
  downloadSubtitleOptions.hidden = false;
  if (!options.length) {
    downloadSubtitleOptions.innerHTML = '<span class="inline-note">当前识别结果没有字幕；主文件仍可正常下载。</span>';
    return;
  }
  const preferredRank = options.some((option) => option.language.startsWith('zh')) ? 'zh' : options.some((option) => option.language.startsWith('en')) ? 'en' : options[0].language;
  downloadSubtitleOptions.innerHTML = `<strong>字幕轨道</strong><div>${options.map((option) => {
    const source = option.manual && option.automatic ? '人工 / 自动' : option.manual ? '人工' : '自动';
    const availability = items.length > 1 ? ` · ${option.count}/${items.length} 项` : '';
    return `<label><input type="checkbox" data-subtitle-language="${escapeHtml(option.language)}" ${option.language.startsWith(preferredRank) ? 'checked' : ''}><span>${escapeHtml(option.language)} <small>${source}${availability}</small></span></label>`;
  }).join('')}</div>`;
}

function previewDownloadName(item, preset) {
  const title = String(item?.title || '未命名内容')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/g, '').slice(0, 90) || '未命名内容';
  const extension = preset === 'audio' ? 'mp3' : ['video', 'package'].includes(preset) ? 'mp4' : '来源扩展名';
  const sourceId = String(item?.sourceId || '来源ID').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 128);
  return `${title} [${sourceId}].${extension}`;
}

function renderDownloadSummary() {
  const selectedItems = state.items.filter((item) => activeDownloadItemIds.includes(item.id));
  const selectedProjects = [...new Set(selectedItems.map((item) => item.projectName || '未分类'))];
  const projectText = selectedProjects.length <= 2 ? selectedProjects.join('、') : `${selectedProjects.slice(0, 2).join('、')}等 ${selectedProjects.length} 个项目`;
  const firstName = previewDownloadName(selectedItems[0], downloadPreset.value);
  const namingText = selectedItems.length > 1 ? `${firstName}（首项，共 ${selectedItems.length} 项）` : firstName;
  const estimates = selectedItems.map((item) => item.estimatedBytes);
  const estimatedBytes = estimates.length && estimates.every((value) => Number.isFinite(value) && value > 0)
    ? estimates.reduce((total, value) => total + value, 0) : null;
  const freeSpace = state.components?.storageFreeBytes == null ? '可用空间未知' : `${formatBytes(state.components.storageFreeBytes)} 可用`;
  const spaceText = estimatedBytes == null ? `${freeSpace} · 文件大小由来源决定` : `预计下载 ${formatBytes(estimatedBytes)} · ${freeSpace}`;
  downloadSummary.innerHTML = `<div class="download-summary-primary"><strong>${activeDownloadItemIds.length} 个视频${projectText ? ` · ${escapeHtml(projectText)}` : ''}</strong><span>每个来源单独整理 · ${escapeHtml(spaceText)}</span></div><details><summary>查看文件名和保存位置</summary><dl><div><dt>文件名</dt><dd title="${escapeHtml(namingText)}">${escapeHtml(namingText)}</dd></div><div><dt>位置</dt><dd title="${escapeHtml(state.components?.downloadsDirectory || '')}">${escapeHtml(state.components?.downloadsDirectory || 'ClipCargo 素材目录')}</dd></div></dl></details>`;
}

function downloadItemExceptions(item) {
  const issues = [];
  const preset = downloadPreset.value;
  if (preset === 'audio' && item.hasAudio === false) {
    issues.push({ blocking: true, message: '来源没有可下载的音轨' });
  } else if (preset === 'package' && item.hasAudio === false) {
    issues.push({ blocking: true, message: '来源没有音轨，无法生成包含 MP3 的完整素材包' });
  } else if (preset !== 'audio' && item.hasVideo === false) {
    issues.push({ blocking: true, message: '来源没有可下载的视频轨' });
  }
  if (preset !== 'audio' && downloadQuality.value !== 'best' && Number.isFinite(item.maxHeight)) {
    const limit = Number(downloadQuality.value);
    if (item.maxHeight < limit) issues.push({ blocking: false, message: `最高可用 ${item.maxHeight}p，不会放大到 ${limit}p` });
  }
  if (preset === 'video' && item.hasVideo !== false && item.compatibleMp4 === false) {
    issues.push({ blocking: false, message: '没有直接兼容的 H.264/AAC MP4，下载后需要转码' });
  }
  return issues;
}

function applyDownloadPreflight() {
  const selectedItems = state.items.filter((item) => activeDownloadItemIds.includes(item.id));
  const checks = selectedItems.map((item) => ({ item, issues: downloadItemExceptions(item) }));
  const rows = checks.flatMap(({ item, issues }) => issues.map((issue) => ({ item, ...issue })));
  const blocking = rows.filter((row) => row.blocking);
  const eligibleIds = checks.filter(({ issues }) => !issues.some((issue) => issue.blocking)).map(({ item }) => item.id);
  const continueAvailable = blocking.length > 0 && eligibleIds.length > 0;
  if (rows.length) {
    downloadExceptions.innerHTML = `<details ${blocking.length ? 'open' : ''}><summary>逐项检查 · ${blocking.length ? `${blocking.length} 项阻塞` : `${rows.length} 项提示`}</summary><div class="exception-list">${rows.map((row) => `<div class="exception-row"><div><strong>${escapeHtml(row.item.title)}</strong><small>${escapeHtml(row.message)}</small></div><span class="state-pill ${row.blocking ? 'warning' : 'neutral'}">${row.blocking ? '不可执行' : '将自动处理'}</span></div>`).join('')}</div>${continueAvailable ? `<div class="exception-actions"><span>可继续下载 ${eligibleIds.length} 项</span><button class="button compact" data-download-supported="${eligibleIds.join(',')}">仅下载可用项</button></div>` : ''}</details>`;
  } else {
    downloadExceptions.innerHTML = '<div class="preflight-ok">逐项检查通过</div>';
  }
  const missing = [];
  if (!state.components?.ytDlpReady) missing.push('下载引擎');
  if (!state.components?.ffmpegReady) missing.push('视频处理工具');
  const componentAction = document.querySelector('#download-component-action');
  const submit = document.querySelector('#download-submit');
  downloadError.textContent = missing.length
    ? `开始前需要安装：${missing.join('、')}。`
    : blocking.length ? `${blocking.length} 项内容不支持当前输出，请更改输出或返回重新识别。` : '';
  componentAction.hidden = !missing.length;
  submit.disabled = Boolean(missing.length || blocking.length);
}

downloadExceptions.addEventListener('click', (event) => {
  const button = event.target.closest('[data-download-supported]');
  if (!button) return;
  const eligibleIds = button.dataset.downloadSupported.split(',').map(Number).filter(Number.isFinite);
  const skipped = activeDownloadItemIds.length - eligibleIds.length;
  activeDownloadItemIds = eligibleIds;
  document.querySelector('#download-title').textContent = eligibleIds.length > 1 ? `准备下载 ${eligibleIds.length} 项` : '准备下载';
  renderDownloadSummary();
  applyDownloadPreflight();
  notify(`已排除 ${skipped} 个不可下载项目`);
});

async function openDownload(itemIds) {
  const downloadable = new Set(state.items.filter((item) => {
    const job = state.jobs.find((entry) => entry.itemId === item.id);
    return item.status === 'ready' && !['queued', 'downloading', 'completed'].includes(job?.status);
  }).map((item) => item.id));
  activeDownloadItemIds = (Array.isArray(itemIds) ? itemIds : [itemIds]).filter((id) => Number.isFinite(id) && downloadable.has(id));
  if (!activeDownloadItemIds.length) return;
  if (activeDownloadItemIds.length > 100) {
    activeDownloadItemIds = [];
    notify('单次最多准备 100 项，请缩小筛选范围或分批选择');
    return;
  }
  const selectedItems = state.items.filter((item) => activeDownloadItemIds.includes(item.id));
  document.querySelector('#download-title').textContent = activeDownloadItemIds.length > 1 ? `准备下载 ${activeDownloadItemIds.length} 项` : '准备下载';
  downloadPreset.value = preferences.downloadPreset;
  downloadSubtitles.checked = (preferences.saveSubtitles || preferences.downloadPreset === 'package') && preferences.downloadPreset !== 'audio';
  downloadCover.checked = preferences.downloadPreset === 'package';
  downloadSourceRecord.checked = true;
  downloadRetainSource.checked = true;
  updateDownloadPresetFields();
  renderDownloadQualityOptions(selectedItems);
  if (invoke) state.components = await invoke('component_status').catch(() => state.components);
  renderDownloadSummary();
  applyDownloadPreflight();
  showModal(downloadBackdrop, downloadQuality);
}

function closeDownload() {
  activeDownloadItemIds = [];
  document.querySelector('#download-title').textContent = '准备下载';
  downloadError.textContent = '';
  document.querySelector('#download-component-action').hidden = true;
  hideModal(downloadBackdrop);
}

async function submitDownload() {
  if (!activeDownloadItemIds.length) return;
  const ids = [...activeDownloadItemIds];
  const quality = downloadQuality.value;
  const outputPreset = downloadPreset.value;
  const saveSubtitles = downloadSubtitles.checked;
  const subtitleControls = [...downloadSubtitleOptions.querySelectorAll('[data-subtitle-language]')];
  const subtitleLanguages = subtitleControls.filter((input) => input.checked).map((input) => input.dataset.subtitleLanguage);
  if (saveSubtitles && subtitleControls.length && !subtitleLanguages.length) {
    downloadError.textContent = '请至少选择一条字幕语言，或关闭“保存字幕文件”。';
    return;
  }
  if (saveSubtitles && !subtitleControls.length) subtitleLanguages.push('zh.*', 'en.*');
  const saveCover = downloadCover.checked;
  const saveSourceRecord = downloadSourceRecord.checked;
  const retainSource = downloadRetainSource.checked;
  const submit = document.querySelector('#download-submit');
  submit.disabled = true;
  submit.textContent = '正在创建…';
  try {
    const failures = [];
    let started = 0;
    for (const id of ids) {
      try {
        await invoke('download_inbox_item', { id, quality, outputPreset, saveSubtitles, subtitleLanguages, saveCover, saveSourceRecord, retainSource, concurrencyLimit: preferences.downloadConcurrency });
        selectedInboxItems.delete(id);
        started += 1;
      } catch (error) { failures.push(readableError(error)); }
    }
    if (!started) { downloadError.textContent = failures[0] || '未能创建下载任务。'; return; }
    closeDownload();
    await refreshInbox();
    state.view = 'tasks';
    state.taskFilter = 'active';
    state.taskPage = 1;
    render();
    notify(failures.length ? `已创建 ${started} 个任务，${failures.length} 个未能启动` : `已创建 ${started} 个下载任务`);
  } catch (error) { downloadError.textContent = readableError(error); }
  finally { submit.disabled = false; submit.textContent = '开始下载'; }
}

async function importLinks() {
  if (linkImportInProgress) return;
  const analysis = updateLinkSummary();
  if (!analysis.lines.length) {
    formError.textContent = '请至少输入一个完整链接。';
    return;
  }
  if (analysis.overLimit) {
    formError.textContent = '单次最多导入 100 个链接，请分批处理。';
    return;
  }
  linkImportInProgress = true;
  importButton.disabled = true;
  importButton.setAttribute('aria-busy', 'true');
  dialogClose.disabled = true;
  dialogCancel.disabled = true;
  urlInput.disabled = true;
  projectInput.disabled = true;
  projectToggle.disabled = true;
  closeProjectSuggestions();
  const errors = [];
  let imported = 0;
  let duplicates = analysis.duplicates.length;
  const projectName = canonicalProjectName(projectInput.value);
  projectInput.value = projectName;
  try {
    for (const [index, entry] of analysis.valid.entries()) {
      importButton.textContent = `正在加入 ${index + 1}/${analysis.valid.length}…`;
      try {
        const result = await invoke('capture_page', { input: { pageUrl: entry.normalized, title: '', projectName, captureMethod: 'paste' } });
        if (result.duplicate) duplicates += 1;
        else imported += 1;
      } catch (error) {
        errors.push({ raw: entry.raw, message: readableError(error) });
      }
    }
    const rejected = [...analysis.invalid.map((entry) => entry.raw), ...analysis.duplicates.map((entry) => entry.raw), ...errors.map((entry) => entry.raw)];
    if (rejected.length) {
      urlInput.value = rejected.join('\n');
      await refreshInbox();
      const firstProblem = analysis.invalid[0]?.reason || errors[0]?.message || '重复链接未再次加入';
      formError.textContent = `已加入 ${imported} 条；重复 ${duplicates} 条；需修改 ${analysis.invalid.length + errors.length} 条。${firstProblem}`;
    } else {
      await refreshInbox();
      hideModal(backdrop);
      formError.textContent = '';
      notify(`已加入 ${imported} 条${duplicates ? `，忽略重复 ${duplicates} 条` : ''}`);
    }
  } catch (error) {
    formError.textContent = readableError(error);
  } finally {
    linkImportInProgress = false;
    importButton.removeAttribute('aria-busy');
    importButton.textContent = '加入收集箱';
    dialogClose.disabled = false;
    dialogCancel.disabled = false;
    urlInput.disabled = false;
    projectInput.disabled = false;
    projectToggle.disabled = false;
    if (!backdrop.hidden) updateLinkSummary();
  }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  button.closest('.media-more')?.removeAttribute('open');
  if (button.dataset.pageScope) {
    const amount = button.dataset.pageDirection === 'previous' ? -1 : 1;
    if (button.dataset.pageScope === 'inbox') state.inboxPage += amount;
    else if (button.dataset.pageScope === 'tasks') state.taskPage += amount;
    else state.libraryPage += amount;
    render();
    main.scrollIntoView({ block: 'start' });
  } else if (button.dataset.view) {
    state.view = button.dataset.view;
    localStorage.setItem('clipcargo:last-view', state.view);
    state.pendingInboxRemoval = null;
    render();
    if (state.view === 'browser' && invoke && !state.bridge) {
      await refreshSettingsState();
      render();
    }
    scheduleRefresh(0);
  } else if (button.dataset.libraryView) {
    state.libraryView = button.dataset.libraryView;
    state.librarySourceJob = null;
    state.libraryPage = 1;
    render();
  } else if (button.dataset.openLibraryProject) {
    state.libraryView = 'assets';
    state.librarySourceJob = Number(button.dataset.openLibraryProject);
    state.libraryPage = 1;
    render();
  } else if (button.dataset.openAssetPackage) {
    try { await invoke('open_asset_package', { jobId: Number(button.dataset.openAssetPackage) }); }
    catch (error) { notify(readableError(error)); }
  } else if (button.dataset.importPackageEditor) {
    button.disabled = true;
    try {
      const result = await invoke('import_asset_package_to_editor', { editorId: state.editor?.id, jobId: Number(button.dataset.importPackageEditor) });
      notify(`已将 ${result.importedCount} 个素材交给${result.editorName}`);
    } catch (error) { notify(readableError(error)); }
    finally { button.disabled = false; }
  } else if (button.dataset.importEditorId) {
    button.disabled = true;
    try {
      const result = await invoke('import_media_to_editor', { editorId: state.editor?.id, assetType: button.dataset.importEditorType, assetId: Number(button.dataset.importEditorId) });
      notify(`已将素材交给${result.editorName}`);
    } catch (error) { notify(readableError(error)); }
    finally { button.disabled = false; }
  } else if (button.dataset.filter) {
    state.filter = button.dataset.filter;
    state.inboxPage = 1;
    state.pendingInboxRemoval = null;
    state.pendingBatchRemoval = false;
    render();
  } else if (button.dataset.taskFilter) {
    state.taskFilter = button.dataset.taskFilter;
    state.taskPage = 1;
    render();
  } else if (button.dataset.action === 'open-add') {
    openDialog();
  } else if (button.dataset.action === 'download-selected') {
    await openDownload([...selectedInboxItems]);
  } else if (button.dataset.action === 'resolve-selected') {
    await resolveSelected();
  } else if (button.dataset.action === 'move-selected') {
    openBatchMove();
  } else if (button.dataset.action === 'remove-selected') {
    if (state.pendingBatchRemoval) await removeSelected();
    else { state.pendingBatchRemoval = true; render(); }
  } else if (button.dataset.action === 'manage-projects') {
    openProjectDialog();
  } else if (button.dataset.action === 'clear-library-search' || button.dataset.action === 'clear-library-filters') {
    state.libraryQuery = '';
    state.libraryProject = 'all';
    state.libraryKind = 'all';
    state.librarySourceJob = null;
    state.libraryPage = 1;
    render();
  } else if (button.dataset.action === 'download-components') {
    closeDownload();
    state.view = 'browser';
    localStorage.setItem('clipcargo:last-view', state.view);
    await refreshSettingsState();
    render();
  } else if (button.dataset.action === 'process-components') {
    closeProcess();
    state.view = 'browser';
    localStorage.setItem('clipcargo:last-view', state.view);
    await refreshSettingsState();
    render();
  } else if (button.dataset.action === 'choose-local-media') {
    try {
      const paths = await chooseMediaFiles(true);
      if (!paths.length) return;
      await openLocalImport(paths);
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.action === 'open-settings-section') {
    const targetId = button.dataset.settingsTarget;
    state.authRetryJobId = button.dataset.authJobId ? Number(button.dataset.authJobId) : null;
    state.view = 'browser';
    localStorage.setItem('clipcargo:last-view', state.view);
    render();
    const target = document.getElementById(targetId);
    target?.scrollIntoView({ block: 'center' });
    target?.focus({ preventScroll: true });
    if (invoke && !state.bridge) {
      await refreshSettingsState();
      render();
      const refreshedTarget = document.getElementById(targetId);
      refreshedTarget?.scrollIntoView({ block: 'center' });
      refreshedTarget?.focus({ preventScroll: true });
    }
  } else if (button.dataset.action === 'install-yt-dlp') {
    openComponentInstall('yt-dlp');
  } else if (button.dataset.action === 'install-ffmpeg') {
    openComponentInstall('ffmpeg');
  } else if (button.dataset.action === 'install-deno') {
    openComponentInstall('deno');
  } else if (button.dataset.action === 'cancel-active-component-install') {
    button.disabled = true;
    await cancelComponentInstall();
  } else if (button.dataset.action === 'dismiss-component-error') {
    componentInstallFailure = '';
    render();
  } else if (button.dataset.action === 'remove-component') {
    state.pendingComponentRemoval = button.dataset.componentKind;
    render();
  } else if (button.dataset.action === 'cancel-remove-component') {
    state.pendingComponentRemoval = null;
    render();
  } else if (button.dataset.action === 'confirm-remove-component') {
    const kind = button.dataset.componentKind;
    button.disabled = true;
    try {
      await invoke('remove_component', { kind });
      state.pendingComponentRemoval = null;
      state.components = await invoke('component_status');
      render();
      notify('工具已卸载，已保存的素材没有改变');
    } catch (error) { button.disabled = false; notify(readableError(error)); }
  } else if (button.dataset.action === 'open-source-login') {
    try {
      setButtonBusy(button, '正在打开登录窗口…');
      const result = await invoke('open_source_login', { browser: button.dataset.browser, jobId: state.authRetryJobId });
      state.authConfigured = Boolean(result.configured);
      state.authBrowser = result.browser || null;
      state.authLoginOpen = Boolean(result.loginOpen);
      render();
      notify('请在新窗口完成网站登录，然后回到 ClipCargo 确认');
    } catch (error) { clearButtonBusy(button); notify(readableError(error)); }
  } else if (button.dataset.action === 'finish-source-login') {
    try {
      setButtonBusy(button, '正在验证登录配置…');
      const result = await invoke('finish_source_login');
      state.authConfigured = Boolean(result.configured);
      state.authBrowser = result.browser || null;
      state.authLoginOpen = false;
      const retryJobId = state.authRetryJobId;
      state.authRetryJobId = null;
      if (retryJobId) {
        await invoke('retry_download', { jobId: retryJobId, concurrencyLimit: preferences.downloadConcurrency });
        state.view = 'tasks';
        await refreshInbox({ quiet: true });
      }
      render();
      notify(retryJobId ? '登录配置已保存，原任务已重新排队' : '登录配置已保存，遇到登录限制时会自动使用');
    } catch (error) { clearButtonBusy(button); notify(readableError(error)); }
  } else if (button.dataset.action === 'clear-source-browser') {
    try {
      const result = await invoke('set_source_browser', { browser: null });
      state.authConfigured = Boolean(result.configured);
      state.authBrowser = null;
      state.authLoginOpen = false;
      state.authRetryJobId = null;
      render();
      notify('已清除登录状态');
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.action === 'open-components') {
    try { await invoke('open_components_directory'); }
    catch (error) { notify(readableError(error)); }
  } else if (button.dataset.action === 'choose-components-directory') {
    try {
      setButtonBusy(button, '正在选择…');
      const directory = await chooseComponentsDirectory();
      if (!directory) { clearButtonBusy(button); return; }
      await invoke('set_components_directory', { directory });
      state.components = await invoke('component_status');
      render();
      notify('工具安装位置已更新');
    } catch (error) { clearButtonBusy(button); notify(readableError(error)); }
  } else if (button.dataset.action === 'open-downloads-directory') {
    try { await invoke('open_downloads_directory'); }
    catch (error) { notify(readableError(error)); }
  } else if (button.dataset.action === 'choose-downloads-directory') {
    try {
      const directory = await chooseDownloadDirectory();
      if (!directory) return;
      await invoke('set_downloads_directory', { directory });
      await refreshSettingsState();
      render();
      notify('新的下载和处理结果将保存到所选文件夹');
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.action === 'open-extension') {
    try { setButtonBusy(button, '正在打开…'); await invoke('open_extension_directory'); await refreshSettingsState(); render(); notify('本地扩展文件已打开'); }
    catch (error) { clearButtonBusy(button); notify(readableError(error)); }
  } else if (button.dataset.action === 'open-extension-store') {
    try { setButtonBusy(button, '正在打开商店…'); await invoke('open_extension_store'); clearButtonBusy(button); notify('已打开 Chrome 网上应用店'); }
    catch (error) { clearButtonBusy(button); notify(readableError(error)); }
  } else if (button.dataset.action === 'check-extension') {
    state.bridgeChecking = true;
    render();
    try {
      await Promise.all([
        refreshSettingsState(),
        new Promise((resolve) => setTimeout(resolve, 420)),
      ]);
      if (state.bridge?.extensionActive) notify('已检测到浏览器扩展正在运行');
      else if (state.bridge?.extensionVerified) notify('扩展已安装；打开浏览器后会自动恢复连接');
      else notify('尚未检测到扩展，请确认已在浏览器中加载并开启');
    } catch (error) { notify(readableError(error)); }
    finally { state.bridgeChecking = false; render(); }
  } else if (button.dataset.inboxDetail) {
    openInboxDetail(Number(button.dataset.inboxDetail));
  } else if (button.dataset.resolve) {
    const id = Number(button.dataset.resolve);
    const item = state.items.find((entry) => entry.id === id);
    if (item) item.status = 'resolving';
    render();
    try {
      await invoke('resolve_inbox_item', { id });
      await refreshInbox();
      notify('页面识别完成');
    } catch (error) {
      await refreshInbox();
      notify(readableError(error));
    }
  } else if (button.dataset.download) {
    await openDownload(Number(button.dataset.download));
  } else if (button.dataset.pauseDownload) {
    try {
      await invoke('pause_download', { jobId: Number(button.dataset.pauseDownload) });
      notify('正在暂停并保留可用断点');
      setTimeout(() => refreshInbox({ quiet: true }), 300);
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.resumeDownload) {
    button.disabled = true;
    try {
      await invoke('resume_download', { jobId: Number(button.dataset.resumeDownload), concurrencyLimit: preferences.downloadConcurrency });
      notify('已按原参数继续下载');
      await refreshInbox({ quiet: true });
    } catch (error) { notify(readableError(error)); button.disabled = false; }
  } else if (button.dataset.cancelDownload) {
    try {
      await invoke('cancel_download', { jobId: Number(button.dataset.cancelDownload) });
      notify('正在停止下载并保留可用断点');
      setTimeout(() => refreshInbox({ quiet: true }), 300);
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.retryDownload) {
    button.disabled = true;
    try {
      await invoke('retry_download', { jobId: Number(button.dataset.retryDownload), concurrencyLimit: preferences.downloadConcurrency });
      notify('已按原参数重新排队，并重新获取来源地址');
      await refreshInbox({ quiet: true });
    } catch (error) { notify(readableError(error)); button.disabled = false; }
  } else if (button.dataset.cancelProcessing) {
    try {
      await invoke('cancel_processing', { derivativeId: Number(button.dataset.cancelProcessing) });
      notify('正在取消处理');
      setTimeout(() => refreshInbox({ quiet: true }), 300);
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.retryProcessing) {
    button.disabled = true;
    try {
      await invoke('retry_processing', { derivativeId: Number(button.dataset.retryProcessing) });
      notify('已按原参数重新排队');
      state.view = 'tasks';
      await refreshInbox({ quiet: true });
    } catch (error) { notify(readableError(error)); button.disabled = false; }
  } else if (button.dataset.playId) {
    await openPlayer(button.dataset.playType, Number(button.dataset.playId));
  } else if (button.dataset.process) {
    openProcess(Number(button.dataset.process));
  } else if (button.dataset.revealId) {
    try { await invoke('reveal_media', { assetType: button.dataset.revealType, assetId: Number(button.dataset.revealId) }); }
    catch (error) { notify(readableError(error)); }
  } else if (button.dataset.copyId) {
    let filePath;
    try {
      filePath = await invoke('get_media_path', { assetType: button.dataset.copyType, assetId: Number(button.dataset.copyId) });
    } catch (error) { notify(readableError(error)); return; }
    try { await navigator.clipboard.writeText(filePath); notify('本地路径已复制'); }
    catch { notify('无法访问剪贴板，请使用“文件位置”'); }
  } else if (button.dataset.editLibraryId) {
    openMediaEdit(button.dataset.editLibraryType, Number(button.dataset.editLibraryId));
  } else if (button.dataset.relinkId) {
    button.disabled = true;
    const target = { assetType: button.dataset.relinkType, assetId: Number(button.dataset.relinkId) };
    try {
      const [path] = await chooseMediaFiles(false);
      if (!path) return;
      await invoke('relink_media', { assetType: target.assetType, assetId: target.assetId, path });
      await refreshInbox();
      notify('素材已重新定位并恢复');
    } catch (error) { notify(readableError(error)); }
    finally { button.disabled = false; }
  } else if (button.dataset.relinkDropId) {
    state.relinkTarget = { assetType: button.dataset.relinkDropType, assetId: Number(button.dataset.relinkDropId), externalReference: button.dataset.relinkDropReference === 'true' };
    dropOverlay.querySelector('strong').textContent = '拖入对应的本地媒体文件';
    dropOverlay.querySelector('span').textContent = state.relinkTarget.externalReference ? '只会更新外部引用路径，不会复制原文件；按 Esc 取消' : 'ClipCargo 会验证文件并复制到受管素材目录；按 Esc 取消';
    dropOverlay.hidden = false;
  } else if (button.dataset.removeLibraryId) {
    try {
      state.pendingLibraryImpact = await invoke('media_removal_impact', { assetType: button.dataset.removeLibraryType, assetId: Number(button.dataset.removeLibraryId) });
      state.pendingLibraryRemoval = `${button.dataset.removeLibraryType}:${button.dataset.removeLibraryId}`;
      render();
    } catch (error) { notify(readableError(error)); }
  } else if (button.hasAttribute('data-cancel-library-removal')) {
    state.pendingLibraryRemoval = null;
    state.pendingLibraryImpact = null;
    render();
  } else if (button.dataset.confirmLibraryRemovalId) {
    try {
      await invoke('remove_media_from_library', { assetType: button.dataset.confirmLibraryRemovalType, assetId: Number(button.dataset.confirmLibraryRemovalId) });
      state.pendingLibraryRemoval = null;
      state.pendingLibraryImpact = null;
      await refreshInbox();
      notify('已移出素材库，硬盘文件仍然保留');
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.trashLibraryId) {
    try {
      await invoke('trash_media', { assetType: button.dataset.trashLibraryType, assetId: Number(button.dataset.trashLibraryId) });
      state.pendingLibraryRemoval = null;
      state.pendingLibraryImpact = null;
      await refreshInbox();
      notify('文件已移到 Windows 回收站');
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.remove) {
    state.pendingInboxRemoval = Number(button.dataset.remove);
    render();
  } else if (button.hasAttribute('data-cancel-inbox-remove')) {
    state.pendingInboxRemoval = null;
    render();
  } else if (button.dataset.confirmInboxRemove) {
    try {
      await invoke('remove_inbox_item', { id: Number(button.dataset.confirmInboxRemove) });
      state.pendingInboxRemoval = null;
      await refreshInbox();
      notify('条目已从收集箱移除');
    } catch (error) { notify(readableError(error)); }
  } else if (button.dataset.openSource) {
    try { await invoke('open_source_page', { id: Number(button.dataset.openSource) }); }
    catch (error) { notify(readableError(error)); }
  }
});

main.addEventListener('keydown', (event) => {
  const current = event.target.closest('[role="tab"]');
  if (!current || !main.contains(current)) return;
  const tabs = [...current.closest('[role="tablist"]')?.querySelectorAll('[role="tab"]') || []];
  if (!tabs.length) return;
  const index = tabs.indexOf(current);
  let nextIndex = null;
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = tabs.length - 1;
  if (nextIndex == null) return;
  event.preventDefault();
  tabs[nextIndex].click();
  queueMicrotask(() => main.querySelector('[role="tab"][aria-selected="true"]')?.focus());
});

main.addEventListener('input', (event) => {
  if (event.target.id !== 'library-search') return;
  state.libraryQuery = event.target.value;
  state.libraryPage = 1;
  clearTimeout(librarySearchTimer);
  librarySearchTimer = setTimeout(() => {
    render();
    const search = document.querySelector('#library-search');
    if (search) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
  }, 150);
});
main.addEventListener('change', (event) => {
  if (event.target.matches('[data-select-item]')) {
    const id = Number(event.target.dataset.selectItem);
    if (event.target.checked) selectedInboxItems.add(id); else selectedInboxItems.delete(id);
    state.pendingBatchRemoval = false;
    render();
  } else if (event.target.matches('[data-select-visible]')) {
    const visibleIds = state.items.filter((item) => (state.filter === 'all' || item.status === state.filter)
      && (state.projectFilter === 'all' || item.projectName === state.projectFilter)).map((item) => item.id);
    if (event.target.checked) visibleIds.forEach((id) => selectedInboxItems.add(id));
    else visibleIds.forEach((id) => selectedInboxItems.delete(id));
    state.pendingBatchRemoval = false;
    render();
  } else if (event.target.id === 'library-sort') { state.librarySort = event.target.value; state.libraryPage = 1; render(); }
  else if (event.target.id === 'library-project') { state.libraryProject = event.target.value; state.libraryPage = 1; render(); }
  else if (event.target.id === 'library-kind') { state.libraryKind = event.target.value; state.libraryPage = 1; render(); }
  else if (event.target.id === 'library-search') { state.libraryQuery = event.target.value; state.libraryPage = 1; render(); }
  else if (event.target.id === 'project-filter') { state.projectFilter = event.target.value; state.inboxPage = 1; state.pendingInboxRemoval = null; state.pendingBatchRemoval = false; render(); }
  else if (event.target.id === 'setting-theme') { preferences.theme = event.target.value; savePreferences(); }
  else if (event.target.id === 'setting-default-project') { preferences.defaultProject = event.target.value; savePreferences(); }
  else if (event.target.id === 'setting-download-concurrency') { preferences.downloadConcurrency = Number(event.target.value); savePreferences(); }
  else if (event.target.id === 'setting-download-preset') { preferences.downloadPreset = event.target.value; savePreferences(); render(); }
  else if (event.target.id === 'setting-download-quality') { preferences.downloadQuality = event.target.value; savePreferences(); }
  else if (event.target.id === 'setting-save-subtitles') { preferences.saveSubtitles = event.target.checked; savePreferences(); }
});

document.querySelector('#dialog-close').addEventListener('click', closeDialog);
document.querySelector('#dialog-cancel').addEventListener('click', closeDialog);
document.querySelector('#import-button').addEventListener('click', importLinks);
urlInput.addEventListener('input', () => { formError.textContent = ''; updateLinkSummary(); });
function normalizeProjectInput() { projectInput.value = canonicalProjectName(projectInput.value); updateLinkSummary(); }
projectInput.addEventListener('focus', openProjectSuggestions);
projectInput.addEventListener('input', () => {
  formError.textContent = '';
  updateLinkSummary();
  if (!projectCombobox.classList.contains('open')) openProjectSuggestions();
  else renderProjectSuggestions(projectInput.value);
});
projectInput.addEventListener('keydown', (event) => {
  const options = [...projectSuggestionList.querySelectorAll('.project-option')];
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (!projectCombobox.classList.contains('open')) openProjectSuggestions();
    if (!options.length) return;
    projectActiveIndex = (projectActiveIndex + 1) % options.length;
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!projectCombobox.classList.contains('open')) openProjectSuggestions();
    if (!options.length) return;
    projectActiveIndex = (projectActiveIndex - 1 + options.length) % options.length;
  } else if (event.key === 'Enter' && projectCombobox.classList.contains('open') && projectActiveIndex >= 0) {
    event.preventDefault();
    chooseProjectSuggestion(options[projectActiveIndex].dataset.projectName);
    return;
  } else if (event.key === 'Escape') {
    closeProjectSuggestions();
    return;
  } else {
    return;
  }
  options.forEach((option, index) => option.classList.toggle('active', index === projectActiveIndex));
  const active = options[projectActiveIndex];
  if (active) projectInput.setAttribute('aria-activedescendant', active.id);
});
projectToggle.addEventListener('click', () => {
  if (projectCombobox.classList.contains('open')) closeProjectSuggestions();
  else { openProjectSuggestions(); projectInput.focus(); }
});
projectSuggestionList.addEventListener('mousedown', (event) => {
  const option = event.target.closest('.project-option');
  if (!option) return;
  event.preventDefault();
  chooseProjectSuggestion(option.dataset.projectName);
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('#project-combobox')) closeProjectSuggestions();
});
projectInput.addEventListener('blur', () => {
  setTimeout(() => {
    if (!projectCombobox.contains(document.activeElement)) {
      normalizeProjectInput();
      closeProjectSuggestions();
    }
  }, 0);
});
document.querySelector('#project-close').addEventListener('click', closeProjectDialog);
document.querySelector('#project-create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  projectError.textContent = '';
  if (!invoke) { projectError.textContent = '请在桌面应用中管理项目。'; return; }
  try {
    state.projects = await invoke('create_project', { name: newProjectName.value });
    newProjectName.value = '';
    renderProjectDialog();
    render();
  } catch (error) { projectError.textContent = readableError(error); }
});
projectList.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  projectError.textContent = '';
  if (button.dataset.projectEdit) {
    state.editingProject = button.dataset.projectEdit;
    state.pendingProjectDelete = null;
    renderProjectDialog();
    projectList.querySelector('[data-project-edit-input]')?.focus();
  } else if (button.dataset.projectDelete) {
    state.pendingProjectDelete = button.dataset.projectDelete;
    state.editingProject = null;
    renderProjectDialog();
  } else if (button.hasAttribute('data-project-cancel')) {
    state.editingProject = null;
    state.pendingProjectDelete = null;
    renderProjectDialog();
  } else if (button.dataset.projectSave) {
    const oldName = button.dataset.projectSave;
    const newName = projectList.querySelector('[data-project-edit-input]')?.value || '';
    try {
      state.projects = await invoke('rename_project', { oldName, newName });
      if (state.projectFilter === oldName) state.projectFilter = newName.trim();
      state.editingProject = null;
      renderProjectDialog();
      await refreshInbox({ quiet: true });
    } catch (error) { projectError.textContent = readableError(error); }
  } else if (button.dataset.projectConfirmDelete) {
    const name = button.dataset.projectConfirmDelete;
    try {
      state.projects = await invoke('delete_project', { name });
      if (state.projectFilter === name) state.projectFilter = '未分类';
      state.pendingProjectDelete = null;
      renderProjectDialog();
      await refreshInbox({ quiet: true });
    } catch (error) { projectError.textContent = readableError(error); }
  }
});
document.querySelector('#player-close').addEventListener('click', closePlayer);
document.querySelector('#playback-rate').addEventListener('change', (event) => { mediaPlayer.playbackRate = Number(event.target.value); });
document.querySelector('#external-player').addEventListener('click', async () => {
  if (activePlayerAsset == null) return;
  try { await invoke('open_media_external', activePlayerAsset); }
  catch (error) { playerError.textContent = readableError(error); }
});
playerConvert.addEventListener('click', async () => {
  if (activePlayerAsset?.assetType !== 'original' || !activePlayerAsset.video) return;
  playerConvert.disabled = true;
  playerConvert.textContent = '正在创建…';
  try {
    const result = await invoke('process_media', { input: { jobId: activePlayerAsset.assetId, mode: 'convert', startSeconds: null, endSeconds: null, cropPositionX: null, cropPositionY: null, cropScale: null } });
    if (!['queued', 'processing'].includes(result.status)) throw new Error(result.errorMessage || '兼容副本任务未能启动。');
    closePlayer();
    await refreshInbox();
    state.view = 'tasks';
    state.taskFilter = 'active';
    state.taskPage = 1;
    render();
    notify(result.status === 'queued' ? '兼容副本已加入队列' : '正在生成兼容副本');
  } catch (error) {
    playerError.textContent = readableError(error);
    playerConvert.disabled = false;
    playerConvert.textContent = '生成兼容副本';
  }
});
document.querySelector('#process-close').addEventListener('click', closeProcess);
document.querySelector('#process-cancel').addEventListener('click', closeProcess);
document.querySelector('#process-submit').addEventListener('click', submitProcess);
document.querySelector('#download-close').addEventListener('click', closeDownload);
document.querySelector('#download-cancel').addEventListener('click', closeDownload);
document.querySelector('#download-submit').addEventListener('click', submitDownload);
document.querySelector('#batch-move-close').addEventListener('click', closeBatchMove);
document.querySelector('#batch-move-cancel').addEventListener('click', closeBatchMove);
document.querySelector('#batch-move-submit').addEventListener('click', submitBatchMove);
document.querySelector('#media-edit-close').addEventListener('click', closeMediaEdit);
document.querySelector('#media-edit-cancel').addEventListener('click', closeMediaEdit);
document.querySelector('#media-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeMediaEdit) return;
  mediaEditError.textContent = '';
  try {
    await invoke('update_media_details', { ...activeMediaEdit, title: mediaEditName.value, projectName: mediaEditProject.value });
    closeMediaEdit();
    await refreshInbox({ quiet: true });
    notify('素材信息已保存');
  } catch (error) { mediaEditError.textContent = readableError(error); }
});
document.querySelector('#local-import-close').addEventListener('click', closeLocalImport);
document.querySelector('#local-import-cancel').addEventListener('click', closeLocalImport);
document.querySelector('#local-import-submit').addEventListener('click', submitLocalImport);
componentInstallClose.addEventListener('click', closeComponentInstall);
componentInstallCancel.addEventListener('click', cancelComponentInstall);
componentInstallConfirm.addEventListener('click', confirmComponentInstall);
document.querySelector('#inbox-detail-close').addEventListener('click', closeInboxDetail);
document.querySelector('#inbox-detail-cancel').addEventListener('click', closeInboxDetail);
document.querySelector('#inbox-detail-source').addEventListener('click', async () => {
  if (!activeInboxDetailId) return;
  try { await invoke('open_source_page', { id: activeInboxDetailId }); }
  catch (error) { inboxDetailError.textContent = readableError(error); }
});
document.querySelector('#inbox-detail-primary').addEventListener('click', async (event) => {
  const id = activeInboxDetailId;
  if (!id) return;
  const action = event.currentTarget.dataset.detailAction;
  if (action === 'download') { closeInboxDetail(); await openDownload(id); return; }
  if (action === 'components') { closeInboxDetail(); state.view = 'browser'; localStorage.setItem('clipcargo:last-view', state.view); render(); return; }
  if (action === 'library' || action === 'tasks') {
    closeInboxDetail(); state.view = action; localStorage.setItem('clipcargo:last-view', state.view); render(); return;
  }
  closeInboxDetail();
  const trigger = main.querySelector(`[data-resolve="${id}"]`);
  if (trigger) trigger.click();
});
document.querySelector('#inbox-detail-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!activeInboxDetailId) return;
  inboxDetailError.textContent = '';
  try {
    await invoke('update_inbox_details', { id: activeInboxDetailId, displayTitle: inboxDetailName.value, projectName: inboxDetailProject.value });
    await refreshInbox();
    closeInboxDetail();
    render();
    notify('条目详情已保存');
  } catch (error) { inboxDetailError.textContent = readableError(error); }
});
processBackdrop.querySelectorAll('[data-process-mode]').forEach((button) => {
  button.setAttribute('role', 'radio');
  button.addEventListener('click', () => selectProcessMode(button.dataset.processMode));
});
processMode.addEventListener('change', () => {
  const hidden = processMode.value !== 'clip';
  document.querySelector('#clip-range').hidden = hidden;
  document.querySelector('#clip-duration').hidden = hidden;
  cropEditor.hidden = processMode.value !== 'crop-vertical';
  processBackdrop.querySelector('.process-dialog')?.classList.toggle('crop-active', !cropEditor.hidden);
  const componentMissing = !state.components?.ffmpegReady;
  processError.textContent = componentMissing ? '开始处理前需要安装视频处理工具。' : '';
  document.querySelector('#process-component-action').hidden = !componentMissing;
  const clipInvalid = !hidden && !validateClipInputs().valid;
  document.querySelector('#process-submit').disabled = componentMissing || clipInvalid;
  if (!cropEditor.hidden) { cropPreview.currentTime = Math.min(cropPreview.duration || 0, 0.1); requestAnimationFrame(updateCropMask); }
});
['clip-start', 'clip-end'].forEach((id) => {
  const control = document.querySelector(`#${id}`);
  const syncClipState = () => {
    if (processMode.value !== 'clip') return;
    const result = validateClipInputs();
    if (result.valid && processError.textContent === '请修正标出的时间范围。') processError.textContent = '';
    document.querySelector('#process-submit').disabled = !state.components?.ffmpegReady || !result.valid;
  };
  control.addEventListener('input', syncClipState);
  control.addEventListener('change', syncClipState);
});
[cropX, cropY, cropZoom].forEach((control) => control.addEventListener('input', updateCropMask));
cropPreview.addEventListener('loadedmetadata', updateCropMask);
window.addEventListener('resize', updateCropMask);
cropMask.addEventListener('pointerdown', (event) => {
  cropDragging = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: Number(cropX.value), y: Number(cropY.value) };
  cropMask.setPointerCapture(event.pointerId);
  event.preventDefault();
});
cropMask.addEventListener('pointermove', (event) => {
  if (!cropDragging || cropDragging.pointerId !== event.pointerId) return;
  const availableX = Math.max(1, cropPreview.clientWidth - cropMask.offsetWidth);
  const availableY = Math.max(1, cropPreview.clientHeight - cropMask.offsetHeight);
  cropX.value = String(Math.max(0, Math.min(100, cropDragging.x + (event.clientX - cropDragging.startX) / availableX * 100)));
  cropY.value = String(Math.max(0, Math.min(100, cropDragging.y + (event.clientY - cropDragging.startY) / availableY * 100)));
  updateCropMask();
});
cropMask.addEventListener('pointerup', (event) => { if (cropDragging?.pointerId === event.pointerId) cropDragging = null; });
cropMask.addEventListener('pointercancel', () => { cropDragging = null; });
cropMask.addEventListener('keydown', (event) => {
  const delta = event.shiftKey ? 5 : 1;
  if (event.key === 'ArrowLeft') cropX.value = String(Math.max(0, Number(cropX.value) - delta));
  else if (event.key === 'ArrowRight') cropX.value = String(Math.min(100, Number(cropX.value) + delta));
  else if (event.key === 'ArrowUp') cropY.value = String(Math.max(0, Number(cropY.value) - delta));
  else if (event.key === 'ArrowDown') cropY.value = String(Math.min(100, Number(cropY.value) + delta));
  else return;
  event.preventDefault(); updateCropMask();
});
downloadPreset.addEventListener('change', updateDownloadPresetFields);
downloadSubtitles.addEventListener('change', renderDownloadSubtitleOptions);
downloadQuality.addEventListener('change', applyDownloadPreflight);
mediaPlayer.addEventListener('error', () => {
  playerStatus.hidden = true;
  mediaPlayer.pause();
  mediaPlayer.controls = false;
  playerError.textContent = activePlayerAsset?.assetType === 'original' && activePlayerAsset.video
    ? '当前环境无法预览此编码。可生成兼容副本，或使用系统播放器。'
    : '当前环境无法预览此编码，可使用系统播放器打开。';
  playerConvert.hidden = !(activePlayerAsset?.assetType === 'original' && activePlayerAsset.video);
});
mediaPlayer.addEventListener('loadedmetadata', () => {
  playerStatus.hidden = true;
  mediaPlayer.controls = true;
  const saved = Number(localStorage.getItem(playerPositionKey));
  if (Number.isFinite(saved) && saved > 0 && saved < mediaPlayer.duration - 2) mediaPlayer.currentTime = saved;
});
mediaPlayer.addEventListener('timeupdate', () => {
  if (Date.now() - lastPositionSavedAt < 2000) return;
  lastPositionSavedAt = Date.now();
  savePlayerPosition();
});
mediaPlayer.addEventListener('ended', savePlayerPosition);
backdrop.addEventListener('click', (event) => { if (event.target === backdrop) closeDialog(); });
projectBackdrop.addEventListener('click', (event) => { if (event.target === projectBackdrop) closeProjectDialog(); });
playerBackdrop.addEventListener('click', (event) => { if (event.target === playerBackdrop) closePlayer(); });
processBackdrop.addEventListener('click', (event) => { if (event.target === processBackdrop) closeProcess(); });
downloadBackdrop.addEventListener('click', (event) => { if (event.target === downloadBackdrop) closeDownload(); });
batchMoveBackdrop.addEventListener('click', (event) => { if (event.target === batchMoveBackdrop) closeBatchMove(); });
mediaEditBackdrop.addEventListener('click', (event) => { if (event.target === mediaEditBackdrop) closeMediaEdit(); });
inboxDetailBackdrop.addEventListener('click', (event) => { if (event.target === inboxDetailBackdrop) closeInboxDetail(); });
localImportBackdrop.addEventListener('click', (event) => { if (event.target === localImportBackdrop) closeLocalImport(); });
componentInstallBackdrop.addEventListener('click', (event) => { if (event.target === componentInstallBackdrop) closeComponentInstall(); });
document.addEventListener('click', (event) => {
  if (!event.target.closest('.custom-select')) closeCustomSelects();
  if (!event.target.closest('details.media-more')) closeActionMenus();
});
document.addEventListener('toggle', (event) => {
  if (event.target.matches?.('details.media-more') && event.target.open) closeActionMenus(event.target);
}, true);
document.addEventListener('keydown', (event) => {
  const modal = activeModal();
  if (event.key === 'Tab' && modal) { trapModalFocus(event, modal); return; }
  if (event.key === 'Escape') {
    const openActionMenus = document.querySelectorAll('details.media-more[open]');
    if (openActionMenus.length) { closeActionMenus(); return; }
    if (!playerBackdrop.hidden && document.fullscreenElement) return;
    if (state.relinkTarget) { state.relinkTarget = null; dropOverlay.hidden = true; } else if (!playerBackdrop.hidden) closePlayer(); else if (!processBackdrop.hidden) closeProcess(); else if (!downloadBackdrop.hidden) closeDownload(); else if (!inboxDetailBackdrop.hidden) closeInboxDetail(); else if (!localImportBackdrop.hidden) closeLocalImport(); else if (!componentInstallBackdrop.hidden) closeComponentInstall(); else if (!batchMoveBackdrop.hidden) closeBatchMove(); else if (!mediaEditBackdrop.hidden) closeMediaEdit(); else if (!projectBackdrop.hidden) closeProjectDialog(); else if (!backdrop.hidden) closeDialog(); else if (state.view === 'inbox' && selectedInboxItems.size) { selectedInboxItems.clear(); state.pendingBatchRemoval = false; render(); notify('已清除选择'); }
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a' && !modal && state.view === 'inbox' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName)) {
    event.preventDefault();
    visibleInboxItems().forEach((item) => selectedInboxItems.add(item.id));
    state.pendingBatchRemoval = false;
    render();
    notify(`已选择当前筛选的 ${visibleInboxItems().length} 项`);
    return;
  }
  // Native and custom controls must keep their own Space/arrow-key behavior.
  // Without this guard, choosing a playback rate or operating a focused button
  // can also pause or seek the video when the event bubbles to the document.
  if (playerBackdrop.hidden || isPlayerShortcutTarget(event.target)) return;
  if (event.key === ' ') { if (event.repeat) return; event.preventDefault(); mediaPlayer.paused ? mediaPlayer.play().catch(() => {}) : mediaPlayer.pause(); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); mediaPlayer.currentTime = Math.max(0, mediaPlayer.currentTime - 5); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); mediaPlayer.currentTime = Math.min(mediaPlayer.duration || Infinity, mediaPlayer.currentTime + 5); }
  else if (event.key.toLowerCase() === 'm') {
    if (event.repeat) return;
    event.preventDefault();
    mediaPlayer.muted = !mediaPlayer.muted;
    notify(mediaPlayer.muted ? '已静音' : '已恢复声音');
  }
});

async function initializeLocalDrop() {
  const current = window.__TAURI__?.webviewWindow?.getCurrentWebviewWindow?.();
  if (!current?.onDragDropEvent) return;
  await current.onDragDropEvent(async (event) => {
    const type = event.payload?.type;
    if (type === 'over') { dropOverlay.hidden = false; return; }
    if (type === 'leave') { if (!state.relinkTarget) dropOverlay.hidden = true; return; }
    if (type !== 'drop') return;
    dropOverlay.hidden = true;
    const paths = event.payload.paths || [];
    if (!paths.length) return;
    try {
      if (state.relinkTarget) {
        if (paths.length !== 1) throw new Error('重新定位时请只拖入一个媒体文件。');
        const target = state.relinkTarget;
        await invoke('relink_media', { assetType: target.assetType, assetId: target.assetId, path: paths[0] });
        state.relinkTarget = null;
        await refreshInbox();
        render();
        notify('素材已重新定位并恢复');
        return;
      }
      await openLocalImport(paths);
    } catch (error) { notify(readableError(error)); }
    finally {
      if (!state.relinkTarget) {
        dropOverlay.querySelector('strong').textContent = '释放以导入本地素材';
        dropOverlay.querySelector('span').textContent = '释放后选择复制到库或仅引用原文件';
        dropOverlay.hidden = true;
      }
    }
  });
}

render();
refreshInbox().finally(() => scheduleRefresh());
refreshEditorState().then(render);
if (state.view === 'browser') refreshSettingsState().then(render);
initializeLocalDrop().catch(() => {});
document.addEventListener('visibilitychange', () => scheduleRefresh(document.hidden ? 15_000 : 0));
