const HOST = 'net.clipcargo.native';

function requestId() {
  return globalThis.crypto?.randomUUID?.() || `capture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isHttpUrl(value) {
  try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; }
}

const QUEUE_KEY = 'pendingCaptures';
const MAX_PENDING_CAPTURES = 200;
const QUEUE_RETRY_ALARM = 'clipcargo-flush-pending';
const MEDIA_SITES_KEY = 'mediaSites';
const CUSTOM_SCRIPT_PREFIX = 'clipcargo-site-';
let queueOperation = Promise.resolve();

function normalizedHost(value) {
  try {
    const host = value.includes('://') ? new URL(value).hostname : value;
    return host.trim().toLowerCase().replace(/^www\./, '').replace(/[^a-z0-9.-]/g, '');
  } catch { return ''; }
}

function customScriptId(host) {
  return `${CUSTOM_SCRIPT_PREFIX}${host.replace(/[^a-z0-9]/g, '-')}`.slice(0, 64);
}

async function syncMediaSiteScripts() {
  if (!chrome.scripting?.getRegisteredContentScripts) return;
  const stored = await chrome.storage.local.get(MEDIA_SITES_KEY);
  const hosts = [...new Set((stored[MEDIA_SITES_KEY] || []).map(normalizedHost).filter(Boolean))];
  const existing = await chrome.scripting.getRegisteredContentScripts();
  const custom = existing.filter((script) => script.id.startsWith(CUSTOM_SCRIPT_PREFIX));
  if (custom.length) await chrome.scripting.unregisterContentScripts({ ids: custom.map((script) => script.id) });
  if (!hosts.length) return;
  await chrome.scripting.registerContentScripts(hosts.map((host) => ({
    id: customScriptId(host),
    js: ['content.js'],
    matches: [`https://${host}/*`, `https://*.${host}/*`, `http://${host}/*`, `http://*.${host}/*`],
    runAt: 'document_idle',
    persistAcrossSessions: true,
  })));
}

function withQueueLock(operation) {
  const current = queueOperation.then(operation, operation);
  queueOperation = current.catch(() => {});
  return current;
}

function normalizeProjectName(value) {
  const name = String(value || '').trim().slice(0, 50);
  return name || '未分类';
}

async function lastProjectName() {
  const stored = await chrome.storage.local.get('lastProject');
  return normalizeProjectName(stored.lastProject);
}

function envelopeFor({ pageUrl, title = '', projectName = '未分类', method = 'extension' }) {
  if (!isHttpUrl(pageUrl)) throw new Error('当前页面不是 HTTP(S) 页面。');
  return {
    protocolVersion: 1,
    requestId: requestId(),
    type: 'capture_page',
    payload: { pageUrl, title: title.slice(0, 512), projectName: normalizeProjectName(projectName), method },
  };
}

function bridgeStatusEnvelope() {
  return {
    protocolVersion: 1,
    requestId: requestId(),
    type: 'bridge_status',
    payload: { extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version },
  };
}

function sendEnvelope(message) {
  return chrome.runtime.sendNativeMessage(HOST, message).then((response) => {
    if (!response?.ok) throw new Error(response?.error || '桌面端没有确认接收。');
    return response;
  });
}

async function readQueue() {
  const stored = await chrome.storage.local.get(QUEUE_KEY);
  return Array.isArray(stored[QUEUE_KEY]) ? stored[QUEUE_KEY] : [];
}

function enqueue(message) {
  return withQueueLock(async () => {
    const queue = await readQueue();
    const duplicate = queue.some((item) => item.requestId === message.requestId
      || (item.payload?.pageUrl === message.payload?.pageUrl && item.payload?.projectName === message.payload?.projectName));
    if (duplicate) return { queued: false, duplicate: true, size: queue.length };
    if (queue.length >= MAX_PENDING_CAPTURES) {
      throw new Error(`离线待发送队列已满（${MAX_PENDING_CAPTURES} 条），请先打开 ClipCargo 桌面端完成发送。`);
    }
    queue.push(message);
    await chrome.storage.local.set({ [QUEUE_KEY]: queue });
    return { queued: true, duplicate: false, size: queue.length };
  });
}

function flushQueue() {
  return withQueueLock(async () => {
    const queue = await readQueue();
    if (!queue.length) return { sent: 0, remaining: 0 };
    const remaining = [];
    let sent = 0;
    for (let index = 0; index < queue.length; index += 1) {
      const message = queue[index];
      try { await sendEnvelope(message); sent += 1; }
      catch {
        remaining.push(...queue.slice(index));
        break;
      }
    }
    await chrome.storage.local.set({ [QUEUE_KEY]: remaining });
    return { sent, remaining: remaining.length };
  });
}

function ensureQueueAlarm() {
  return chrome.alarms.create(QUEUE_RETRY_ALARM, { periodInMinutes: 1 });
}

async function reportBridgeStatus() {
  try { return await sendEnvelope(bridgeStatusEnvelope()); }
  catch { return null; }
}

async function sendCapture(payload) {
  const message = envelopeFor(payload);
  try {
    const response = await sendEnvelope(message);
    await flushQueue();
    return { ...response, queued: false };
  } catch (error) {
    await enqueue(message);
    return { ok: true, queued: true, error: error.message };
  }
}

async function setCaptureBadge(tabId, state) {
  const badge = state === 'sent'
    ? { text: 'OK', color: '#287a5d' }
    : state === 'queued'
      ? { text: '1', color: '#a8650a' }
      : { text: '!', color: '#b43a45' };
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color, tabId }),
  ]);
}

chrome.runtime.onInstalled.addListener(async () => {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({ id: 'clipcargo-capture-link', title: '收进 ClipCargo', contexts: ['link'] });
  chrome.contextMenus.create({ id: 'clipcargo-capture-page', title: '把当前页面收进 ClipCargo', contexts: ['page'] });
  await ensureQueueAlarm();
  await syncMediaSiteScripts();
  await reportBridgeStatus();
  await flushQueue();
});

chrome.runtime.onStartup.addListener(() => {
  ensureQueueAlarm();
  syncMediaSiteScripts().catch(() => {});
  reportBridgeStatus();
  flushQueue().catch(() => {});
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_RETRY_ALARM) return reportBridgeStatus().then(() => flushQueue()).catch(() => {});
  return undefined;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const pageUrl = info.menuItemId === 'clipcargo-capture-link' ? info.linkUrl : (tab?.url || info.pageUrl);
  lastProjectName().then((projectName) => sendCapture({ pageUrl, title: tab?.title || '', projectName, method: info.menuItemId === 'clipcargo-capture-link' ? 'context-menu' : 'extension' }))
    .then((result) => setCaptureBadge(tab?.id, result.queued ? 'queued' : 'sent'))
    .catch(() => setCaptureBadge(tab?.id, 'failed'));
});

chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'sync-media-sites') {
    syncMediaSiteScripts().then(() => respond({ ok: true })).catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (!['capture-active-tab', 'capture-video-card'].includes(message?.type)) return false;
  sendCapture(message.payload).then((value) => respond({ ok: true, value })).catch((error) => respond({ ok: false, error: error.message }));
  return true;
});
