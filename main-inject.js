(function () {
  if (window._maxExportInterceptorInstalled) return;
  window._maxExportInterceptorInstalled = true;

  // Patch clipboard.writeText: for max.ru/ URLs, capture via postMessage
  // and skip actual write (avoids focus errors). Used by link collection
  // (context menu "Copy link to post").
  try {
    const _origWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = function(text) {
      // Only intercept during active export link collection; otherwise pass
      // through so manual "Copy link to post" still writes to the clipboard.
      // The flag is read from the DOM (data attribute) because this script runs
      // in the MAIN world while content.js sets it from the isolated world —
      // they don't share window properties.
      const capturing = document.documentElement.getAttribute('data-max-export-capturing') === '1';
      if (capturing && typeof text === 'string' && text.indexOf('max.ru/') >= 0) {
        try { window.postMessage({ type: 'MAX_EXPORT_CAPTURED_LINK', link: text }, '*'); } catch(e) {}
        return Promise.resolve();
      }
      return _origWriteText(text);
    };
  } catch(e) {}

  // ---- URL slug capture ----
  // The SPA replaces slug URLs (/nauka_tass) with numeric IDs (/-69242250524144).
  // Capture the slug at document_start (before SPA) and via History API interception,
  // then store a chId→slug mapping in sessionStorage so it survives page reloads.
  let _pendingSlug = null;
  function _captureUrlSlug() {
    const path = location.pathname;
    const slugM = path.match(/^\/([a-zA-Z][a-zA-Z0-9_]{2,30})(?:$|[/?#])/);
    const idM = path.match(/^\/(-?\d+)/);
    if (slugM && !idM) {
      _pendingSlug = slugM[1];
    }
    if (idM) {
      if (_pendingSlug) {
        try {
          const map = JSON.parse(sessionStorage.getItem('_maxExportSlugMap') || '{}');
          map[idM[1]] = _pendingSlug;
          sessionStorage.setItem('_maxExportSlugMap', JSON.stringify(map));
        } catch(e) {}
        _pendingSlug = null;
      }
    }
  }
  _captureUrlSlug();
  const _origPushState = history.pushState;
  const _origReplaceState = history.replaceState;
  history.pushState = function() { const r = _origPushState.apply(this, arguments); _captureUrlSlug(); return r; };
  history.replaceState = function() { const r = _origReplaceState.apply(this, arguments); _captureUrlSlug(); return r; };
  window.addEventListener('popstate', _captureUrlSlug);
})();
