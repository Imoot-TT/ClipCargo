window.__captureMessages = [];
window.__extensionStorage = { mediaSites: [], disabledMediaSites: [] };
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function attachTestShadow(options) {
  return originalAttachShadow.call(this, { ...options, mode: 'open' });
};
window.chrome = {
  runtime: {
    getURL(path) { return `/extension/${path}`; },
    async sendMessage(message) { window.__captureMessages.push(structuredClone(message)); return { ok: true, value: { queued: false } }; },
  },
  storage: {
    local: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, window.__extensionStorage[name]])); },
      async set(value) { Object.assign(window.__extensionStorage, value); },
    },
  },
};
