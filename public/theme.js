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
      [...mutation.addedNodes].some((node) =>
        node.nodeType === 1 && (
          node.matches?.('[data-lucide]') ||
          node.querySelector?.('[data-lucide]')
        )
      )
    );
    if (hasNewIcons) renderIcons();
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
