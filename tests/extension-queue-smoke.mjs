import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let online = false;
let requestSequence = 0;
let nativeSendAttempts = 0;
const storage = {};
const badge = {};
const alarms = {};
let alarmListener;
let messageListener;
let registeredScripts = [];
const noopEvent = { addListener() {} };
const context = {
  URL,
  crypto: { randomUUID: () => `request-${++requestSequence}` },
  chrome: {
    runtime: {
      id: 'dpogajmenckmdbpacaoilnhhdcjpbheb',
      getManifest: () => ({ version: '0.1.0' }),
      sendNativeMessage: async (_host, message) => {
        nativeSendAttempts += 1;
        if (!online) throw new Error('native host unavailable');
        return { ok: true, itemId: message.requestId };
      },
      onInstalled: noopEvent,
      onStartup: noopEvent,
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    storage: { local: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, storage[name]])); },
      async set(value) { Object.assign(storage, value); },
    } },
    contextMenus: { async removeAll() {}, create() {}, onClicked: noopEvent },
    alarms: {
      async create(name, options) { alarms[name] = options; },
      onAlarm: { addListener(listener) { alarmListener = listener; } },
    },
    action: {
      async setBadgeText(value) { badge.text = value.text; },
      async setBadgeBackgroundColor(value) { badge.color = value.color; },
    },
    scripting: {
      async getRegisteredContentScripts() { return registeredScripts; },
      async unregisterContentScripts({ ids }) { registeredScripts = registeredScripts.filter((script) => !ids.includes(script.id)); },
      async registerContentScripts(scripts) { registeredScripts.push(...scripts); },
    },
  },
};
vm.createContext(context);
vm.runInContext(fs.readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);

const queued = await vm.runInContext("sendCapture({ pageUrl: 'https://example.com/video', title: 'Example' })", context);
assert.equal(queued.queued, true);
assert.equal(storage.pendingCaptures.length, 1);
assert.equal(storage.pendingCaptures[0].requestId, 'request-1');

online = true;
const flushed = await vm.runInContext('flushQueue()', context);
assert.deepEqual({ sent: flushed.sent, remaining: flushed.remaining }, { sent: 1, remaining: 0 });
assert.equal(storage.pendingCaptures.length, 0);
online = false;
await Promise.all([
  vm.runInContext("sendCapture({ pageUrl: 'https://example.com/a', title: 'A', projectName: '项目甲' })", context),
  vm.runInContext("sendCapture({ pageUrl: 'https://example.com/b', title: 'B', projectName: '项目乙' })", context),
]);
assert.equal(storage.pendingCaptures.length, 2);
await vm.runInContext("sendCapture({ pageUrl: 'https://example.com/a', title: 'A duplicate', projectName: '项目甲' })", context);
assert.equal(storage.pendingCaptures.length, 2);
nativeSendAttempts = 0;
const offlineFlush = await vm.runInContext('flushQueue()', context);
assert.deepEqual({ sent: offlineFlush.sent, remaining: offlineFlush.remaining }, { sent: 0, remaining: 2 });
assert.equal(nativeSendAttempts, 1);
await vm.runInContext('ensureQueueAlarm()', context);
assert.equal(alarms['clipcargo-flush-pending'].periodInMinutes, 1);
online = true;
await alarmListener({ name: 'clipcargo-flush-pending' });
assert.equal(storage.pendingCaptures.length, 0);
online = false;
storage.pendingCaptures = Array.from({ length: 200 }, (_, index) => ({ requestId: `full-${index}`, payload: { pageUrl: `https://example.com/${index}`, projectName: '满队列' } }));
await assert.rejects(
  vm.runInContext("sendCapture({ pageUrl: 'https://example.com/overflow', title: 'Overflow' })", context),
  /离线待发送队列已满（200 条）/,
);
assert.equal(storage.pendingCaptures.length, 200);
assert.equal(storage.pendingCaptures[0].requestId, 'full-0');
storage.lastProject = `  客户项目${'x'.repeat(60)}  `;
const rememberedProject = await vm.runInContext('lastProjectName()', context);
assert.equal(rememberedProject.length, 50);
assert.ok(rememberedProject.startsWith('客户项目'));
const normalizedEnvelope = vm.runInContext("envelopeFor({ pageUrl: 'https://example.com/next', projectName: '   ' })", context);
assert.equal(normalizedEnvelope.payload.projectName, '未分类');
const statusEnvelope = vm.runInContext('bridgeStatusEnvelope()', context);
assert.equal(statusEnvelope.type, 'bridge_status');
assert.equal(statusEnvelope.payload.extensionId, 'dpogajmenckmdbpacaoilnhhdcjpbheb');
await vm.runInContext("setCaptureBadge(7, 'sent')", context);
assert.deepEqual(badge, { text: 'OK', color: '#287a5d' });
await vm.runInContext("setCaptureBadge(7, 'queued')", context);
assert.deepEqual(badge, { text: '1', color: '#a8650a' });
await vm.runInContext("setCaptureBadge(7, 'failed')", context);
assert.deepEqual(badge, { text: '!', color: '#b43a45' });
storage.mediaSites = ['Example.com', 'media.example.org'];
await vm.runInContext('syncMediaSiteScripts()', context);
assert.equal(registeredScripts.length, 2);
assert.ok(registeredScripts.some((script) => script.matches.includes('https://example.com/*')));
await new Promise((resolve, reject) => {
  const asyncResponse = messageListener({ type: 'sync-media-sites' }, null, (response) => response.ok ? resolve() : reject(new Error(response.error)));
  assert.equal(asyncResponse, true);
});
console.log(JSON.stringify({ queuedOffline: true, flushedOnline: true, retryAlarm: true, offlineFlushAttempts: 1, concurrentQueueSafe: true, duplicateSuppressed: true, overflowPreserved: true, rememberedProject: true, semanticBadges: true, configurableMediaSites: true }));
