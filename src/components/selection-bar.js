(function () {
  function render({ count, label = '已选', allChecked = false, selectAttribute = 'data-select-visible', actions = '' }) {
    if (!count) return '';
    return `<div class="phase2-selection-bar" role="region" aria-label="批量操作">
      <label class="selection-summary"><input type="checkbox" ${selectAttribute} ${allChecked ? 'checked' : ''}><strong>${label} ${count}</strong></label>
      <div class="phase2-selection-actions">${actions}</div>
    </div>`;
  }
  window.ClipCargoSelectionBar = { render };
})();
