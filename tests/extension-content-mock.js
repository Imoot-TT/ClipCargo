window.__captureMessages = [];
window.__extensionStorage = { mediaSites: ['127.0.0.1'] };
const originalAttachShadow = Element.prototype.attachShadow;
Element.prototype.attachShadow = function attachTestShadow(options) {
  return originalAttachShadow.call(this, { ...options, mode: 'open' });
};
window.chrome = {
  runtime: {
    getURL(path) { return `/extension/${path}`; },
    async sendMessage(message) {
      window.__captureMessages.push(structuredClone(message));
      return { ok: true, value: { queued: false } };
    },
  },
  storage: {
    local: {
      async get(key) { return Object.fromEntries((Array.isArray(key) ? key : [key]).map((name) => [name, window.__extensionStorage[name]])); },
      async set(value) { Object.assign(window.__extensionStorage, value); },
    },
  },
};
document.querySelector('#add-card').addEventListener('click', () => {
  const article = document.createElement('article');
  article.innerHTML = '<a class="thumbnail small" href="https://www.youtube.com/watch?v=gamma" aria-label="动态视频 Gamma"><img alt="动态视频 Gamma"></a><h2>动态视频 Gamma</h2>';
  document.querySelector('#grid').append(article);
});
