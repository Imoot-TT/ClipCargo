// Lightweight tooltip behavior for icon buttons and settings help text.
// Event delegation keeps dynamically rendered views working after render().
(function exposeClipCargoTooltip() {
  let tooltip;
  let activeTarget;
  let restoreAria;

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = document.createElement('div');
    tooltip.className = 'clipcargo-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.append(tooltip);
    return tooltip;
  }

  function textFor(target) {
    return target?.dataset.tooltip || target?.getAttribute('title') || '';
  }

  function show(target) {
    const text = textFor(target);
    if (!text || target.hasAttribute('disabled') || target.getAttribute('aria-disabled') === 'true') return;
    const popup = ensureTooltip();
    if (activeTarget !== target) {
      activeTarget = target;
      restoreAria = target.getAttribute('aria-describedby');
    }
    popup.textContent = text;
    popup.hidden = false;
    const targetRect = target.getBoundingClientRect();
    const popupRect = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - popupRect.width - 8, targetRect.left + (targetRect.width - popupRect.width) / 2));
    const top = targetRect.top >= popupRect.height + 10 ? targetRect.top - popupRect.height - 8 : targetRect.bottom + 8;
    popup.style.left = `${left}px`;
    popup.style.top = `${Math.max(8, top)}px`;
    if (!popup.id) popup.id = 'clipcargo-tooltip';
    target.setAttribute('aria-describedby', restoreAria ? `${restoreAria} ${popup.id}` : popup.id);
  }

  function hide(target = activeTarget) {
    if (target && target === activeTarget && restoreAria) target.setAttribute('aria-describedby', restoreAria);
    else if (target && target === activeTarget) target.removeAttribute('aria-describedby');
    if (tooltip) tooltip.hidden = true;
    activeTarget = null;
    restoreAria = null;
  }

  function targetFrom(event) {
    const candidate = event.target instanceof Element ? event.target.closest('[data-tooltip], [title]') : null;
    return candidate && document.body.contains(candidate) ? candidate : null;
  }

  function install(root = document) {
    if (root.__clipCargoTooltipInstalled) return;
    root.__clipCargoTooltipInstalled = true;
    root.addEventListener('pointerover', (event) => {
      const target = targetFrom(event);
      if (target && target !== activeTarget) show(target);
    });
    root.addEventListener('pointerout', (event) => {
      const target = targetFrom(event);
      if (target && !target.contains(event.relatedTarget)) hide(target);
    });
    root.addEventListener('focusin', (event) => {
      const target = targetFrom(event);
      if (target) show(target);
    });
    root.addEventListener('focusout', (event) => {
      const target = targetFrom(event);
      if (target) hide(target);
    });
    window.addEventListener('scroll', () => hide(), true);
    window.addEventListener('resize', () => hide());
  }

  globalThis.ClipCargoTooltip = Object.freeze({ install, show, hide });
})();
