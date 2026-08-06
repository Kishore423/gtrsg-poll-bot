'use strict';

(function initializeTheme() {
  function renderIcons(root = document) {
    if (!window.lucide?.createIcons) return;
    window.lucide.createIcons({
      attrs: {
        'aria-hidden': 'true',
        'stroke-width': 2,
      },
      root,
    });
  }

  window.refreshIcons = renderIcons;
  document.body.classList.add('ui-ready');
  renderIcons();

  const observer = new MutationObserver((mutations) => {
    const hasNewIcons = mutations.some((mutation) =>
      mutation.type === 'attributes'
        ? mutation.target.matches?.('[data-lucide]:not(svg)') ||
          mutation.target.querySelector?.('[data-lucide]:not(svg)')
        : [...mutation.addedNodes].some((node) =>
          node.nodeType === 1 && (
            node.matches?.('[data-lucide]:not(svg)') ||
            node.querySelector?.('[data-lucide]:not(svg)')
          )
        )
    );
    if (hasNewIcons) renderIcons();
  });
  observer.observe(document.body, {
    attributes: true,
    attributeFilter: ['hidden'],
    childList: true,
    subtree: true,
  });
})();
