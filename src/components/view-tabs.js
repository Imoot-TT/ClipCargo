(function () {
  function render(items, active, attribute, label) {
    return `<div class="view-tabs" role="tablist" aria-label="${label}">${items.map((item) => {
      const selected = item.id === active;
      return `<button class="view-tab ${selected ? 'active' : ''}" type="button" role="tab" aria-selected="${selected}" tabindex="${selected ? '0' : '-1'}" data-${attribute}="${item.id}"><span>${item.label}</span>${item.count == null ? '' : `<b>${item.count}</b>`}</button>`;
    }).join('')}</div>`;
  }
  window.ClipCargoViewTabs = { render };
})();
