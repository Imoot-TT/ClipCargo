const harnessState = {
  items: [
    { id: 101, pageUrl: 'https://example.com/ready', title: '已识别演示视频', originalTitle: '平台原始标题', sourceHost: 'example.com', sourceId: 'demo-101', projectName: '未分类', status: 'ready', captureMethod: 'paste', createdAt: 1794210000, resolvedAt: 1794210060, durationSeconds: 42, thumbnailUrl: null, errorMessage: null, hasVideo: true, hasAudio: !new URLSearchParams(location.search).has('no-audio'), maxHeight: 720, availableHeights: [720, 480, 360], compatibleMp4: false, estimatedBytes: 26_214_400, subtitleOptions: [{ language: 'zh-Hans', automatic: false }, { language: 'en', automatic: true }] },
    { id: 102, pageUrl: 'https://example.com/captured', title: new URLSearchParams(location.search).has('mixed') ? '无音轨演示视频' : '待识别分享链接', sourceHost: 'example.com', sourceId: 'demo-102', projectName: '未分类', status: new URLSearchParams(location.search).has('mixed') ? 'ready' : 'captured', captureMethod: 'extension', createdAt: 1794209900, durationSeconds: new URLSearchParams(location.search).has('mixed') ? 30 : null, thumbnailUrl: null, errorMessage: null, hasVideo: new URLSearchParams(location.search).has('mixed') ? true : null, hasAudio: new URLSearchParams(location.search).has('mixed') ? false : null, maxHeight: new URLSearchParams(location.search).has('mixed') ? 1080 : null, availableHeights: new URLSearchParams(location.search).has('mixed') ? [1080, 720, 480] : [], compatibleMp4: new URLSearchParams(location.search).has('mixed') ? true : null, estimatedBytes: new URLSearchParams(location.search).has('mixed') ? 15_728_640 : null },
    { id: 103, pageUrl: 'https://example.com/failed', title: '识别失败示例', sourceHost: 'example.com', projectName: '客户项目', status: 'failed', captureMethod: 'paste', createdAt: 1794209800, durationSeconds: null, thumbnailUrl: null, errorMessage: '测试用识别失败' },
  ],
  jobs: [
    { id: 401, itemId: 999, title: '原片处理示例', sourceHost: 'example.com', projectName: '客户项目', quality: '1080', outputPreset: 'video', status: 'completed', progressPercent: 100, durationSeconds: 35, thumbnailUrl: null, filePath: 'C:\\ClipCargo\\原片处理示例.mp4', fileMissing: false, libraryHidden: false, updatedAt: 1794210200, errorMessage: null, warningMessage: new URLSearchParams(location.search).has('warning') ? '来源没有提供封面，主文件已正常下载。' : null, saveSubtitles: true, subtitleLanguages: ['zh-Hans'], saveCover: true, saveSourceRecord: true, retainSource: true, imageCount: 1, subtitleCount: 2 },
    ...(new URLSearchParams(location.search).has('active-tasks') ? [
      { id: 410, itemId: 101, title: '城市夜景素材', sourceHost: 'example.com', projectName: '未分类', quality: '1080', outputPreset: 'video', status: 'downloading', stage: 'downloading', progressPercent: 62, downloadedBytes: 65_011_712, totalBytes: 104_857_600, speedBytesPerSecond: 3_565_158, etaSeconds: 11, durationSeconds: 42, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210300, errorMessage: null, warningMessage: null, saveSubtitles: true, subtitleLanguages: ['zh-Hans'], saveCover: true, saveSourceRecord: true, retainSource: true },
      { id: 411, itemId: 102, title: '产品讲解长视频', sourceHost: 'example.com', projectName: '客户项目', quality: '720', outputPreset: 'source', status: 'queued', progressPercent: 0, durationSeconds: 120, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210290, errorMessage: null, warningMessage: null, saveSubtitles: false, subtitleLanguages: [], saveCover: false, saveSourceRecord: true, retainSource: true },
      { id: 412, itemId: 103, title: '登录后可见的课程片段', sourceHost: 'example.com', projectName: '客户项目', quality: 'audio', outputPreset: 'audio', status: 'failed', progressPercent: 18, durationSeconds: 80, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210280, errorMessage: '会话已过期，请更新凭据后重试。', errorCode: 'AUTH_REQUIRED', warningMessage: null, saveSubtitles: false, subtitleLanguages: [], saveCover: false, saveSourceRecord: true, retainSource: false },
    ] : []),
    ...(new URLSearchParams(location.search).has('missing-reference') ? [{ id: 402, itemId: 998, title: '已移动的外部素材', sourceHost: '本地文件', projectName: '客户项目', quality: 'local', outputPreset: 'source', status: 'completed', progressPercent: 100, durationSeconds: 20, thumbnailUrl: null, filePath: 'D:\\Videos\\missing.mp4', fileMissing: true, libraryHidden: false, managedFile: false, updatedAt: 1794210250, errorMessage: null }] : []),
    ...(new URLSearchParams(location.search).has('failed-download') ? [{ id: 420, itemId: 101, title: '已识别演示视频', sourceHost: 'example.com', projectName: '未分类', quality: '720', outputPreset: 'source', status: 'failed', progressPercent: 37, durationSeconds: 42, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210350, errorMessage: '网络连接中断或超时；有限重试仍未成功。网络恢复后可继续下载。', errorCode: 'NETWORK_UNREACHABLE', warningMessage: null, saveSubtitles: true, subtitleLanguages: ['en'], saveCover: true, saveSourceRecord: false, retainSource: false }] : []),
  ],
  derivatives: [{ id: 301, parentJobId: 401, title: '竖屏成片示例', projectName: '客户项目', sourceHost: 'example.com', kind: 'crop-vertical', status: 'completed', progressPercent: 100, durationSeconds: 18, thumbnailUrl: null, filePath: 'C:\\ClipCargo\\竖屏成片示例.mp4', fileMissing: false, libraryHidden: false, updatedAt: 1794210100, errorMessage: null },
    ...(new URLSearchParams(location.search).has('active-tasks') ? [
      { id: 310, jobId: 401, title: '原片处理示例', projectName: '客户项目', sourceHost: 'example.com', kind: 'crop-vertical', status: 'processing', progressPercent: 34, durationSeconds: 35, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210310, errorMessage: null },
      { id: 311, jobId: 401, title: '原片处理示例', projectName: '客户项目', sourceHost: 'example.com', kind: 'audio', status: 'queued', progressPercent: 0, durationSeconds: 35, thumbnailUrl: null, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210305, errorMessage: null },
    ] : []),
  ],
  projects: [
    { name: '未分类', isSystem: true, itemCount: 2 },
    { name: '客户项目', isSystem: false, itemCount: 1 },
  ],
  calls: [],
};
const componentsMissing = new URLSearchParams(location.search).has('missing-components');
const harnessStoreExtension = new URLSearchParams(location.search).has('store-extension');
let harnessYtDlpReady = !componentsMissing;
let harnessFfmpegReady = !componentsMissing;
let harnessInstallCancelled = false;
let harnessInstallPhase = 'idle';
let harnessInstallProgress = 0;
let harnessDenoReady = true;
let harnessBridgeRegistered = new URLSearchParams(location.search).has('bridge-connected');
let harnessExtensionVerified = new URLSearchParams(location.search).has('bridge-connected') || new URLSearchParams(location.search).has('bridge-active');
let harnessExtensionActive = new URLSearchParams(location.search).has('bridge-active');
const harnessBridgeHostInstalled = !new URLSearchParams(location.search).has('bridge-host-missing');
const harnessPollProgress = new URLSearchParams(location.search).has('poll-progress');
const harnessSlowBridge = new URLSearchParams(location.search).has('slow-bridge');
let harnessSourceBrowser = null;
let harnessSourceLoginOpen = false;
let harnessDownloadsDirectory = 'C:\\ClipCargo\\素材';
const harnessAuthBrowsers = [
  { id: 'chrome', label: 'Chrome', installed: true },
  { id: 'edge', label: 'Edge', installed: true },
  { id: 'firefox', label: 'Firefox', installed: false },
  { id: 'brave', label: 'Brave', installed: false },
  { id: 'vivaldi', label: 'Vivaldi', installed: false },
  { id: 'opera', label: 'Opera', installed: false },
  { id: 'chromium', label: 'Chromium', installed: false },
];

function clone(value) { return structuredClone(value); }
function recountProjects() {
  harnessState.projects.forEach((project) => { project.itemCount = harnessState.items.filter((item) => item.projectName === project.name).length; });
}

const largeDataValue = new URLSearchParams(location.search).get('large-data');
if (largeDataValue !== null) {
  const largeDataCount = largeDataValue === '10000' ? 10_000 : 123;
  for (let index = 0; index < largeDataCount; index += 1) {
    const itemId = 1000 + index;
    harnessState.items.push({ id: itemId, pageUrl: `https://example.com/library-${index}`, title: `批量测试素材 ${String(index + 1).padStart(3, '0')}`, sourceHost: 'example.com', sourceId: `bulk-${index}`, projectName: index % 3 ? '客户项目' : '未分类', status: 'ready', captureMethod: 'paste', createdAt: 1794200000 - index, resolvedAt: 1794200100 - index, durationSeconds: 20 + index, thumbnailUrl: null, errorMessage: null, hasVideo: true, hasAudio: true, maxHeight: 1080, compatibleMp4: true, estimatedBytes: 10_485_760 });
    harnessState.jobs.push({ id: 2000 + index, itemId, title: `批量测试素材 ${String(index + 1).padStart(3, '0')}`, sourceHost: 'example.com', projectName: index % 3 ? '客户项目' : '未分类', quality: '1080', outputPreset: 'video', status: 'completed', progressPercent: 100, durationSeconds: 20 + index, thumbnailUrl: null, filePath: `C:\\ClipCargo\\bulk-${index}.mp4`, fileMissing: false, libraryHidden: false, updatedAt: 1794200100 - index, errorMessage: null, warningMessage: null, saveSubtitles: false, subtitleLanguages: [], saveCover: false, saveSourceRecord: true, retainSource: true });
  }
  recountProjects();
}

window.__clipcargoHarness = harnessState;
window.__TAURI__ = {
  dialog: {
    open: async ({ multiple, directory }) => directory ? 'D:\\ClipCargo 下载' : multiple ? ['C:\\Videos\\本地样片.mp4'] : 'C:\\Videos\\已找回的素材.mp4',
  },
  core: {
    convertFileSrc() { return 'data:video/mp4;base64,'; },
    async invoke(command, args = {}) {
      harnessState.calls.push({ command, args: clone(args) });
      document.documentElement.dataset.harnessInvokeCount = String(harnessState.calls.length);
      document.documentElement.dataset.lastTauriInvoke = JSON.stringify({ command, args });
      if (command === 'download_inbox_item') document.documentElement.dataset.lastDownloadInvoke = JSON.stringify(args);
      if (command === 'list_inbox') return clone(harnessState.items);
      if (command === 'list_download_jobs') {
        if (harnessPollProgress) {
          const active = harnessState.jobs.find((entry) => entry.status === 'downloading');
          if (active) { active.progressPercent = Math.min(99, (active.progressPercent || 0) + 1); active.downloadedBytes = Math.round((active.totalBytes || 104_857_600) * active.progressPercent / 100); }
        }
        return clone(harnessState.jobs);
      }
      if (command === 'list_media_derivatives') return clone(harnessState.derivatives);
      if (command === 'list_projects') return clone(harnessState.projects);
      if (command === 'list_video_editors') return new URLSearchParams(location.search).has('no-editor') ? [] : [{ id: 'jianying-pro', name: '剪映专业版', verified: true }];
      if (command === 'import_media_to_editor') return { editorName: '剪映专业版', importedCount: 1 };
      if (command === 'import_asset_package_to_editor') return { editorName: '剪映专业版', importedCount: 4 };
      if (command === 'bridge_status') {
        if (harnessSlowBridge) await new Promise((resolve) => setTimeout(resolve, 700));
        return { hostName: 'net.clipcargo.native', queuePath: 'ClipCargo 队列', protocolVersion: 1, hostInstalled: harnessBridgeHostInstalled, registered: harnessBridgeRegistered, extensionId: harnessBridgeRegistered ? (harnessStoreExtension ? 'maenmnckhgckmkcaijmpeghkcfhchiha' : 'dpogajmenckmdbpacaoilnhhdcjpbheb') : null, extensionVerified: harnessExtensionVerified, extensionActive: harnessExtensionActive, extensionVersion: harnessExtensionVerified ? (harnessStoreExtension ? '0.1.6' : '0.1.0') : null, extensionPackageVersion: '0.1.0', debugBuild: !harnessStoreExtension, lastSeenAt: harnessExtensionVerified ? 1794210400 : null };
      }
      if (command === 'component_status') {
        const ytDlpBytes = harnessYtDlpReady ? 18_874_368 : 0;
        const ffmpegBytes = harnessFfmpegReady ? 188_743_680 : 0;
        const denoBytes = harnessDenoReady ? 92_274_688 : 0;
        return { ytDlpReady: harnessYtDlpReady, ytDlpVersion: harnessYtDlpReady ? '2026.10.26' : null, ytDlpBytes, ffmpegReady: harnessFfmpegReady, ffmpegVersion: harnessFfmpegReady ? '9.0.2' : null, ffmpegBytes, denoReady: harnessDenoReady, denoVersion: harnessDenoReady ? '2.x' : null, denoBytes, totalBytes: ytDlpBytes + ffmpegBytes + denoBytes, installing: harnessInstallPhase !== 'idle', installPhase: harnessInstallPhase, installProgressPercent: harnessInstallPhase === 'idle' ? null : harnessInstallProgress, storageFreeBytes: 10_737_418_240, componentDirectory: 'C:\\ClipCargo\\工具', downloadsDirectory: harnessDownloadsDirectory };
      }
      if (command === 'component_install_status') return { installing: harnessInstallPhase !== 'idle', installPhase: harnessInstallPhase, installProgressPercent: harnessInstallPhase === 'idle' ? null : harnessInstallProgress };
      if (command === 'install_yt_dlp') {
        harnessInstallCancelled = false;
        harnessInstallPhase = 'downloading';
        harnessInstallProgress = 0;
        const phaseFixture = new URLSearchParams(location.search).has('phase-install');
        if (new URLSearchParams(location.search).has('slow-install') || phaseFixture) {
          const steps = phaseFixture ? 8 : 100;
          for (let index = 0; index < steps && !harnessInstallCancelled; index += 1) { harnessInstallProgress = Math.round((index + 1) / steps * 90); await new Promise((resolve) => setTimeout(resolve, 50)); }
          if (harnessInstallCancelled) { harnessInstallPhase = 'idle'; throw new Error('工具安装已取消。'); }
        }
        harnessInstallPhase = 'verifying'; harnessInstallProgress = 93; await new Promise((resolve) => setTimeout(resolve, phaseFixture ? 600 : 250));
        harnessInstallPhase = 'installing'; harnessInstallProgress = 97; await new Promise((resolve) => setTimeout(resolve, phaseFixture ? 600 : 250));
        harnessInstallPhase = 'idle';
        harnessInstallProgress = 0;
        harnessYtDlpReady = true; return { component: 'yt-dlp', version: '2026.10.26', bytes: 18_000_000 };
      }
      if (command === 'install_ffmpeg') { harnessFfmpegReady = true; return { component: 'ffmpeg', version: '9.0.2', bytes: 110_000_000 }; }
      if (command === 'install_deno') { harnessDenoReady = true; return { component: 'deno', version: '2.x', bytes: 45_000_000 }; }
      if (command === 'cancel_component_install') { harnessInstallCancelled = true; return null; }
      if (command === 'remove_component') {
        if (new URLSearchParams(location.search).has('active-tasks')) throw new Error('有下载或处理任务正在运行或排队，请先完成或停止任务再卸载工具。');
        if (args.kind === 'yt-dlp') harnessYtDlpReady = false;
        else if (args.kind === 'ffmpeg') harnessFfmpegReady = false;
        else if (args.kind === 'deno') harnessDenoReady = false;
        else throw new Error('未知工具，未执行卸载。');
        return 3;
      }
      if (command === 'source_auth_status') return { configured: Boolean(harnessSourceBrowser), browser: harnessSourceBrowser, loginOpen: harnessSourceLoginOpen, browsers: clone(harnessAuthBrowsers) };
      if (command === 'open_source_login') { harnessSourceBrowser = args.browser; harnessSourceLoginOpen = true; return { configured: false, browser: harnessSourceBrowser, loginOpen: true, browsers: clone(harnessAuthBrowsers) }; }
      if (command === 'finish_source_login') { harnessSourceLoginOpen = false; return { configured: true, browser: harnessSourceBrowser, loginOpen: false, browsers: clone(harnessAuthBrowsers) }; }
      if (command === 'set_source_browser') { harnessSourceBrowser = null; harnessSourceLoginOpen = false; return { configured: false, browser: null, loginOpen: false, browsers: clone(harnessAuthBrowsers) }; }
      if (command === 'set_downloads_directory') { harnessDownloadsDirectory = args.directory; return harnessDownloadsDirectory; }
      if (command === 'set_components_directory') return args.directory;
      if (command === 'open_downloads_directory' || command === 'open_components_directory' || command === 'open_extension_store') return null;
      if (command === 'open_extension_directory') {
        if (!harnessBridgeHostInstalled) throw new Error('本地桥接程序未安装，当前构建不能连接浏览器扩展。');
        harnessBridgeRegistered = true;
        return 'C:\\ClipCargo\\browser-extension';
      }
      if (command === 'get_media_path') return 'C:\\ClipCargo\\原片处理示例.mp4';
      if (command === 'media_removal_impact') {
        const original = args.assetType === 'original';
        return { filePath: original ? 'C:\\ClipCargo\\原片处理示例.mp4' : 'C:\\ClipCargo\\竖屏成片示例.mp4', fileName: original ? '原片处理示例.mp4' : '竖屏成片示例.mp4', sizeBytes: original ? 52_428_800 : 18_874_368, referenceCount: original ? 2 : 1, managedFile: true };
      }
      if (command === 'inspect_local_media') {
        if (new URLSearchParams(location.search).has('invalid-local')) throw new Error('文件无法作为媒体读取：没有可识别的音频或视频轨。');
        return { count: args.paths.length, totalBytes: 52_428_800 };
      }
      if (command === 'capture_page') {
        if (new URLSearchParams(location.search).has('slow-capture')) await new Promise((resolve) => setTimeout(resolve, 700));
        const pageUrl = args.input.pageUrl;
        const projectName = args.input.projectName || '未分类';
        const existing = harnessState.items.find((entry) => entry.pageUrl === pageUrl && entry.projectName === projectName);
        if (existing) return { item: clone(existing), duplicate: true };
        const item = {
          id: Math.max(0, ...harnessState.items.map((entry) => entry.id)) + 1,
          pageUrl,
          title: new URL(pageUrl).hostname,
          sourceHost: new URL(pageUrl).hostname,
          projectName,
          status: 'captured',
          captureMethod: args.input.captureMethod || 'paste',
          createdAt: 1794210500,
          durationSeconds: null,
          thumbnailUrl: null,
          errorMessage: null,
        };
        harnessState.items.unshift(item);
        recountProjects();
        return { item: clone(item), duplicate: false };
      }
      if (command === 'resolve_inbox_item') {
        const item = harnessState.items.find((entry) => entry.id === args.id);
        if (!item) throw new Error('找不到条目');
        if (!harnessYtDlpReady) {
          item.status = 'waiting_component';
          item.errorMessage = '需要下载引擎才能识别；链接已保留，安装后可继续。';
          throw new Error(item.errorMessage);
        }
        item.status = 'ready'; item.errorMessage = null; item.durationSeconds = item.durationSeconds ?? 60;
        return clone(item);
      }
      if (command === 'move_inbox_items') {
        harnessState.items.filter((item) => args.ids.includes(item.id)).forEach((item) => { item.projectName = args.projectName; });
        recountProjects(); return args.ids.length;
      }
      if (command === 'update_inbox_details') {
        const item = harnessState.items.find((entry) => entry.id === args.id);
        if (!item) throw new Error('找不到条目');
        item.originalTitle ||= item.title; item.title = args.displayTitle.trim(); item.projectName = args.projectName;
        recountProjects(); return clone(item);
      }
      if (command === 'remove_inbox_item') {
        harnessState.items = harnessState.items.filter((item) => item.id !== args.id);
        recountProjects(); return null;
      }
      if (command === 'download_inbox_item') {
        const item = harnessState.items.find((entry) => entry.id === args.id);
        const existing = harnessState.jobs.find((entry) => entry.itemId === args.id);
        const job = existing || { id: 900 + harnessState.jobs.length, itemId: args.id, title: item.title, sourceHost: item.sourceHost };
        Object.assign(job, { quality: args.quality, outputPreset: args.outputPreset, saveSubtitles: args.saveSubtitles, subtitleLanguages: args.subtitleLanguages || [], saveCover: args.saveCover, saveSourceRecord: args.saveSourceRecord, retainSource: args.retainSource, status: 'queued', errorMessage: null });
        if (!existing) harnessState.jobs.push(job);
        if (args.outputPreset === 'package' && !harnessState.derivatives.some((entry) => entry.jobId === job.id && entry.kind === 'audio')) {
          harnessState.derivatives.push({ id: 990 + harnessState.derivatives.length, jobId: job.id, title: item.title, projectName: item.projectName, sourceHost: item.sourceHost, kind: 'audio', status: 'queued', progressPercent: 0, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210500, errorMessage: null });
        }
        return clone(job);
      }
      if (command === 'retry_download') {
        const job = harnessState.jobs.find((entry) => entry.id === args.jobId && entry.status === 'failed');
        if (!job) throw new Error('只能重试失败的下载任务。');
        job.status = 'queued'; job.progressPercent = 0; job.errorMessage = null; job.errorCode = null;
        return clone(job);
      }
      if (command === 'resume_download') {
        const job = harnessState.jobs.find((entry) => entry.id === args.jobId && entry.status === 'paused');
        if (!job) throw new Error('只能继续已暂停的下载任务。');
        job.status = 'queued'; job.progressPercent = 0; job.errorMessage = null; job.errorCode = null;
        document.documentElement.dataset.lastResumeInvoke = JSON.stringify(args);
        return clone(job);
      }
      if (command === 'pause_download') {
        const job = harnessState.jobs.find((entry) => entry.id === args.jobId && entry.status === 'downloading');
        if (!job) throw new Error('只有正在下载的任务可以暂停。');
        job.status = 'paused'; return null;
      }
      if (command === 'cancel_download') {
        const job = harnessState.jobs.find((entry) => entry.id === args.jobId && ['queued', 'downloading'].includes(entry.status));
        if (!job) throw new Error('该下载任务当前未运行或排队。');
        job.status = 'failed'; job.errorMessage = '下载已停止；已保留可用断点。'; job.errorCode = 'CANCELLED_BY_USER'; return null;
      }
      if (command === 'process_media') {
        if (new URLSearchParams(location.search).has('process-no-audio') && args.input?.mode === 'audio') {
          throw new Error('该素材没有音频轨，无法提取 MP3。');
        }
        const derivative = { id: 980 + harnessState.derivatives.length, jobId: args.input.jobId, title: '原片处理示例', projectName: '客户项目', kind: args.input.mode, status: 'queued', progressPercent: 0, filePath: null, fileMissing: false, libraryHidden: false, updatedAt: 1794210400, errorMessage: null };
        harnessState.derivatives.push(derivative); return clone(derivative);
      }
      if (command === 'cancel_processing') {
        const derivative = harnessState.derivatives.find((entry) => entry.id === args.derivativeId && ['queued', 'processing'].includes(entry.status));
        if (!derivative) throw new Error('该处理任务当前未运行或排队。');
        derivative.status = 'failed'; derivative.errorMessage = '处理任务已取消。'; derivative.errorCode = 'CANCELLED_BY_USER';
        return null;
      }
      if (command === 'retry_processing') {
        const derivative = harnessState.derivatives.find((entry) => entry.id === args.derivativeId && entry.status === 'failed');
        if (!derivative) throw new Error('只能重试失败的处理任务。');
        derivative.status = 'queued'; derivative.progressPercent = 0; derivative.errorMessage = null; derivative.errorCode = null;
        return clone(derivative);
      }
      if (command === 'import_local_media') {
        const managedFile = args.importMode !== 'reference';
        const job = { id: 950 + harnessState.jobs.length, itemId: 800 + harnessState.jobs.length, title: '本地样片', sourceHost: '本地文件', projectName: args.projectName, quality: 'local', outputPreset: 'source', status: 'completed', progressPercent: 100, filePath: managedFile ? 'C:\\ClipCargo\\本地样片.mp4' : args.paths[0], fileMissing: false, libraryHidden: false, managedFile, updatedAt: 1794210300 };
        harnessState.jobs.push(job); return [clone(job)];
      }
      if (command === 'relink_media') {
        const source = args.assetType === 'original' ? harnessState.jobs : harnessState.derivatives;
        const asset = source.find((entry) => entry.id === args.assetId);
        if (!asset) throw new Error('找不到需要重新定位的素材。');
        asset.filePath = args.path;
        asset.fileMissing = false;
        return null;
      }
      throw new Error(`UI 测试未模拟命令：${command}`);
    },
  },
};
