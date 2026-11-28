(function () {
  function render({ eyebrow = '上下文检视器', title = '', subtitle = '', body = '', actions = '', empty = false }) {
    if (empty) {
      return `<aside class="context-inspector is-empty"><div class="inspector-empty"><span class="ui-icon" style="--icon:url('./assets/icons/library.svg')" aria-hidden="true"></span><strong>${title}</strong><p>${subtitle}</p></div></aside>`;
    }
    return `<aside class="context-inspector"><header class="inspector-header"><span>${eyebrow}</span>${title ? `<h2>${title}</h2>` : ''}${subtitle ? `<p>${subtitle}</p>` : ''}</header><div class="inspector-scroll">${body}</div>${actions ? `<footer class="inspector-actions">${actions}</footer>` : ''}</aside>`;
  }
  window.ClipCargoInspector = { render };
})();
