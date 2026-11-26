import { existsSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Extension must use Manifest V3');
for (const permission of ['activeTab', 'contextMenus', 'nativeMessaging', 'scripting', 'storage']) {
  if (!manifest.permissions.includes(permission)) throw new Error(`Missing extension permission: ${permission}`);
}
for (const forbidden of ['history', 'cookies', 'webRequest', '<all_urls>']) {
  if (JSON.stringify(manifest).includes(forbidden)) throw new Error(`Overbroad extension permission: ${forbidden}`);
}
if (!manifest.key) throw new Error('Bundled extension must have a stable development ID');
const keyHash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest().subarray(0, 16);
const bundledExtensionId = [...keyHash].map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))).join('');
if (bundledExtensionId !== 'dpogajmenckmdbpacaoilnhhdcjpbheb') throw new Error(`Unexpected bundled extension ID: ${bundledExtensionId}`);

const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
const rust = readFileSync(new URL('../src-tauri/src/main.rs', import.meta.url), 'utf8');
const nativeHost = readFileSync(new URL('../src-tauri/src/bin/native_host.rs', import.meta.url), 'utf8');
for (const match of app.matchAll(/icon\('([^']+)'/g)) {
  const iconName = match[1];
  if (!existsSync(new URL(`../src/assets/icons/${iconName}.svg`, import.meta.url))) throw new Error(`Missing UI icon asset: ${iconName}.svg`);
}
if (!styles.includes('[hidden] { display: none !important; }')) throw new Error('Author styles must not override the HTML hidden attribute');
for (const actionMenuMarker of ['function closeActionMenus(', "document.addEventListener('toggle'", "details.media-more[open]", '<summary class="icon-button" aria-label="更多操作" title="更多操作">']) {
  if (!app.includes(actionMenuMarker)) throw new Error(`Action menu behavior is incomplete: ${actionMenuMarker}`);
}
if (html.includes('class="topbar"') || html.includes('class="brand"') || html.includes('class="sidebar-bottom"')) throw new Error('Redundant in-app branding chrome returned');
for (const source of [html, app]) {
  for (const match of source.matchAll(/<(?:button|summary)[^>]*class="[^"]*icon-button[^"]*"[^>]*>/g)) {
    if (!match[0].includes('aria-label=') || !match[0].includes('title=')) throw new Error(`Icon-only control lacks a label or hover title: ${match[0]}`);
  }
}
if (app.includes('<h2>窗口与任务</h2>') || app.includes('<summary>技术信息</summary>')) throw new Error('Non-actionable settings explanations returned');
for (const marker of ['.workspace { height: 100%; min-height: 0;', '.nav-item { min-height: 40px;', '.button { min-height: 32px;', '.inbox-row { min-height: 66px;', '.setting-icon { display: none;']) {
  if (!styles.includes(marker)) throw new Error(`Compact desktop density is incomplete: ${marker}`);
}
if (!app.includes('compactComponentVersion') || !rust.includes('path_is_within_root')) throw new Error('Settings version cleanup or Windows media-path compatibility is incomplete');
if (!app.includes("item.kind !== 'source'") || !rust.includes("library_hidden=1")) throw new Error('Retained source backups must stay out of the primary media grid');
for (const marker of ['body { width: 100%; height: 100%; margin: 0; overflow: hidden;', 'overflow: auto; overscroll-behavior: contain; scrollbar-gutter: stable;', '.settings-column', '.custom-select-menu', 'top: calc(100% + 6px)', 'box-shadow: inset 0 0 0 1px var(--accent)', '.custom-select-option.selected::before']) {
  if (!styles.includes(marker)) throw new Error(`Settings layout/select refinement is incomplete: ${marker}`);
}
for (const marker of ['function enhanceSelects(root = document)', "root.querySelectorAll('select')", "setAttribute('role', 'combobox')", "setAttribute('role', 'listbox')", "event.key === 'Escape'", 'enhanceSelects(main);', 'enhanceSelects(modal);']) {
  if (!app.includes(marker)) throw new Error(`Accessible custom select behavior is incomplete: ${marker}`);
}
for (const marker of ['max-height: calc(100vh - 32px)', 'textarea { width: 100%; min-height: 112px;', 'resize: none;', '@media (max-height: 600px)']) {
  if (!styles.includes(marker)) throw new Error(`Short-window modal protection is incomplete: ${marker}`);
}
if (!styles.includes('--muted: light-dark(#626873, #a8acb5)')) throw new Error('Muted text contrast regression');
if (!app.includes('function readableError(error)') || app.includes('String(error)')) throw new Error('User-facing errors must not expose raw Error prefixes');
for (const command of ['list_inbox', 'capture_page', 'remove_inbox_item', 'move_inbox_items', 'update_inbox_details', 'inspect_local_media', 'import_local_media', 'bridge_status', 'open_components_directory', 'set_components_directory', 'open_extension_directory', 'open_extension_store']) {
  if (!app.includes(`'${command}'`)) throw new Error(`Frontend does not call ${command}`);
}
for (const importModeMarker of ['local-import-backdrop', '仅引用原文件', 'importMode', 'managed_file', 'managedFile', '外部引用']) {
  if (!`${html}\n${app}\n${rust}`.includes(importModeMarker)) throw new Error(`Local copy/reference import is incomplete: ${importModeMarker}`);
}
for (const importSafetyMarker of ['fn copy_local_media_atomically', '.importing', '.transaction()', '提交本地导入事务失败', 'rolls_back_an_entire_local_import_batch', 'copy_local_media_atomically(&source, &destination, bytes)']) {
  if (!rust.includes(importSafetyMarker)) throw new Error(`Atomic local import is incomplete: ${importSafetyMarker}`);
}
for (const localProbeMarker of ['validate_local_media_with_probe', '文件无法作为媒体读取', '文件没有可识别的音频或视频轨', 'for path in &paths']) {
  if (!rust.includes(localProbeMarker)) throw new Error(`Local media probe validation is incomplete: ${localProbeMarker}`);
}
for (const relinkModeMarker of ['data-relink-reference', 'externalReference', '只会更新外部引用路径', "AND managed_file=0"]) {
  if (!`${app}\n${rust}`.includes(relinkModeMarker)) throw new Error(`External-reference relink does not preserve ownership: ${relinkModeMarker}`);
}
for (const relinkPickerMarker of ['openNativeFileDialog', 'chooseMediaFiles(false)', "invoke('relink_media'", '拖入文件定位', 'tauri_plugin_dialog::init()']) {
  if (!`${app}\n${rust}`.includes(relinkPickerMarker)) throw new Error(`Missing-media relink picker is incomplete: ${relinkPickerMarker}`);
}
for (const menuLabel of ['aria-label="拖入文件定位"', 'aria-label="编辑信息"', 'aria-label="打开文件位置"', 'aria-label="复制文件路径"', 'aria-label="从素材库移除"']) {
  if (!app.includes(menuLabel)) throw new Error(`Library overflow action is missing an accessible name: ${menuLabel}`);
}
for (const detailMarker of ['data-inbox-detail', 'inbox-detail-backdrop', 'originalTitle', 'resolvedAt', 'update_inbox_details', 'display_title']) {
  if (!`${html}\n${app}\n${rust}`.includes(detailMarker)) throw new Error(`Inbox detail flow is incomplete: ${detailMarker}`);
}
for (const batchMarker of ['selectedInboxItems', 'data-select-visible', "data-action=\"download-selected\"", 'activeDownloadItemIds']) {
  if (!app.includes(batchMarker)) throw new Error(`Inbox batch download is incomplete: ${batchMarker}`);
}
if (!app.includes('for (const id of ids)')) throw new Error('Batch download does not submit every selected item');
for (const batchAction of ['resolve-selected', 'move-selected', 'remove-selected', 'download-selected']) {
  if (!app.includes(batchAction)) throw new Error(`Inbox batch action is missing: ${batchAction}`);
}
for (const linkImportMarker of ['linkImportInProgress', "importButton.setAttribute('aria-busy', 'true')", '正在加入 ${index + 1}/${analysis.valid.length}', 'dialogClose.disabled = true', 'urlInput.disabled = true', 'if (linkImportInProgress) return']) {
  if (!app.includes(linkImportMarker)) throw new Error(`Link import submission locking is incomplete: ${linkImportMarker}`);
}
for (const paginationMarker of ['INBOX_PAGE_SIZE = 50', 'TASK_PAGE_SIZE = 50', 'LIBRARY_PAGE_SIZE = 48', 'data-page-scope', "pagination('tasks'", 'pageAssets', '选择筛选结果', 'librarySearchTimer', 'jobsByItemId']) {
  if (!app.includes(paginationMarker)) throw new Error(`Large-data pagination is incomplete: ${paginationMarker}`);
}
if (!app.includes("main.scrollIntoView({ block: 'start' })")) throw new Error('Pagination must return the new page to the visible start');
for (const libraryMenuMarker of ['media-more-menu', '<summary class="icon-button" aria-label="更多操作" title="更多操作">']) {
  if (!app.includes(libraryMenuMarker)) throw new Error(`Library action menu is incomplete: ${libraryMenuMarker}`);
}
for (const thumbnailMarker of ['cover_data_url', "main.querySelectorAll('.media-thumb img')", "image.addEventListener('error', () => image.remove()"] ) {
  if (!app.includes(thumbnailMarker) && !rust.includes(thumbnailMarker)) throw new Error(`Thumbnail fallback is incomplete: ${thumbnailMarker}`);
}
for (const inboxRowMarker of ['<summary class="icon-button" aria-label="更多操作" title="更多操作">', 'inboxErrorLabel(item.errorMessage, item.errorCode)', '重新识别']) {
  if (!app.includes(inboxRowMarker)) throw new Error(`Inbox row cleanup is incomplete: ${inboxRowMarker}`);
}
if (app.includes("icon(item.captureMethod === 'local-import' ? 'file-video' : 'globe-2')")) throw new Error('Inbox rows still repeat a decorative source icon');
for (const inboxStatusMarker of ['function inboxDisplayStatus', "item.status === 'ready' && job", 'const displayStatus = inboxDisplayStatus(item, job)', 'inboxDisplayStatus(item, job).label']) {
  if (!app.includes(inboxStatusMarker)) throw new Error(`Inbox stage status semantics are incomplete: ${inboxStatusMarker}`);
}
if (!app.includes('role="tab" aria-selected="${state.taskFilter')) throw new Error('Task filters are missing tab semantics');
for (const taskGroupingMarker of ['function taskMatchesFilter', "filter === 'attention'", "!userCancelled(item)", "['active', '进行中']", "['attention', '需处理']", "['history', '历史']"]) {
  if (!app.includes(taskGroupingMarker)) throw new Error(`Task status grouping is incomplete: ${taskGroupingMarker}`);
}
for (const taskCountMarker of ["taskMatchesFilter(job, 'attention')", 'ClipCargoJobModel', 'unifiedJobs', 'taskCount.hidden = actionableTaskCount === 0']) {
  if (!app.includes(taskCountMarker)) throw new Error(`Task navigation count misses actionable failures: ${taskCountMarker}`);
}
for (const recoveryRouteMarker of ['function taskRecoveryButton', "code === 'AUTH_REQUIRED'", 'data-settings-target="auth-settings"', "code === 'COMPONENT_MISSING'", 'data-settings-target="components-settings"', "button.dataset.action === 'open-settings-section'", 'target?.focus({ preventScroll: true })']) {
  if (!app.includes(recoveryRouteMarker)) throw new Error(`Task recovery routing is incomplete: ${recoveryRouteMarker}`);
}
if (app.includes('在设置中更换保存目录')) throw new Error('Disk-full guidance advertises a save-directory setting that does not exist');
for (const keyboardTabMarker of ['tabindex="${state.taskFilter', "event.key === 'ArrowRight'", "event.key === 'ArrowLeft'", "event.key === 'Home'", "event.key === 'End'", "aria-current', 'page'"]) {
  if (!app.includes(keyboardTabMarker)) throw new Error(`Keyboard tab/navigation semantics are incomplete: ${keyboardTabMarker}`);
}
if (!app.includes('document.documentElement.dataset.theme = preferences.theme')) throw new Error('The selected app theme is not exposed to theme-specific icon styles');
for (const themeMarker of ['mask: var(--icon)', '.nav-item.active .nav-icon', ':root[data-theme="dark"] .item-warning']) {
  if (!styles.includes(themeMarker)) throw new Error(`Forced theme styling is incomplete: ${themeMarker}`);
}
for (const pauseMarker of ["paused: '已暂停'", 'data-pause-download', 'data-resume-download', "invoke('pause_download'", "invoke('resume_download'", '已按原参数继续下载']) {
  if (!app.includes(pauseMarker)) throw new Error(`Download pause/resume UI is incomplete: ${pauseMarker}`);
}
for (const pauseBackendMarker of ["AtomicU8", "status='paused'", 'fn pause_download', 'async fn resume_download', '只能继续已暂停的下载任务', "jobs_schema.contains(\"'paused'\")"]) {
  if (!rust.includes(pauseBackendMarker)) throw new Error(`Download pause/resume backend is incomplete: ${pauseBackendMarker}`);
}
for (const cancelledTaskMarker of ['function userCancelled', "status-${cancelled ? 'cancelled'", '按原参数重新开始', 'task-error${cancelled', "taskMatchesFilter(job, 'active')", 'task-error.task-cancelled']) {
  if (!`${app}\n${styles}`.includes(cancelledTaskMarker)) throw new Error(`User-cancelled task semantics are incomplete: ${cancelledTaskMarker}`);
}
for (const lifecycleMarker of ['TrayIconBuilder::with_id', 'WindowEvent::CloseRequested', 'if task_shutdown_complete(&state)', 'window.app_handle().exit(0)', 'api.prevent_close()', 'request_task_shutdown', '退出（停止任务）']) {
  if (!rust.includes(lifecycleMarker)) throw new Error(`Tray lifecycle is incomplete: ${lifecycleMarker}`);
}
for (const backupMarker of ['DATABASE_SCHEMA_VERSION', 'prepare_database_backup', 'restore_database_backup', 'clipcargo.pre-migration-v', '数据库已从迁移前备份恢复', 'PRAGMA user_version']) {
  if (!rust.includes(backupMarker)) throw new Error(`Database migration recovery is incomplete: ${backupMarker}`);
}
for (const dependencyMarker of ["invoke('component_status')", 'download-component-action', '开始前需要安装']) {
  if (!app.includes(dependencyMarker)) throw new Error(`Download dependency preflight is incomplete: ${dependencyMarker}`);
}
for (const confirmationMarker of ['download-summary', 'downloadsDirectory', '文件大小由来源决定', 'estimatedBytes', '预计下载', 'previewDownloadName', 'sourceId']) {
  if (!`${html}\n${app}`.includes(confirmationMarker)) throw new Error(`Download confirmation summary is incomplete: ${confirmationMarker}`);
}
for (const exceptionMarker of ['download-exceptions', 'downloadItemExceptions', '来源没有可下载的音轨', '没有直接兼容的 H.264/AAC MP4', 'resolver_capabilities', 'validate_download_capabilities', 'compatible_mp4']) {
  if (!`${html}\n${app}\n${rust}`.includes(exceptionMarker)) throw new Error(`Per-item download preflight is incomplete: ${exceptionMarker}`);
}
for (const partialBatchMarker of ['data-download-supported', '仅下载可用项', '已排除', 'eligibleIds']) {
  if (!app.includes(partialBatchMarker)) throw new Error(`Mixed download recovery is incomplete: ${partialBatchMarker}`);
}
for (const selectionKeyboardMarker of ['visibleInboxItems()', "event.key.toLowerCase() === 'a'", 'selectedInboxItems.clear()', '单次最多准备 100 项']) {
  if (!app.includes(selectionKeyboardMarker)) throw new Error(`Inbox keyboard/limit handling is incomplete: ${selectionKeyboardMarker}`);
}
if (!rust.includes('downloads_directory: PathBuf')) throw new Error('Backend does not expose the real downloads directory');
for (const processDependencyMarker of ['process-component-action', '开始处理前需要安装视频处理工具']) {
  if (!app.includes(processDependencyMarker)) throw new Error(`Processing dependency preflight is incomplete: ${processDependencyMarker}`);
}
if (!app.includes("downloadQuality: '1080'") || !app.includes("const preferred = String(preferences.downloadQuality || 'best')")) {
  throw new Error('Default download quality must fall back to 1080p and flow through persisted preferences');
}
for (const preferenceMarker of ['clipcargo:preferences', 'setting-theme', 'setting-default-project', 'setting-download-concurrency', 'setting-download-preset', 'clipcargo:last-view', 'preferredProject()']) {
  if (!app.includes(preferenceMarker)) throw new Error(`Persistent general setting is incomplete: ${preferenceMarker}`);
}
for (const projectSuggestionMarker of ['project-options', 'canonicalProjectName', '选择已有项目或输入新项目']) {
  if (!`${html}\n${app}`.includes(projectSuggestionMarker)) throw new Error(`Project suggestion flow is incomplete: ${projectSuggestionMarker}`);
}
for (const compactAddDialogMarker of ['class="dialog add-link-dialog"', 'rows="4"', '.add-link-dialog { width: min(460px', '.add-link-dialog textarea { min-height: 88px']) {
  if (!`${html}\n${styles}`.includes(compactAddDialogMarker)) throw new Error(`Compact add-link dialog regressed: ${compactAddDialogMarker}`);
}
for (const authLabelMarker of ['需要登录的视频', 'setting-auth-browser', '打开登录窗口', '检查登录状态', '已验证登录', 'browsers']) {
  if (!app.includes(authLabelMarker)) throw new Error(`Browser session wording regressed: ${authLabelMarker}`);
}
for (const downloadLocationMarker of ['chooseDownloadDirectory', "invoke('set_downloads_directory'", "invoke('open_downloads_directory'", 'download-location.txt', 'managed_roots', 'allow_managed_roots', 'chooseComponentsDirectory', "invoke('set_components_directory'", 'component-location.txt']) {
  if (!`${app}\n${rust}`.includes(downloadLocationMarker)) throw new Error(`User-selectable download location is incomplete: ${downloadLocationMarker}`);
}

const config = JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));
if (config.build.removeUnusedCommands !== true) throw new Error('Unused Tauri commands must be removed');
if (config.bundle.windows.webviewInstallMode.type !== 'downloadBootstrapper') throw new Error('Unexpected WebView2 install mode');
if (!config.bundle.externalBin?.includes('binaries/clipcargo-native-host')) throw new Error('Native Host is not bundled as a Tauri sidecar');
if (config.build.beforeDevCommand?.wait !== true || config.build.beforeDevCommand?.cwd !== '..') throw new Error('Native Host dev build must finish before Tauri starts');
if (config.build.beforeBuildCommand?.cwd !== '..') throw new Error('Native Host release build has an unexpected working directory');
for (const bridgeMarker of ['EMBEDDED_EXTENSION_FILES', 'DEVELOPMENT_EXTENSION_ID', 'STORE_EXTENSION_ID', 'TRUSTED_EXTENSION_IDS', 'register_extension_bridge(&state)', 'NativeMessagingHosts', 'clipcargo-native-host.exe', 'windows_subsystem']) {
  if (!(rust.includes(bridgeMarker) || nativeHost.includes(bridgeMarker))) throw new Error(`Browser extension bridge setup is incomplete: ${bridgeMarker}`);
}
for (const bridgeStatusMarker of ['struct BridgeStatus', 'extension_ids_from_manifest', 'registry_points_to_manifest', 'extension_verified', 'extension_active', '.extension-status', 'debug_build']) {
  if (!rust.includes(bridgeStatusMarker)) throw new Error(`Browser bridge status is incomplete: ${bridgeStatusMarker}`);
}
for (const bridgeUiMarker of ["isStoreExtension", '开发测试版', '打开本地扩展文件', '检测连接', 'Chrome Web Store', '打开 Chrome 商店', 'extensionTestDetails']) {
  if (!app.includes(bridgeUiMarker)) throw new Error(`Browser bridge status UI is incomplete: ${bridgeUiMarker}`);
}
for (const bridgeInteractionMarker of ['bridgeChecking', 'aria-busy="true"', 'setTimeout(resolve, 2000)']) {
  if (!app.includes(bridgeInteractionMarker)) throw new Error(`Browser bridge loading interaction is incomplete: ${bridgeInteractionMarker}`);
}
for (const compactSettingsMarker of ['.button[aria-busy="true"] .ui-icon', '.settings-grid { gap: 8px; }', 'white-space: nowrap']) {
  if (!styles.includes(compactSettingsMarker)) throw new Error(`Compact settings layout is incomplete: ${compactSettingsMarker}`);
}

const popup = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const popupScript = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const popupStyles = readFileSync(new URL('../extension/popup.css', import.meta.url), 'utf8');
const extensionBackground = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
const extensionContent = readFileSync(new URL('../extension/content.js', import.meta.url), 'utf8');
if (popup.includes('<span class="mark">')) throw new Error('Extension popup still uses a character as its logo');
if (/[✓…]/.test(extensionBackground)) throw new Error('Extension badge still uses a character pseudo-icon');
for (const badgeMarker of ['setCaptureBadge', "text: 'OK'", "text: '1'", 'setBadgeBackgroundColor']) {
  if (!extensionBackground.includes(badgeMarker)) throw new Error(`Extension badge semantics are incomplete: ${badgeMarker}`);
}
for (const queueSafetyMarker of ['MAX_PENDING_CAPTURES = 200', 'withQueueLock', 'item.payload?.pageUrl === message.payload?.pageUrl', '离线待发送队列已满', "QUEUE_RETRY_ALARM = 'clipcargo-flush-pending'", 'chrome.alarms.onAlarm.addListener', 'remaining.push(...queue.slice(index + 1))', 'lastError']) {
  if (!extensionBackground.includes(queueSafetyMarker)) throw new Error(`Extension offline queue safety is incomplete: ${queueSafetyMarker}`);
}
for (const stateText of ['可收集', '已送达', '已暂存', '发送失败']) {
  if (!popupScript.includes(stateText)) throw new Error(`Extension popup state is missing: ${stateText}`);
}
for (const semanticState of ['state-label available', 'state-label error', 'message error']) {
  if (!popupScript.includes(semanticState)) throw new Error(`Extension popup semantic state is missing: ${semanticState}`);
}
for (const visualState of ['.state-label.available', '.state-label.ready', '.state-label.queued', '.state-label.error', '.message.error']) {
  if (!popupStyles.includes(visualState)) throw new Error(`Extension popup visual state is missing: ${visualState}`);
}
if (!popupScript.includes('catch (error)')) throw new Error('Extension popup does not recover from message failures');
for (const overlayMarker of ['data-clipcargo-video-control', 'capture-video-card', '用 ClipCargo 收集这个视频', 'MutationObserver', '收进 ClipCargo']) {
  if (!extensionContent.includes(overlayMarker)) throw new Error(`In-page video overlay is incomplete: ${overlayMarker}`);
}
for (const xTimelineMarker of ['tweetContainer', 'tweetStatusLink', 'data-testid="videoPlayer"', 'mediaPageUrl', 'xVideoSurface', 'if (isXHost() && !xVideoSurface(link)) continue', 'ResizeObserver', 'attributeFilter', 'yt-navigate-finish', 'www.x.com', 'www.twitter.com']) {
  if (!extensionContent.includes(xTimelineMarker)) throw new Error(`X timeline video detection is incomplete: ${xTimelineMarker}`);
}
for (const popupInjectionMarker of ['for (let attempt = 0; attempt < 8; attempt += 1)', 'await new Promise((resolve) => setTimeout(resolve, 100))']) {
  if (!popupScript.includes(popupInjectionMarker)) throw new Error(`Extension injection readiness check is incomplete: ${popupInjectionMarker}`);
}
for (const configurableSiteMarker of ['optional_host_permissions', 'sync-media-sites', 'syncMediaSiteScripts', 'mediaSites', 'disabledMediaSites', '启用', '停用']) {
  if (!`${JSON.stringify(manifest)}\n${extensionBackground}\n${extensionContent}\n${popup}\n${popupScript}`.includes(configurableSiteMarker)) throw new Error(`Configurable media sites are incomplete: ${configurableSiteMarker}`);
}
for (const builtInSite of ['x.com', 'twitter.com', 'instagram.com', 'facebook.com', 'vimeo.com', 'dailymotion.com', 'twitch.tv']) {
  if (!JSON.stringify(manifest).includes(builtInSite)) throw new Error(`Built-in media site is missing: ${builtInSite}`);
}
for (const overlayPositionMarker of ['.panel{position:fixed', 'isBiliHost', 'bili-video-card__wrap', 'surface.append(host)', 'window.innerWidth - panelWidth', 'window.innerHeight - 8', 'pruneDetachedControls', 'panelHost.__clipCargoSurface']) {
  if (!extensionContent.includes(overlayPositionMarker)) throw new Error(`In-page video panel edge avoidance is incomplete: ${overlayPositionMarker}`);
}
for (const heartbeatMarker of ['bridgeStatusEnvelope', "type: 'bridge_status'", 'reportBridgeStatus']) {
  if (!extensionBackground.includes(heartbeatMarker)) throw new Error(`Extension heartbeat is incomplete: ${heartbeatMarker}`);
}
for (const popupEntryMarker of ['id="capture-form"', 'list="projects-list"', 'type="submit" disabled']) {
  if (!popup.includes(popupEntryMarker)) throw new Error(`Extension popup entry state is incomplete: ${popupEntryMarker}`);
}
for (const popupScriptMarker of ["form.addEventListener('submit'", 'if (!currentTab || !supported(currentTab.url)) return', "stateLabel.textContent = '读取失败'"]) {
  if (!popupScript.includes(popupScriptMarker)) throw new Error(`Extension popup submit/read handling is incomplete: ${popupScriptMarker}`);
}
for (const injectionMarker of ['injectCurrentPage', "chrome.scripting?.executeScript", '已启用，入口已显示', '重新显示入口', '注入受阻', '__clipCargoContentScriptVersion', '__clipCargoContentScriptStop']) {
  if (!`${popup}\n${popupScript}\n${extensionContent}`.includes(injectionMarker)) throw new Error(`Current-page extension injection is incomplete: ${injectionMarker}`);
}
if ((rust.match(/validate_network_destination\(&page_url\)/g) || []).length < 2) throw new Error('Resolved destination checks must guard both resolve and download');
if (!rust.includes('ip.is_unique_local()') || !rust.includes('.to_ipv4_mapped()')) throw new Error('Resolved destination checks do not cover private IPv6 and mapped IPv4');
if ((rust.match(/"--ignore-config"/g) || []).length < 3) throw new Error('Every yt-dlp entry point must ignore external configuration');
if ((rust.match(/"--no-playlist"/g) || []).length < 3) throw new Error('Every yt-dlp entry point must reject playlist expansion');
if (!rust.includes('concurrency_limit.unwrap_or(2)') || !rust.includes('(1..=4).contains(&concurrency_limit)')) throw new Error('Configurable download concurrency is not enforced by Rust');
for (const sourcePresetMarker of ['value="source">保留来源格式', 'source_format_selector_for_quality', 'else if !source_format', 'output_preset TEXT NOT NULL']) {
  if (!`${html}\n${rust}`.includes(sourcePresetMarker)) throw new Error(`Source-format download preset is incomplete: ${sourcePresetMarker}`);
}
for (const qualityMarker of ['available_heights_json', 'quality_format_ids_json', 'available_heights: Vec<i64>', 'quality_format_ids: BTreeMap<i64, String>', 'format_quality_dimension', 'exact_format_selector', 'renderDownloadQualityOptions', '仅显示所选视频共同提供的清晰度', 'requested_quality_height']) {
  if (!`${app}\n${rust}`.includes(qualityMarker)) throw new Error(`Resolved download qualities are incomplete: ${qualityMarker}`);
}
for (const compatibleMarker of ['value="video">兼容 MP4', 'make_compatible_mp4', 'compatible_mp4_probe', '"libx264"', '转换结果不是 H.264/AAC MP4']) {
  if (!`${html}\n${rust}`.includes(compatibleMarker)) throw new Error(`Compatible MP4 pipeline is incomplete: ${compatibleMarker}`);
}
for (const conversionSafetyMarker of ['stderr_thread', 'if let Err(error) = validation', 'let backup = destination.with_extension("json.bak")']) {
  if (!rust.includes(conversionSafetyMarker)) throw new Error(`Download finalization safety is incomplete: ${conversionSafetyMarker}`);
}
for (const sidecarMarker of ['download-cover', 'download-source-record', 'saveSourceRecord', 'struct SourceRecord', 'write_source_record', '"--write-thumbnail"']) {
  if (!`${html}\n${app}\n${rust}`.includes(sidecarMarker)) throw new Error(`Download sidecar handling is incomplete: ${sidecarMarker}`);
}
for (const packageMarker of ['value="package">完整素材包', "downloadPreset: 'package'", "output_preset == \"package\"", 'fn queue_package_audio', '素材包中的 MP3', '兼容 MP4、MP3、字幕、封面和来源信息']) {
  if (!`${html}\n${app}\n${rust}`.includes(packageMarker)) throw new Error(`Complete asset package flow is incomplete: ${packageMarker}`);
}
for (const organizedPackageMarker of ['fn asset_package_directory', 'fn asset_root_for_media', 'fn archive_download_sidecars', 'move_file_into_directory', 'if audio_only { "audio" } else { "video" }', 'asset_root.join("audio")', 'asset_root.join("images")', 'asset_root.join("subtitles")', 'join("metadata.json")']) {
  if (!rust.includes(organizedPackageMarker)) throw new Error(`Organized asset package storage is incomplete: ${organizedPackageMarker}`);
}
for (const projectLibraryMarker of ['素材项目', '全部素材', 'data-open-library-project', 'data-open-asset-package', 'imageCount', 'subtitleCount']) {
  if (!`${app}\n${rust}`.includes(projectLibraryMarker)) throw new Error(`Project-oriented media library is incomplete: ${projectLibraryMarker}`);
}
for (const editorMarker of ['fn discover_video_editors', 'JianyingPro.exe', 'verified: false', 'fn launch_editor_import', '尚未通过素材导入验证', 'import_media_to_editor', 'import_asset_package_to_editor', 'data-import-package-editor', '交给剪映']) {
  if (!`${app}\n${rust}`.includes(editorMarker)) throw new Error(`Jianying editor handoff is incomplete: ${editorMarker}`);
}
if (!app.includes("downloadQuality.closest('.custom-select') || downloadQuality")) throw new Error('Dynamic preset changes can expose the hidden native quality select');
for (const warningMarker of ['warning_message', 'warningMessage', 'has_cover_sidecar', '来源没有提供封面，主文件已正常下载', '来源没有可保存的所选字幕']) {
  if (!`${app}\n${rust}`.includes(warningMarker)) throw new Error(`Non-blocking sidecar warning is incomplete: ${warningMarker}`);
}
for (const snapshotMarker of ['save_subtitles INTEGER', 'subtitle_languages_json', 'save_cover INTEGER', 'save_source_record INTEGER', 'retain_source INTEGER', 'subtitle_languages: Vec<String>']) {
  if (!rust.includes(snapshotMarker)) throw new Error(`Download parameter snapshot is incomplete: ${snapshotMarker}`);
}
for (const retryMarker of ['"--retries", "3"', '"--fragment-retries", "3"', '"--retry-sleep", "exp=1:5"', 'HTTP Error 429', 'no space left']) {
  if (!rust.includes(retryMarker)) throw new Error(`Finite download retry/error classification is incomplete: ${retryMarker}`);
}
for (const processTreeMarker of ['fn terminate_child_tree', '"taskkill.exe"', '"/T", "/F"']) {
  if (!rust.includes(processTreeMarker)) throw new Error(`Windows process-tree cancellation is incomplete: ${processTreeMarker}`);
}
for (const processingIdempotencyMarker of ['matching_active_derivative_id', "status IN ('queued','processing')", '检查重复处理任务']) {
  if (!rust.includes(processingIdempotencyMarker)) throw new Error(`Processing idempotency is incomplete: ${processingIdempotencyMarker}`);
}
for (const recoveryMarker of ['recover_interrupted_jobs', 'derivative_output_path', '补登记已完成处理文件', '可能的输出已保留在']) {
  if (!rust.includes(recoveryMarker)) throw new Error(`Interrupted processing recovery is incomplete: ${recoveryMarker}`);
}
for (const processingTrackMarker of ['该素材没有音频轨，无法提取 MP3', '该素材没有视频轨，无法执行当前处理', 'inspect_compatible_mp4(&ffmpeg.with_file_name("ffprobe.exe"), &source)']) {
  if (!rust.includes(processingTrackMarker)) throw new Error(`Processing track preflight is incomplete: ${processingTrackMarker}`);
}
for (const marker of ['function validateClipInputs', 'valueAsNumber', 'clip-start-error', 'clip-end-error', "setAttribute('aria-invalid', 'true')", '请修正标出的时间范围']) {
  if (!`${html}\n${app}`.includes(marker)) throw new Error(`Field-level clip validation is incomplete: ${marker}`);
}
for (const processingUiMarker of ["['queued', 'processing'].includes(result.status)", '处理任务已加入队列', 'blockedByCapabilities']) {
  if (!app.includes(processingUiMarker)) throw new Error(`Processing submission UI is incomplete: ${processingUiMarker}`);
}
for (const processingWorkspaceMarker of ['process-tool-groups', 'data-process-mode="rotate-left"', 'data-process-mode="rotate-right"', 'data-process-mode="mute"', 'data-process-mode="speed-2x"', 'data-process-mode="compress"', 'selectProcessMode', 'transpose=2', 'transpose=1', 'setpts=0.5*PTS', 'atempo=2.0', 'force_original_aspect_ratio=decrease']) {
  if (!`${html}\n${app}\n${styles}\n${rust}`.includes(processingWorkspaceMarker)) throw new Error(`Expanded processing workspace is incomplete: ${processingWorkspaceMarker}`);
}
for (const playerFallbackMarker of ['player-convert', '生成兼容副本', '兼容副本已加入队列', "activePlayerAsset?.assetType === 'original'"]) {
  if (!`${html}\n${app}`.includes(playerFallbackMarker)) throw new Error(`Player compatibility fallback is incomplete: ${playerFallbackMarker}`);
}
for (const playerKeyboardMarker of ["event.key.toLowerCase() === 'm'", 'mediaPlayer.muted = !mediaPlayer.muted', 'document.fullscreenElement', 'isPlayerShortcutTarget(event.target)', "input, textarea, select, button, video", "[role=\"combobox\"]", 'event.repeat']) {
  if (!app.includes(playerKeyboardMarker)) throw new Error(`Player keyboard handling is incomplete: ${playerKeyboardMarker}`);
}
if (!app.includes('function classifyTaskError')) throw new Error('Structured task error classifier is missing');
for (const code of ['NETWORK_UNREACHABLE', 'RATE_LIMITED', 'AUTH_REQUIRED', 'SOURCE_GONE', 'UNSUPPORTED_SOURCE', 'DISK_FULL', 'PERMISSION_DENIED', 'COMPONENT_MISSING', 'OUTPUT_INVALID', 'CANCELLED_BY_USER', 'PROCESS_FAILED']) {
  if (!app.includes(code)) throw new Error(`Task error code is missing: ${code}`);
}
for (const marker of ['const DATABASE_SCHEMA_VERSION: i64 = 7', 'error_code TEXT', 'fn task_error_code', 'j.error_code', 'd.error_code', "error_code='CANCELLED_BY_USER'", 'auth_required INTEGER NOT NULL DEFAULT 0']) {
  if (!rust.includes(marker)) throw new Error(`Persisted task error classification is incomplete: ${marker}`);
}
for (const marker of ['parse_download_progress', 'progress.downloaded_bytes', 'speed_bytes_per_second', 'eta_seconds', "stage='verifying'", "stage='processing'", "stage='archiving'"]) {
  if (!rust.includes(marker)) throw new Error(`Truthful download telemetry is incomplete: ${marker}`);
}
for (const marker of ['downloadProgressDetail', 'formatTransferRate', '剩余约', '正在校验', '正在归档']) {
  if (!app.includes(marker)) throw new Error(`Download telemetry UI is incomplete: ${marker}`);
}
for (const marker of ['function renderPreservingInteraction', 'interactionSelector', '@summary:', 'openDetails', 'replacement.focus({ preventScroll: true })', 'renderPreservingInteraction();']) {
  if (!app.includes(marker)) throw new Error(`Polling interaction preservation is incomplete: ${marker}`);
}
for (const marker of ['function hasActiveWork', 'function scheduleRefresh', 'hasActiveWork() ? 2_000 : 5_000', "document.addEventListener('visibilitychange'", 'refreshInbox().finally(() => scheduleRefresh())']) {
  if (!app.includes(marker)) throw new Error(`Adaptive refresh scheduling is incomplete: ${marker}`);
}
if (app.includes("setInterval(() => { if (state.view === 'inbox' || state.view === 'tasks')")) throw new Error('Legacy fixed two-second polling is still active');
for (const marker of ['struct MediaRemovalImpact', 'fn media_removal_impact', 'reference_count', 'size_bytes', 'SELECT COUNT(*) FROM media_derivatives']) {
  if (!rust.includes(marker)) throw new Error(`Media removal impact preflight is incomplete: ${marker}`);
}
for (const marker of ["invoke('media_removal_impact'", 'pendingLibraryImpact', '条素材记录引用', '所有引用该文件的记录显示缺失']) {
  if (!app.includes(marker)) throw new Error(`Media removal impact UI is incomplete: ${marker}`);
}
for (const marker of ['waiting_component INTEGER NOT NULL DEFAULT 0', "waiting_component: '等待安装'", '需要下载引擎才能识别；链接已保留', '安装下载引擎', 'data-view="browser"']) {
  if (!`${rust}\n${app}`.includes(marker)) throw new Error(`Waiting-component inbox state is incomplete: ${marker}`);
}
for (const marker of ["kind === 'yt-dlp'", "item.status === 'waiting_component'", "invoke('resolve_inbox_item', { id })", '已继续识别']) {
  if (!app.includes(marker)) throw new Error(`Waiting items do not resume after parser install: ${marker}`);
}
if (!app.includes("${icon('pencil')}编辑信息") || app.includes("${icon('settings')}整理")) throw new Error('Library metadata action uses an ambiguous settings icon');
if (app.includes('title="${escapeHtml(item.errorMessage)}"') || app.includes('<dd>${escapeHtml(item.errorMessage)}</dd>')) throw new Error('Raw downloader diagnostics must not leak into the primary UI or accessibility description');
for (const friendlyErrorMarker of ['当前浏览器会话不可用', "classifyTaskError(item.errorMessage, 'download', item.errorCode).action", "PROCESS_FAILED: kind === 'processing'"]) {
  if (!app.includes(friendlyErrorMarker)) throw new Error(`Friendly task error presentation is incomplete: ${friendlyErrorMarker}`);
}
if (!styles.includes('.toast { position: fixed; z-index: 80; top: 12px; left: 50%;') || !styles.includes('background: color-mix(in srgb, var(--surface) 96%, transparent)')) throw new Error('Toast must use the compact light top-center treatment');
for (const browserAuthMarker of ["invoke('open_source_login'", "invoke('finish_source_login'", '需要登录的视频', '--cookies-from-browser', 'browser_has_authenticated_cookie', 'BROWSER_DEFINITIONS', '没有检测到有效的登录会话']) {
  if (!`${app}\n${rust}`.includes(browserAuthMarker)) throw new Error(`Browser session login flow is incomplete: ${browserAuthMarker}`);
}
for (const publicDownloadMarker of ['let public_result = execute_download_task(', 'source_id.clone()', 'task_error_code(&message, false) == "AUTH_REQUIRED"', 'browser_retry.is_some()']) {
  if (!rust.includes(publicDownloadMarker)) throw new Error(`Downloads do not use public-first authentication fallback: ${publicDownloadMarker}`);
}
for (const marker of ['component_cancel_requested: AtomicBool', 'fn cancel_component_install', 'download_component_bytes', '工具安装已取消。', 'install_ffmpeg_into_controlled']) {
  if (!rust.includes(marker)) throw new Error(`Component install cancellation is incomplete: ${marker}`);
}
for (const marker of ["invoke('cancel_component_install')", '取消安装', '正在取消…', '现有版本没有改变']) {
  if (!app.includes(marker)) throw new Error(`Component install cancellation UI is incomplete: ${marker}`);
}
for (const marker of ['component_install_phase: AtomicU8', 'install_phase: String', '"downloading"', '"verifying"', '"installing"']) {
  if (!rust.includes(marker)) throw new Error(`Component install phase reporting is incomplete: ${marker}`);
}
for (const marker of ['struct ComponentInstallStatus', 'fn component_install_status', "invoke('component_install_status')"]) {
  if (!`${rust}\n${app}`.includes(marker)) throw new Error(`Lightweight component progress polling is incomplete: ${marker}`);
}
for (const marker of ['yt_dlp_bytes: u64', 'ffmpeg_bytes: u64', 'deno_bytes: u64', 'total_bytes: u64', 'managed_bytes']) {
  if (!rust.includes(marker)) throw new Error(`Actual component footprint reporting is incomplete: ${marker}`);
}
for (const marker of ['components.totalBytes', 'components.ytDlpBytes', 'components.ffmpegBytes', 'components.denoBytes']) {
  if (!app.includes(marker)) throw new Error(`Actual component footprint UI is incomplete: ${marker}`);
}
for (const marker of ["downloading: '正在下载'", "verifying: '正在校验'", "installing: '正在安装'", "invoke('component_status')"]) {
  if (!app.includes(marker)) throw new Error(`Component install phase UI is incomplete: ${marker}`);
}
for (const marker of ['fn remove_component', 'remove_component_files', '工具正在使用或文件不可写，未执行卸载', '有下载或处理任务正在运行或排队']) {
  if (!rust.includes(marker)) throw new Error(`Safe component removal is incomplete: ${marker}`);
}
for (const marker of ['fn activate_component_group', 'fn rollback_component_group', '已恢复整组旧版本', 'rollback_component_group(components_dir, &["yt-dlp.exe"])', 'rollback_component_group(components_dir, &["deno.exe"])', 'activates_and_rolls_back_ffmpeg_as_one_group']) {
  if (!rust.includes(marker)) throw new Error(`Atomic component update rollback is incomplete: ${marker}`);
}
for (const marker of ['async fn retry_download', "status='failed'", '读取原下载字幕参数失败', 'download_inbox_item(', 'error_code=NULL, warning_message=NULL']) {
  if (!rust.includes(marker)) throw new Error(`Download snapshot retry is incomplete: ${marker}`);
}
for (const marker of ["data-retry-download", "invoke('retry_download'", '已按原参数重新排队，并重新获取来源地址']) {
  if (!app.includes(marker)) throw new Error(`Download snapshot retry UI is incomplete: ${marker}`);
}
for (const marker of ["data-action=\"remove-component\"", "invoke('remove_component', { kind })", '工具已卸载，已保存的素材没有改变']) {
  if (!app.includes(marker)) throw new Error(`Component removal UI is incomplete: ${marker}`);
}
if (!app.includes('persistedTaskErrorCodes') || !app.includes('item.errorCode')) throw new Error('Frontend does not prefer persisted task error codes');
for (const marker of ['component-install-backdrop', '预计下载', '安装后占用', '确认下载并安装', 'SHA-256']) {
  if (!`${html}\n${app}`.includes(marker)) throw new Error(`Component install confirmation is incomplete: ${marker}`);
}
for (const kind of ["openComponentInstall('yt-dlp')", "openComponentInstall('ffmpeg')", "openComponentInstall('deno')"]) {
  if (!app.includes(kind)) throw new Error(`Component install bypasses confirmation: ${kind}`);
}
for (const subtitleMarker of ['download-subtitle-options', 'subtitleOptions', 'subtitleLanguages', 'automatic_captions', 'resolver_subtitle_options', 'subtitles_json']) {
  if (!`${html}\n${app}\n${rust}`.includes(subtitleMarker)) throw new Error(`Subtitle selection flow is incomplete: ${subtitleMarker}`);
}
for (const retainedSourceMarker of ['download-retain-source', 'retainSource', 'retain_source', '"--keep-video"', "kind='source'", 'record_retained_source', '下载源文件']) {
  if (!`${html}\n${app}\n${rust}`.includes(retainedSourceMarker)) throw new Error(`Retained download source handling is incomplete: ${retainedSourceMarker}`);
}
for (const redundantHeading of ["heading('收集箱'", "heading('任务'", "heading('素材库'", "heading('设置'"]) {
  if (app.includes(redundantHeading)) throw new Error(`A redundant page heading returned: ${redundantHeading}`);
}
for (const marker of ['page-toolbar', 'inbox-table-head', 'inbox-title-cell', 'inbox-status-cell']) {
  if (!app.includes(marker)) throw new Error(`Compact inbox information architecture is incomplete: ${marker}`);
}
for (const marker of ['/* 2026 visual system — compact content workspace */', '.inbox-row:last-child', '.page-toolbar', '.tabs { width: max-content']) {
  if (!styles.includes(marker)) throw new Error(`Selected visual system is incomplete: ${marker}`);
}
for (const marker of ['fn external_tool_start_error', 'raw_os_error() == Some(4551)', 'Windows 智能应用控制', 'explains_windows_smart_app_control_blocks']) {
  if (!rust.includes(marker)) throw new Error(`Smart App Control error guidance is incomplete: ${marker}`);
}
for (const marker of ['managed_file,stage,downloaded_bytes,total_bytes,speed_bytes_per_second,eta_seconds', 'SELECT stage FROM download_jobs WHERE item_id=2']) {
  if (!rust.includes(marker)) throw new Error(`Download telemetry migration is incomplete: ${marker}`);
}
const buildScript = readFileSync(new URL('../src-tauri/build.rs', import.meta.url), 'utf8');
const nativeHostPreparation = readFileSync(new URL('../scripts/prepare-native-host.ps1', import.meta.url), 'utf8');
for (const marker of ['clipcargo-native-host-{target}.exe', 'TAURI_CONFIG', 'externalBin', 'sidecar.is_file()']) {
  if (!buildScript.includes(marker)) throw new Error(`Native Host clean-checkout bootstrap is incomplete: ${marker}`);
}
for (const marker of ['$Profile', 'clipcargo-native-host.exe', 'Copy-Item', 'Native Host output is missing']) {
  if (!nativeHostPreparation.includes(marker)) throw new Error(`Native Host profile preparation is incomplete: ${marker}`);
}
const nativeHostSmoke = readFileSync(new URL('./native-host-smoke.mjs', import.meta.url), 'utf8');
for (const marker of ['src-tauri', 'binaries', 'target', 'debug', 'target', 'release', 'executableCandidates.find(existsSync)']) {
  if (!nativeHostSmoke.includes(marker)) throw new Error(`Native Host smoke executable discovery is incomplete: ${marker}`);
}

const inventoryUrl = new URL('../docs/generated/dependency-license-inventory.json', import.meta.url);
const bundleUrl = new URL('../docs/generated/DEPENDENCY-LICENSES.txt', import.meta.url);
const inventory = JSON.parse(readFileSync(inventoryUrl, 'utf8'));
if (inventory.summary.missingLicenseMetadata !== 0) throw new Error('Dependency license metadata is incomplete');
if (inventory.summary.packages !== inventory.packages.length) throw new Error('Dependency license inventory count is inconsistent');
if (inventory.summary.cargoPackages < 1 || inventory.summary.npmPackages < 1) throw new Error('Dependency license inventory does not cover both package managers');
if (inventory.summary.uniqueLicenseTexts < 1) throw new Error('Dependency license bundle has no license texts');
if (!readFileSync(bundleUrl, 'utf8').includes('UNIQUE LICENSE TEXTS')) throw new Error('Dependency license text bundle is invalid');
const generatedTime = Math.min(statSync(inventoryUrl).mtimeMs, statSync(bundleUrl).mtimeMs);
for (const lockUrl of [new URL('../src-tauri/Cargo.lock', import.meta.url), new URL('../package-lock.json', import.meta.url)]) {
  if (generatedTime < statSync(lockUrl).mtimeMs) throw new Error('Dependency license bundle is older than a lockfile; run npm run licenses');
}

console.log(JSON.stringify({
  extensionPermissions: manifest.permissions.length,
  tauriIdentifier: config.identifier,
  licensedPackages: inventory.summary.packages,
  uniqueLicenseTexts: inventory.summary.uniqueLicenseTexts,
}));
