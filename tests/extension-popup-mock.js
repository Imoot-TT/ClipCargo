const popupMode = new URLSearchParams(location.search).get('mode') || 'delivered';
const stored = {};
window.chrome = {
  tabs: { query: async () => {
    if (popupMode === 'read-error') throw new Error('测试标签读取失败');
    if (popupMode === 'unsupported') return [{ id: 1, title: '浏览器设置', url: 'chrome://extensions' }];
    return [{ id: 1, title: '城市咖啡探店视频', url: 'https://example.com/video?id=42' }];
  } },
  storage: { local: { get: async (key) => Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, stored[name]])), set: async (values) => Object.assign(stored, values) } },
  permissions: { request: async () => true, remove: async () => true },
  scripting: { executeScript: async (details) => { if (details?.func) return [{ result: popupMode !== 'inject-missing' }]; document.documentElement.dataset.popupInjected = 'true'; return []; } },
  runtime: {
    async sendMessage(message) {
      if (message?.type === 'sync-media-sites') return { ok: true };
      document.documentElement.dataset.popupSendCount = String(Number(document.documentElement.dataset.popupSendCount || 0) + 1);
      if (popupMode === 'error') throw new Error('测试连接失败');
      return { ok: true, value: { queued: popupMode === 'queued' } };
    },
  },
};
