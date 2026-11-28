(function () {
  function render({ title, message, detail = '', cancelAction, primaryAction, primaryLabel, secondaryAction = '', secondaryLabel = '' }) {
    return `<section class="inline-confirm-panel" data-confirm-persistent="true" role="alertdialog" aria-label="${title}">
      <div><strong>${title}</strong><p>${message}</p>${detail ? `<small>${detail}</small>` : ''}</div>
      <div class="inline-confirm-actions"><button class="button compact" data-action="${cancelAction}">取消</button>${secondaryAction ? `<button class="button compact" data-action="${secondaryAction}">${secondaryLabel}</button>` : ''}<button class="button compact danger" data-action="${primaryAction}">${primaryLabel}</button></div>
    </section>`;
  }
  window.ClipCargoConfirmPanel = { render };
})();
