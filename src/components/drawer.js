(function () {
  let returnFocus = null;

  function ensureShell() {
    let backdrop = document.querySelector('#workspace-drawer');
    if (backdrop) return backdrop;
    backdrop = document.createElement('div');
    backdrop.id = 'workspace-drawer';
    backdrop.className = 'workspace-drawer-backdrop';
    backdrop.hidden = true;
    backdrop.innerHTML = '<aside class="workspace-drawer" role="dialog" aria-modal="true"><header class="workspace-drawer-header"><div><span id="workspace-drawer-eyebrow"></span><h2 id="workspace-drawer-title"></h2></div><button class="icon-button" type="button" data-drawer-close aria-label="关闭抽屉"><span class="ui-icon" style="--icon:url(\'./assets/icons/x.svg\')"></span></button></header><div id="workspace-drawer-content" class="workspace-drawer-content"></div></aside>';
    document.body.appendChild(backdrop);
    backdrop.addEventListener('mousedown', (event) => {
      if (event.target === backdrop) close();
    });
    backdrop.addEventListener('click', (event) => {
      if (event.target.closest('[data-drawer-close]')) close();
    });
    return backdrop;
  }

  function open({ type, title, eyebrow = '快速操作', content, focusSelector, draft = {}, payload = null }) {
    const backdrop = ensureShell();
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    window.ClipCargoWorkspace?.openDrawer(type, draft, payload);
    backdrop.querySelector('#workspace-drawer-eyebrow').textContent = eyebrow;
    backdrop.querySelector('#workspace-drawer-title').textContent = title;
    backdrop.querySelector('#workspace-drawer-content').innerHTML = content;
    backdrop.hidden = false;
    requestAnimationFrame(() => {
      backdrop.classList.add('open');
      const focus = focusSelector ? backdrop.querySelector(focusSelector) : backdrop.querySelector('input, textarea, button');
      focus?.focus();
    });
  }

  function close({ force = false } = {}) {
    const backdrop = ensureShell();
    if (!force && backdrop.querySelector('[aria-busy="true"]')) return false;
    backdrop.classList.remove('open');
    setTimeout(() => { backdrop.hidden = true; }, 180);
    window.ClipCargoWorkspace?.closeDrawer();
    returnFocus?.focus?.({ preventScroll: true });
    returnFocus = null;
    return true;
  }

  function isOpen(type = null) {
    const drawer = window.ClipCargoWorkspace?.ui.drawer;
    return Boolean(drawer?.open && (!type || drawer.type === type));
  }

  window.ClipCargoDrawer = { ensureShell, open, close, isOpen };
})();
